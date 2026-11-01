// Open Payments flow through the sender's Rafiki admin API: incoming payment on the receiver's wallet address
// (createReceiver), quote, then outgoing payment. Balances only move through the mock banks' webhook handlers.
//
// What a quote fixes when a central bank changes its rate before the payment is confirmed: the outgoing
// payment pays the quote the user saw, so the sender is charged the quoted amount. The receiving node converts
// the incoming USD at its current rate as the money arrives, so the receiver gets the amount at the new rate,
// and Rafiki fails the payment rather than deliver below the quote's minimum rate (quote rate less 1%
// slippage). Capping the incoming payment at the quoted amount doesn't change that: Rafiki accepts more.
//
// The incoming payment is created without an amount. Once the outgoing payment finishes, completeReceiver
// closes it, so the receiving mock bank credits exactly what arrived on incoming_payment.completed instead of
// waiting for it to expire. (A fixed-amount incoming payment can be left open for 30 days when per-hop
// rounding delivers a cent short, so the receiver would never be credited.)

const { randomUUID } = require('crypto')
const { adminApi, AMOUNT } = require('./admin-api')
const { findAccount } = require('./mock-bank')
const openPayments = require('./open-payments')
const { db, now } = require('./db')
const { UserError, formatAmount } = require('./money')

// Long enough to read the quote and confirm; Rafiki caps the quote's expiry at the incoming payment's
const INCOMING_PAYMENT_TTL_MS = 10 * 60 * 1000
const SLIPPAGE = 0.01 // the backends' SLIPPAGE default
const APP = 'university-payments'

// Quotes waiting for confirmation, keyed by quote id
const pendingQuotes = new Map()
// Payments a request in this process is waiting on: settleSending() leaves those to the request
const awaiting = new Set()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const FINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED']

function describeRate(debitAmount, receiveAmount) {
  if (debitAmount.assetCode === receiveAmount.assetCode) return null
  const rate =
    Number(receiveAmount.value) / 10 ** receiveAmount.assetScale /
    (Number(debitAmount.value) / 10 ** debitAmount.assetScale)
  return `1 ${debitAmount.assetCode} ≈ ${rate.toFixed(4)} ${receiveAmount.assetCode}`
}

const party = (account) => ({ name: account.name, nodeLabel: account.nodeLabel, walletAddress: account.walletAddress })

