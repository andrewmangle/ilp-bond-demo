// Payments on the Rhyza rail. Same exports and the same flow as the Rafiki rail's payments.js:
//   1. payment intent on the receiver's node (POST /payment-intents, amountless, 10 min expiry, metadata)
//   2. quote on the sender's node for the intent's Open Payments URL, fixing debitAmount or receiveAmount
//   3. payment on the sender's node for that quote (POST /payments); the playground's ase-mock-service approves
//      it on the paymentCreated webhook
//   4. poll the payment until it is final
//   5. complete the intent on the receiver's node and book both sides in the app's ledger
// The sender's debit is held out of their balance when the payment is created (as the Rafiki mock bank did on
// outgoing_payment.created); at settlement the sender keeps whatever wasn't sent and the receiver is credited
// what the intent received. Holdings and coupons hang off onSettled exactly as on the Rafiki rail.

const { admin, appState, toScale, SCALE } = require('./rhyza')
const bank = require('./mock-bank')
const { db, now } = require('../../db')
const { UserError, formatAmount } = require('../../money')

const INTENT_TTL_MS = 10 * 60 * 1000
const APP = 'university-payments'

// Rhyza bug at the pinned commit: the ledger's amountToBigIntOfSize (pal-domain-lib liquidity/utils.ts) rejects
// any amount with fewer digits than its scale, so 0.01 to 0.09 at scale 2 throws LedgerPrecisionLossError. The
// exception is uncaught: the ledger command handler exits, the payment stays PROCESSING for good and the node's
// ledger can stop processing other payments. So the app never sends less than 10^(scale-1) minor units (0.10).
// Coupons below that are carried to the next date (the line shows as failed with this reason; nothing is lost).
const MIN_MINOR = BigInt(10) ** BigInt(SCALE - 1)
const tooSmall = (value) => BigInt(value) < MIN_MINOR
const TOO_SMALL = `Rhyza (alpha) cannot move less than ${(Number(MIN_MINOR) / 10 ** SCALE).toFixed(SCALE)} yet (ledger bug); carried to the next date`

const pendingQuotes = new Map() // quote id -> what pay() needs
const awaiting = new Set() // payments a request in this process is waiting on

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const FINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED']
const parse = (json) => (json ? JSON.parse(json) : null)

function describeRate(debitAmount, receiveAmount) {
  if (debitAmount.assetCode === receiveAmount.assetCode) return null
  const rate = Number(receiveAmount.value) / 10 ** receiveAmount.assetScale / (Number(debitAmount.value) / 10 ** debitAmount.assetScale)
  return `1 ${debitAmount.assetCode} ≈ ${rate.toFixed(4)} ${receiveAmount.assetCode}`
}

const party = (account) => ({ name: account.name, nodeLabel: account.nodeLabel, walletAddress: account.walletAddress })

const metadataFor = (type, sender, receiver) => ({
  app: APP,
  type,
  fromName: sender.name,
  fromWallet: sender.walletAddress,
  toName: receiver.name,
  toWallet: receiver.walletAddress
})

// Steps 1 and 2. Returns the quote in the app's shape (amounts as { value, assetCode, assetScale }).
async function intentAndQuote({ sender, receiver, metadata, debitAmount, receiveAmount }) {
  const intent = await admin(receiver.node).createPaymentIntent(receiver.walletAddress, undefined, metadata, {
    expiresAt: new Date(Date.now() + INTENT_TTL_MS).toISOString()
  })
  if (!intent.openPaymentsUrl) throw new Error('Rhyza returned a payment intent without an openPaymentsUrl')
  const q = await admin(sender.node).createQuote(sender.walletAddress, intent.openPaymentsUrl, {
    debitAmount: debitAmount?.value,
    receiveAmount: receiveAmount?.value
  })
  if (q.state && q.state !== 'COMPLETED') throw new Error(`the quote is ${q.state}${q.message ? `: ${q.message}` : ''}`)
  return {
    intent,
    quote: {
      id: q.id,
      senderIntentId: q.paymentIntentId,
      expiresAt: q.expiresAt ?? intent.expiresAt ?? new Date(Date.now() + INTENT_TTL_MS).toISOString(),
      exchangeRate: q.exchangeRate ?? null,
      debitAmount: { value: String(q.debitAmount), assetCode: sender.assetCode, assetScale: SCALE },
      receiveAmount: { value: String(q.receiveAmount), assetCode: receiver.assetCode, assetScale: SCALE }
    }
  }
}