// Fix either debitAmount (sender pays this, fees included) or receiveAmount (receiver gets this)
// `details` is kept with the payment record, e.g. which bond a purchase is for
async function quote({ type, sender, receiver, debitAmount, receiveAmount, details = null }) {
  if (sender.walletAddress === receiver.walletAddress) {
    throw new UserError('Sender and receiver must be different accounts')
  }
  if (debitAmount && BigInt(debitAmount.value) > BigInt(sender.balance)) {
    throw new UserError(`${sender.name} only has ${formatAmount({ ...sender, value: sender.balance })}`)
  }
  const metadata = {
    app: APP,
    type,
    fromName: sender.name,
    fromWallet: sender.walletAddress,
    toName: receiver.name,
    toWallet: receiver.walletAddress
  }

  const { createReceiver } = await adminApi(
    sender.node,
    `mutation($input: CreateReceiverInput!) { createReceiver(input: $input) { receiver { id } } }`,
    {
      input: {
        walletAddressUrl: receiver.walletAddress,
        expiresAt: new Date(Date.now() + INCOMING_PAYMENT_TTL_MS).toISOString(),
        metadata,
        idempotencyKey: randomUUID()
      }
    }
  )
  const incomingPaymentUrl = createReceiver.receiver.id

  let created
  try {
    ;({ createQuote: created } = await adminApi(
      sender.node,
      `mutation($input: CreateQuoteInput!) { createQuote(input: $input) { quote {
        id expiresAt debitAmount { ${AMOUNT} } receiveAmount { ${AMOUNT} } } } }`,
      {
        input: {
          walletAddressId: sender.walletAddressId,
          receiver: incomingPaymentUrl,
          debitAmount,
          receiveAmount,
          idempotencyKey: randomUUID()
        }
      }
    ))
  } catch (err) {
    throw new UserError(`Rafiki could not quote this payment: ${err.message}`)
  }
  const { quote } = created
  if (BigInt(quote.debitAmount.value) > BigInt(sender.balance)) {
    throw new UserError(
      `${sender.name} needs ${formatAmount(quote.debitAmount)} including fees but only has ${formatAmount({ ...sender, value: sender.balance })}`
    )
  }

  pendingQuotes.set(quote.id, { type, details, metadata, sender, receiver, incomingPaymentUrl, quote })

  return {
    quoteId: quote.id,
    type,
    expiresAt: quote.expiresAt,
    sender: party(sender),
    receiver: party(receiver),
    debitAmount: quote.debitAmount,
    receiveAmount: quote.receiveAmount,
    // Below this Rafiki fails the payment instead of delivering
    minReceiveAmount: {
      ...quote.receiveAmount,
      value: Math.floor(Number(quote.receiveAmount.value) * (1 - SLIPPAGE)).toString()
    },
    rate: describeRate(quote.debitAmount, quote.receiveAmount)
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

// Quotes not yet confirmed, e.g. so a bond can count them against what is left to sell
function listPendingQuotes(type) {
  const live = []
  for (const [quoteId, pending] of pendingQuotes) {
    if (new Date(pending.quote.expiresAt) < new Date()) pendingQuotes.delete(quoteId)
    else if (pending.type === type) live.push({ quoteId, ...pending })
  }
  return live
}

function cancelQuote(quoteId) {
  pendingQuotes.delete(quoteId)
}

function clearPendingQuotes() {
  pendingQuotes.clear()
}

// Called once per payment when it reaches a final state, e.g. to record a bond holding. By payment type.
const settledHandlers = {}
function onSettled(type, handler) {
  settledHandlers[type] = handler
}

async function getOutgoingPayment(nodeKey, id) {
  const { outgoingPayment } = await adminApi(
    nodeKey,
    `query($id: String!) { outgoingPayment(id: $id) { id state error stateAttempts metadata sentAmount { ${AMOUNT} } } }`,
    { id }
  )
  return outgoingPayment
}

async function pay(quoteId) {
  const pending = getPendingQuote(quoteId)
  pendingQuotes.delete(quoteId)
  const { type, details, metadata, incomingPaymentUrl, quote } = pending

  const sender = await findAccount(pending.sender.node, pending.sender.id)
  const receiver = await findAccount(pending.receiver.node, pending.receiver.id)
  if (BigInt(quote.debitAmount.value) > BigInt(sender.balance)) {
    throw new UserError(
      `${sender.name} needs ${formatAmount(quote.debitAmount)} including fees but only has ${formatAmount({ ...sender, value: sender.balance })}`
    )
  }

  let createOutgoingPayment
  try {
    ;({ createOutgoingPayment } = await adminApi(
      sender.node,
      `mutation($input: CreateOutgoingPaymentInput!) { createOutgoingPayment(input: $input) { payment { id createdAt } } }`,
      { input: { walletAddressId: sender.walletAddressId, quoteId, metadata, idempotencyKey: randomUUID() } }
    ))
  } catch (err) {
    throw new UserError(`Rafiki did not accept the payment: ${err.message}`)
  }
  const paymentId = createOutgoingPayment.payment.id

  db.prepare(
    `INSERT INTO payments (id, type, quote_id, incoming_payment_url, sender_node, sender_account, sender_name,
      sender_wallet, receiver_node, receiver_account, receiver_name, receiver_wallet, quoted_debit, quoted_receive,
      state, created_at, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENDING', ?, ?)`
  ).run(
    paymentId, type, quoteId, incomingPaymentUrl,
    sender.node, sender.id, sender.name, sender.walletAddress,
    receiver.node, receiver.id, receiver.name, receiver.walletAddress,
    JSON.stringify(quote.debitAmount), JSON.stringify(quote.receiveAmount),
    createOutgoingPayment.payment.createdAt ?? now(), details ? JSON.stringify(details) : null
  )

  // The sender's mock bank funds the payment on outgoing_payment.created; wait for Rafiki to finish sending.
  // A retryable error (e.g. the rate is now below the quote's minimum) keeps it in SENDING while Rafiki retries
  // with a growing backoff, up to MAX_OUTGOING_PAYMENT_RETRY_ATTEMPTS (5, about 2.5 minutes) before FAILED.
  let payment
  awaiting.add(paymentId)
  try {
    for (let i = 0; i < 60; i++) {
      payment = await getOutgoingPayment(sender.node, paymentId)
      if (FINAL_STATES.includes(payment.state)) break
      await sleep(500)
    }
    if (FINAL_STATES.includes(payment.state)) {
      return (await settle(paymentId, payment, receiver.balance)) ?? (await settledElsewhere(paymentId))
    }
  } finally {
    awaiting.delete(paymentId)
  }

  // Still sending: settleSending() finishes it in the background
  return {
    ...resultOf(db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)),
    state: payment.state,
    error: payment.error,
    sent: payment.sentAmount,
    retrying: payment.stateAttempts > 0
  }
}

const parse = (json) => (json ? JSON.parse(json) : null)
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

// Finishes a payment that Rafiki has finished: closes the incoming payment so the receiving mock bank credits
// what arrived, records the outcome and runs the type's settled handler. Runs once per payment (claimed in the
// database), so pay() and settleSending() can't both settle it. Returns null if it was already claimed.
async function settle(paymentId, payment, receiverBalanceBefore) {
  const claimed = db.prepare(`UPDATE payments SET state = 'SETTLING' WHERE id = ? AND state = 'SENDING'`).run(paymentId)
  if (claimed.changes === 0) return null
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)

  let received = null
  let creditedByBank = true
  try {
    if (BigInt(payment.sentAmount.value) > BigInt(0)) {
      const { receiver: incoming } = await adminApi(
        row.sender_node,
        `query($id: String!) { receiver(id: $id) { completed receivedAmount { ${AMOUNT} } } }`,
        { id: row.incoming_payment_url }
      )
      received = incoming.receivedAmount
      if (!incoming.completed) {
        const { completeReceiver } = await adminApi(
          row.sender_node,
          `mutation($input: CompleteReceiverInput!) { completeReceiver(input: $input) { receiver { receivedAmount { ${AMOUNT} } } } }`,
          { input: { incomingPaymentUrl: row.incoming_payment_url } }
        )
        received = completeReceiver.receiver.receivedAmount
      }
    }

    // Wait briefly until the receiving bank has booked it (the webhook is usually there within a second). Only for
    // reporting: the receiver's balance can also be moving for other reasons (an issuer paying coupons), so this
    // gives up after a few seconds rather than hold the payment up.
    if (received && received.value !== '0' && receiverBalanceBefore !== undefined) {
      creditedByBank = false
      for (let i = 0; !creditedByBank && i < 10; i++) {
        const after = await findAccount(row.receiver_node, row.receiver_account)
        creditedByBank = BigInt(after.balance) - BigInt(receiverBalanceBefore) >= BigInt(received.value)
        if (!creditedByBank) await sleep(500)
      }
    }
  } catch (err) {
    db.prepare(`UPDATE payments SET state = 'SENDING' WHERE id = ?`).run(paymentId) // let settleSending retry
    throw err
  }

  db.prepare(`UPDATE payments SET state = ?, error = ?, sent = ?, received = ?, completed_at = ? WHERE id = ?`).run(
    payment.state,
    payment.error ?? payment.metadata?.cancellationReason ?? null,
    JSON.stringify(payment.sentAmount),
    received ? JSON.stringify(received) : null,
    now(),
    paymentId
  )
  const settledRow = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)
  const result = { ...resultOf(settledRow), creditedByBank }
  const handler = settledHandlers[settledRow.type]
  if (handler) result.outcome = await handler(settledRow, result)
  return result
}

// settleSending() claimed the payment first: wait for it to finish recording the outcome
async function settledElsewhere(paymentId) {
  for (let i = 0; i < 120; i++) {
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)
    if (FINAL_STATES.includes(row.state)) return { ...resultOf(row), creditedByBank: true }
    await sleep(250)
  }
  throw new Error(`Payment ${paymentId} is taking too long to settle`)
}

// Payments that were still sending when pay() stopped waiting (Rafiki retrying)
async function settleSending() {
  for (const row of db.prepare(`SELECT id, sender_node FROM payments WHERE state = 'SENDING'`).all()) {
    if (awaiting.has(row.id)) continue
    const payment = await getOutgoingPayment(row.sender_node, row.id)
    if (payment && FINAL_STATES.includes(payment.state)) {
      const result = await settle(row.id, payment)
      if (result) console.log(`Settled payment ${row.id} (${result.type}): ${result.state}`)
    }
  }
}

// A payment the demo app makes as an Open Payments client under the sender's grant (coupons and principal):
// incoming payment on the receiver's wallet address (admin API on the sender's node), then the quote and the
// outgoing payment on the sender's resource server with the grant's access token, so Rafiki checks them
// against the grant's limits. The quote fixes what the receiver gets, in whole units of their currency.
// `check(quote)` may return a reason not to pay (e.g. the quote is over the grant's limit): then no outgoing
// payment is created and the result is { state: 'SKIPPED', reason, quote }.
async function payUnderGrant({ type, grant, sender, receiver, receiveAmount, details, check }) {
  const metadata = {
    app: APP,
    type,
    fromName: sender.name,
    fromWallet: sender.walletAddress,
    toName: receiver.name,
    toWallet: receiver.walletAddress
  }
  const { createReceiver } = await adminApi(
    sender.node,
    `mutation($input: CreateReceiverInput!) { createReceiver(input: $input) { receiver { id } } }`,
    {
      input: {
        walletAddressUrl: receiver.walletAddress,
        expiresAt: new Date(Date.now() + INCOMING_PAYMENT_TTL_MS).toISOString(),
        metadata,
        idempotencyKey: randomUUID()
      }
    }
  )
  const incomingPaymentUrl = createReceiver.receiver.id

  let quote, created
  try {
    quote = await openPayments.createQuote(grant.resourceServer, grant.accessToken, {
      walletAddress: sender.walletAddress,
      receiver: incomingPaymentUrl,
      method: 'ilp',
      receiveAmount
    })
    const skip = check ? await check(quote) : null
    if (skip) return { state: 'SKIPPED', reason: skip, quote }
    created = await openPayments.createOutgoingPayment(grant.resourceServer, grant.accessToken, {
      walletAddress: sender.walletAddress,
      quoteId: quote.id,
      metadata
    })
  } catch (err) {
    // Rafiki refuses an outgoing payment beyond the grant's limits (for the current interval) with a 403
    const error = quote && err.status === 403 ? `over the grant’s limit for this period (${err.message})` : err.message
    return { state: 'NOT_CREATED', error, quote: quote ?? null }
  }
  const paymentId = created.id.split('/').pop()

  db.prepare(
    `INSERT INTO payments (id, type, quote_id, incoming_payment_url, sender_node, sender_account, sender_name,
      sender_wallet, receiver_node, receiver_account, receiver_name, receiver_wallet, quoted_debit, quoted_receive,
      state, created_at, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENDING', ?, ?)`
  ).run(
    paymentId, type, quote.id.split('/').pop(), incomingPaymentUrl,
    sender.node, sender.id, sender.name, sender.walletAddress,
    receiver.node, receiver.id, receiver.name, receiver.walletAddress,
    JSON.stringify(quote.debitAmount), JSON.stringify(quote.receiveAmount),
    created.createdAt ?? now(), JSON.stringify({ ...details, grantId: grant.id })
  )

  const receiverBefore = await findAccount(receiver.node, receiver.id)
  let payment
  awaiting.add(paymentId)
  try {
    for (let i = 0; i < 60; i++) {
      payment = await getOutgoingPayment(sender.node, paymentId)
      if (FINAL_STATES.includes(payment.state)) break
      await sleep(500)
    }
    if (FINAL_STATES.includes(payment.state)) {
      const result = (await settle(paymentId, payment, receiverBefore.balance)) ?? (await settledElsewhere(paymentId))
      return { ...result, debit: quote.debitAmount }
    }
  } finally {
    awaiting.delete(paymentId)
  }
  return { ...resultOf(db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)), state: payment.state, debit: quote.debitAmount, retrying: true }
}

// Quote and pay in one step, for actions where the caller has already decided (e.g. a central bank funding)
async function quoteAndPay(options) {
  const { quoteId } = await quote(options)
  return pay(quoteId)
}

module.exports = { clearPendingQuotes, quote, getPendingQuote, listPendingQuotes, cancelQuote, onSettled, pay, payUnderGrant, settleSending, quoteAndPay }