// Fix either debitAmount (sender pays this) or receiveAmount (receiver gets this)
async function quote({ type, sender, receiver, debitAmount, receiveAmount, details = null }) {
  if (sender.walletAddress === receiver.walletAddress) throw new UserError('Sender and receiver must be different accounts')
  if (debitAmount && BigInt(debitAmount.value) > BigInt(sender.balance)) {
    throw new UserError(`${sender.name} only has ${formatAmount({ ...sender, value: sender.balance })}`)
  }
  const minimum = `${(Number(MIN_MINOR) / 10 ** SCALE).toFixed(SCALE)}`
  if ((debitAmount && tooSmall(debitAmount.value)) || (receiveAmount && tooSmall(receiveAmount.value))) {
    throw new UserError(`On the Rhyza rail the smallest payment is ${minimum} (a Rhyza alpha ledger bug)`)
  }
  const metadata = metadataFor(type, sender, receiver)
  let made
  try {
    made = await intentAndQuote({ sender, receiver, metadata, debitAmount, receiveAmount })
  } catch (err) {
    throw new UserError(`Rhyza could not quote this payment: ${err.message}`)
  }
  const { intent, quote: q } = made
  if (tooSmall(q.debitAmount.value) || tooSmall(q.receiveAmount.value)) {
    throw new UserError(`On the Rhyza rail the smallest payment is ${minimum} (a Rhyza alpha ledger bug)`)
  }
  if (BigInt(q.debitAmount.value) > BigInt(sender.balance)) {
    throw new UserError(`${sender.name} needs ${formatAmount(q.debitAmount)} but only has ${formatAmount({ ...sender, value: sender.balance })}`)
  }
  pendingQuotes.set(q.id, { type, details, metadata, sender, receiver, incomingPaymentUrl: intent.openPaymentsUrl, receiverIntentId: intent.id, quote: q })
  return {
    quoteId: q.id,
    type,
    expiresAt: q.expiresAt,
    sender: party(sender),
    receiver: party(receiver),
    debitAmount: q.debitAmount,
    receiveAmount: q.receiveAmount,
    minReceiveAmount: q.receiveAmount, // Rhyza delivers the quoted amount or fails
    rate: describeRate(q.debitAmount, q.receiveAmount)
  }
}

function getPendingQuote(quoteId) {
  const pending = pendingQuotes.get(quoteId)
  if (!pending) throw new UserError('Quote not found or already used. Get a new quote.')
  if (new Date(pending.quote.expiresAt) < new Date()) {
    pendingQuotes.delete(quoteId)
    throw new UserError('This quote has expired. Get a new quote.')
  }
  return pending
}

function listPendingQuotes(type) {
  const live = []
  for (const [quoteId, pending] of pendingQuotes) {
    if (new Date(pending.quote.expiresAt) < new Date()) pendingQuotes.delete(quoteId)
    else if (pending.type === type) live.push({ quoteId, ...pending })
  }
  return live
}

const cancelQuote = (quoteId) => pendingQuotes.delete(quoteId)
const clearPendingQuotes = () => pendingQuotes.clear()

const settledHandlers = {}
function onSettled(type, handler) {
  settledHandlers[type] = handler
}

// The payment as the app reads it: state in app terms, amounts at scale 2
async function getPayment(paymentId) {
  const rp = db.prepare('SELECT * FROM rhyza_payments WHERE id = ?').get(paymentId)
  if (!rp) return null
  const p = await admin(rp.sender_node).getPayment(rp.sender_intent_id, paymentId)
  return {
    id: p.id,
    rhyzaState: p.state,
    state: appState(p.state),
    error: p.failReason ?? null,
    sentAmount: toScale(p.sentAmount),
    debitAmount: toScale(p.debitAmount),
    receiveAmount: toScale(p.receiveAmount)
  }
}

// Step 3: holds the debit, creates the payment and records it. Returns the payment id, or null when the
// sender's balance is short (the FSP refuses it, like the Rafiki mock bank cancelling for lack of funds).
async function createPayment({ type, details, metadata, sender, receiver, incomingPaymentUrl, receiverIntentId, quote: q }) {
  if (!bank.hold(sender.id, q.debitAmount.value)) return null
  let created
  try {
    created = await admin(sender.node).createPayment(sender.walletAddress, q.senderIntentId, q.id, metadata)
  } catch (err) {
    bank.adjust(sender.id, q.debitAmount.value) // nothing was sent: release the hold
    throw err
  }
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO payments (id, type, quote_id, incoming_payment_url, sender_node, sender_account, sender_name,
        sender_wallet, receiver_node, receiver_account, receiver_name, receiver_wallet, quoted_debit, quoted_receive,
        state, created_at, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENDING', ?, ?)`
    ).run(
      created.id, type, q.id, incomingPaymentUrl,
      sender.node, sender.id, sender.name, sender.walletAddress,
      receiver.node, receiver.id, receiver.name, receiver.walletAddress,
      JSON.stringify(q.debitAmount), JSON.stringify(q.receiveAmount), now(), details ? JSON.stringify(details) : null
    )
    db.prepare(`INSERT INTO rhyza_payments (id, sender_node, sender_intent_id, receiver_node, receiver_intent_id, hold) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(created.id, sender.node, created.paymentIntentId ?? q.senderIntentId, receiver.node, receiverIntentId, q.debitAmount.value)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return created.id
}

// Step 4: up to 30 s, then settleSending() finishes it in the background
async function waitAndSettle(paymentId) {
  let payment
  awaiting.add(paymentId)
  try {
    for (let i = 0; i < 60; i++) {
      payment = await getPayment(paymentId)
      if (FINAL_STATES.includes(payment.state)) break
      await sleep(500)
    }
    if (FINAL_STATES.includes(payment.state)) return (await settle(paymentId, payment)) ?? (await settledElsewhere(paymentId))
  } finally {
    awaiting.delete(paymentId)
  }
  return {
    ...resultOf(db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)),
    state: payment.state,
    error: payment.error,
    sent: payment.sentAmount,
    retrying: true
  }
}

async function pay(quoteId) {
  const pending = getPendingQuote(quoteId)
  pendingQuotes.delete(quoteId)
  const sender = await bank.findAccount(pending.sender.node, pending.sender.id)
  const receiver = await bank.findAccount(pending.receiver.node, pending.receiver.id)
  let paymentId
  try {
    paymentId = await createPayment({ ...pending, sender, receiver })
  } catch (err) {
    throw new UserError(`Rhyza did not accept the payment: ${err.message}`)
  }
  if (!paymentId) {
    throw new UserError(`${sender.name} needs ${formatAmount(pending.quote.debitAmount)} but only has ${formatAmount({ ...sender, value: sender.balance })}`)
  }
  return waitAndSettle(paymentId)
}

const resultOf = (row) => ({
  id: row.id,
  type: row.type,
  details: parse(row.details),
  state: row.state,
  error: row.error,
  sender: { name: row.sender_name, walletAddress: row.sender_wallet },
  receiver: { name: row.receiver_name, walletAddress: row.receiver_wallet },
  sent: parse(row.sent),
  received: parse(row.received),
  retrying: false
})

// Step 5, once per payment (claimed in the database): complete the receiver's intent, book the ledger, record
// the outcome and run the type's settled handler. Returns null if another caller already claimed it.
async function settle(paymentId, payment) {
  const claimed = db.prepare(`UPDATE payments SET state = 'SETTLING' WHERE id = ? AND state = 'SENDING'`).run(paymentId)
  if (claimed.changes === 0) return null
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)
  const rp = db.prepare('SELECT * FROM rhyza_payments WHERE id = ?').get(paymentId)

  let received = null
  try {
    if (BigInt(payment.sentAmount?.value ?? 0) > BigInt(0)) {
      const receiverAdmin = admin(rp.receiver_node)
      let intent = await receiverAdmin.getPaymentIntent(rp.receiver_intent_id)
      if (intent.state !== 'COMPLETED') {
        await receiverAdmin.completePaymentIntent(rp.receiver_intent_id).catch((err) => {
          if (err.status !== 409) throw err // 409: already completed or expired
        })
        intent = await receiverAdmin.getPaymentIntent(rp.receiver_intent_id)
      }
      received = toScale(intent.receivedAmount)
    }
  } catch (err) {
    db.prepare(`UPDATE payments SET state = 'SENDING' WHERE id = ?`).run(paymentId) // let settleSending retry
    throw err
  }

  db.exec('BEGIN')
  try {
    const sent = BigInt(payment.sentAmount?.value ?? 0)
    bank.adjust(row.sender_account, BigInt(rp.hold) - sent) // the sender keeps what wasn't sent
    if (received && received.value !== '0') bank.adjust(row.receiver_account, received.value)
    db.prepare(`UPDATE payments SET state = ?, error = ?, sent = ?, received = ?, completed_at = ? WHERE id = ?`).run(
      payment.state, payment.error ?? null, JSON.stringify(payment.sentAmount), received ? JSON.stringify(received) : null, now(), paymentId
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    db.prepare(`UPDATE payments SET state = 'SENDING' WHERE id = ?`).run(paymentId)
    throw err
  }
  const settledRow = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)
  const result = { ...resultOf(settledRow), creditedByBank: true }
  const handler = settledHandlers[settledRow.type]
  if (handler) result.outcome = await handler(settledRow, result)
  return result
}

async function settledElsewhere(paymentId) {
  for (let i = 0; i < 120; i++) {
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)
    if (FINAL_STATES.includes(row.state)) return { ...resultOf(row), creditedByBank: true }
    await sleep(250)
  }
  throw new Error(`Payment ${paymentId} is taking too long to settle`)
}

// Payments still sending when the request stopped waiting
async function settleSending() {
  for (const row of db.prepare(`SELECT id FROM payments WHERE state = 'SENDING'`).all()) {
    if (awaiting.has(row.id)) continue
    const payment = await getPayment(row.id)
    if (payment && FINAL_STATES.includes(payment.state)) {
      const result = await settle(row.id, payment)
      if (result) console.log(`Settled payment ${row.id} (${result.type}): ${result.state}`)
    }
  }
}

// A payment the app makes on the sender's behalf (coupons, principal, recurring purchases). On the Rafiki rail
// it goes through Open Payments under the sender's grant. Grants on Rhyza are Phase 4: until then the app pays
// through the Admin API, the grant is recorded but its limits are not enforced by Rhyza. `check(quote)` may
// return a reason not to pay; a short balance comes back CANCELLED, as the Rafiki mock bank cancels it.
async function payUnderGrant({ type, grant, sender, receiver, receiveAmount, details, check }) {
  if (tooSmall(receiveAmount.value)) return { state: 'NOT_CREATED', error: TOO_SMALL, quote: null }
  const metadata = metadataFor(type, sender, receiver)
  let made
  try {
    made = await intentAndQuote({ sender, receiver, metadata, receiveAmount })
  } catch (err) {
    return { state: 'NOT_CREATED', error: err.message, quote: null }
  }
  const { intent, quote: q } = made
  if (tooSmall(q.debitAmount.value)) return { state: 'NOT_CREATED', error: TOO_SMALL, quote: q }
  const skip = check ? await check(q) : null
  if (skip) return { state: 'SKIPPED', reason: skip, quote: q }

  const fresh = await bank.findAccount(sender.node, sender.id)
  let paymentId
  try {
    paymentId = await createPayment({
      type, metadata, sender: fresh, receiver, incomingPaymentUrl: intent.openPaymentsUrl, receiverIntentId: intent.id, quote: q,
      details: { ...details, grantId: grant?.id ?? null }
    })
  } catch (err) {
    return { state: 'NOT_CREATED', error: err.message, quote: q }
  }
  if (!paymentId) return { state: 'CANCELLED', error: 'Account does not have enough balance', quote: q, debit: q.debitAmount, sent: { ...q.debitAmount, value: '0' } }
  const result = await waitAndSettle(paymentId)
  return { ...result, debit: q.debitAmount }
}

async function quoteAndPay(options) {
  const { quoteId } = await quote(options)
  return pay(quoteId)
}

module.exports = { clearPendingQuotes, quote, getPendingQuote, listPendingQuotes, cancelQuote, onSettled, pay, payUnderGrant, settleSending, quoteAndPay, getPayment }
