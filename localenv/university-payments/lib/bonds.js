// The bond registry. Students issue bonds in their home currency; any student buys slices, for themselves or
// for another holder (e.g. a family savings account on another node). Interledger moves the money; this app
// records who owns what, and only after the purchase payment has completed (simulated delivery versus payment).

const { randomUUID } = require('crypto')
const { NODES } = require('./nodes')
const mockBank = require('./mock-bank')
const payments = require('./payments')
const coupons = require('./coupons')
const { db, now } = require('./db')
const { UserError, toMinorUnits, formatAmount } = require('./money')

const SCALE = 2
const FREQUENCIES = {
  daily: { label: 'daily', days: 1 },
  weekly: { label: 'weekly', days: 7 },
  monthly: { label: 'monthly', days: 30 },
  quarterly: { label: 'quarterly', days: 91 },
  semiannual: { label: 'every 6 months', days: 182 },
  annual: { label: 'yearly', days: 365 }
}
const MAX_TERM_DAYS = 3650

const amount = (value, currency) => ({ value: String(value), assetCode: currency, assetScale: SCALE })
const parse = (json) => (json ? JSON.parse(json) : null)

// Interest on a face amount over a number of days: face × rate × days / 365, in minor units, rounded down
function interest(face, annualRate, days) {
  return (BigInt(face) * BigInt(Math.round(annualRate * 10000)) * BigInt(days)) / BigInt(365 * 100 * 10000)
}

function couponTerms(bond, face) {
  const { days, label } = FREQUENCIES[bond.coupon_frequency]
  const payments = Math.floor(bond.term_days / days)
  return {
    frequency: label,
    perCoupon: amount(interest(face, bond.annual_rate, days), bond.currency),
    coupons: payments,
    totalInterest: amount(interest(face, bond.annual_rate, payments * days), bond.currency)
  }
}

// --- Amounts sold, reserved and left ---

// Slices being bought right now count against what's left: quoted but not confirmed, or still sending
function inFlight(bondId) {
  let reserved = BigInt(0)
  for (const q of payments.listPendingQuotes('bond')) if (q.details.bondId === bondId) reserved += BigInt(q.details.amount)
  for (const row of db.prepare(`SELECT details FROM payments WHERE type = 'bond' AND state IN ('SENDING', 'SETTLING')`).all()) {
    const d = parse(row.details)
    if (d.bondId === bondId) reserved += BigInt(d.amount)
  }
  return reserved
}

function sold(bondId) {
  return db.prepare('SELECT amount FROM holdings WHERE bond_id = ?').all(bondId).reduce((sum, h) => sum + BigInt(h.amount), BigInt(0))
}

function view(bond) {
  const soldAmount = sold(bond.id)
  const reserved = inFlight(bond.id)
  const remaining = BigInt(bond.size) - soldAmount - reserved
  return {
    id: bond.id,
    name: bond.name,
    status: bond.status,
    issuer: { node: bond.issuer_node, nodeLabel: NODES[bond.issuer_node].label, id: bond.issuer_account, name: bond.issuer_name, walletAddress: bond.issuer_wallet },
    currency: bond.currency,
    size: amount(bond.size, bond.currency),
    minSlice: amount(bond.min_slice, bond.currency),
    annualRate: bond.annual_rate,
    termDays: bond.term_days,
    couponFrequency: bond.coupon_frequency,
    couponFrequencyLabel: FREQUENCIES[bond.coupon_frequency].label,
    issuedAt: bond.issued_at,
    maturesAt: bond.matures_at,
    sold: amount(soldAmount, bond.currency),
    reserved: amount(reserved, bond.currency),
    remaining: amount(remaining < BigInt(0) ? 0 : remaining, bond.currency),
    holders: db.prepare('SELECT COUNT(DISTINCT holder_node || holder_account) AS n FROM holdings WHERE bond_id = ?').get(bond.id).n,
    ...coupons.bondStatus(bond)
  }
}

function getBond(bondId) {
  const bond = db.prepare('SELECT * FROM bonds WHERE id = ?').get(bondId)
  if (!bond) throw new UserError('Bond not found')
  return bond
}

function listBonds({ status } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM bonds WHERE status = ? ORDER BY issued_at DESC').all(status)
    : db.prepare('SELECT * FROM bonds ORDER BY issued_at DESC').all()
  return rows.map(view)
}

// --- Issue ---

async function issue(issuer, { name, size, annualRate, termDays, minSlice, couponFrequency = 'daily' }) {
  name = String(name ?? '').trim()
  if (!name) throw new UserError('Give the bond a name')
  const sizeValue = toMinorUnits(size, SCALE)
  const minSliceValue = toMinorUnits(minSlice, SCALE)
  if (BigInt(minSliceValue) > BigInt(sizeValue)) throw new UserError('The minimum slice can’t be larger than the bond')
  const rate = Number(annualRate)
  if (!/^\d+(\.\d{1,4})?$/.test(String(annualRate ?? '').trim()) || !(rate > 0) || rate > 100) {
    throw new UserError('Enter the annual interest rate as a percentage between 0 and 100, e.g. 9')
  }
  const days = Number(termDays)
  if (!Number.isInteger(days) || days < 1 || days > MAX_TERM_DAYS) throw new UserError(`Enter a term of 1 to ${MAX_TERM_DAYS} days`)
  if (!FREQUENCIES[couponFrequency]) throw new UserError('Pick a coupon frequency')
  if (FREQUENCIES[couponFrequency].days > days) throw new UserError(`A ${FREQUENCIES[couponFrequency].label} coupon needs a term of at least ${FREQUENCIES[couponFrequency].days} days`)

  const issuedAt = new Date()
  const bond = {
    id: randomUUID(),
    name,
    issuer_node: issuer.node,
    issuer_account: issuer.id,
    issuer_name: issuer.name,
    issuer_wallet: issuer.walletAddress,
    currency: issuer.assetCode,
    scale: SCALE,
    size: sizeValue,
    min_slice: minSliceValue,
    annual_rate: rate,
    term_days: days,
    coupon_frequency: couponFrequency,
    status: 'open',
    issued_at: issuedAt.toISOString(),
    matures_at: new Date(issuedAt.getTime() + days * 86_400_000).toISOString()
  }
  db.prepare(
    `INSERT INTO bonds (id, name, issuer_node, issuer_account, issuer_name, issuer_wallet, currency, scale, size,
      min_slice, annual_rate, term_days, coupon_frequency, status, issued_at, matures_at)
     VALUES (:id, :name, :issuer_node, :issuer_account, :issuer_name, :issuer_wallet, :currency, :scale, :size,
      :min_slice, :annual_rate, :term_days, :coupon_frequency, :status, :issued_at, :matures_at)`
  ).run(bond)
  return view(bond)
}

// --- Buy ---

// The buyer pays the issuer the slice's face amount in the bond's currency (fixed receive amount), quoted in
// the buyer's own currency. The holder, by default the buyer, will own the slice and receive the coupons.
async function quotePurchase(buyer, { bondId, amount: faceInput, holderNode, holderId }) {
  const bond = getBond(bondId)
  if (bond.status !== 'open') throw new UserError('This bond is no longer for sale')
  const face = toMinorUnits(faceInput, SCALE)
  const { remaining } = view(bond)
  const left = BigInt(remaining.value)
  if (left === BigInt(0)) throw new UserError('This bond is sold out')
  if (BigInt(face) > left) throw new UserError(`Only ${formatAmount(remaining)} of this bond is left`)
  if (BigInt(face) < BigInt(bond.min_slice) && BigInt(face) !== left) {
    throw new UserError(`The minimum slice is ${formatAmount(amount(bond.min_slice, bond.currency))}`)
  }

  const issuer = await mockBank.findAccount(bond.issuer_node, bond.issuer_account)
  if (buyer.node === issuer.node && buyer.id === issuer.id) throw new UserError('You can’t buy your own bond')
  const holder = holderNode && holderId ? await mockBank.findAccount(holderNode, holderId) : buyer
  if (holder.isTreasury) throw new UserError('A treasury can’t hold a bond')
  if (holder.node === issuer.node && holder.id === issuer.id) throw new UserError('The issuer can’t hold their own bond')

  const holderInfo = { node: holder.node, nodeLabel: holder.nodeLabel, id: holder.id, name: holder.name, walletAddress: holder.walletAddress }
  const quoted = await payments.quote({
    type: 'bond',
    sender: buyer,
    receiver: issuer,
    receiveAmount: amount(face, bond.currency),
    details: { bondId: bond.id, bondName: bond.name, amount: face, holder: holderInfo }
  })
  return { ...quoted, bond: view(bond), holder: holderInfo, coupons: couponTerms(bond, face) }
}

async function buy(buyer, quoteId) {
  const pending = payments.getPendingQuote(quoteId)
  if (pending.type !== 'bond') throw new UserError('Not a bond quote')
  if (pending.sender.node !== buyer.node || pending.sender.id !== buyer.id) throw new UserError('This quote belongs to another account')
  try {
    const result = await payments.pay(quoteId)
    // Whichever settler recorded the outcome, the holding table says whether the slice was recorded
    if (result.state === 'COMPLETED' && !result.outcome) {
      const holding = db.prepare('SELECT id FROM holdings WHERE payment_id = ?').get(result.id)
      result.outcome = holding ? { recorded: true, holdingId: holding.id } : { recorded: false, reason: 'holding not recorded' }
    }
    return result
  } catch (err) {
    payments.cancelQuote(quoteId) // nothing was paid: release the reserved amount
    throw err
  }
}

// Delivery versus payment: the holding exists only once the buyer's outgoing payment has completed
payments.onSettled('bond', (row, result) => {
  const { bondId, amount: face, holder } = parse(row.details)
  if (result.state !== 'COMPLETED') {
    return { recorded: false, reason: result.error || `payment ${result.state.toLowerCase()}` }
  }
  const holdingId = randomUUID()
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO holdings (id, bond_id, amount, holder_node, holder_account, holder_name, holder_wallet, buyer_node,
        buyer_account, buyer_name, buyer_wallet, payment_id, paid, received, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      holdingId, bondId, face, holder.node, holder.id, holder.name, holder.walletAddress,
      row.sender_node, row.sender_account, row.sender_name, row.sender_wallet,
      row.id, row.sent, row.received ?? JSON.stringify(amount(0, getBond(bondId).currency)), now()
    )
    const bond = getBond(bondId)
    if (sold(bondId) >= BigInt(bond.size)) db.prepare(`UPDATE bonds SET status = 'sold_out' WHERE id = ? AND status = 'open'`).run(bondId)
    // The first slice sold: the issuer now approves the grant that pays the coupons and principal
    if (!bond.lifecycle) db.prepare(`UPDATE bonds SET lifecycle = 'awaiting_grant' WHERE id = ?`).run(bondId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { recorded: true, holdingId }
})

// --- Holdings ---

// Units of `to` per unit of `from`, from the rates the nodes use (all three serve the same table)
async function rateBetween(from, to) {
  if (from === to) return 1
  const perUsd = { USD: 1, ...(await mockBank.getUsdRates('hbcu')) }
  if (!perUsd[from] || !perUsd[to]) return null
  return perUsd[to] / perUsd[from]
}

async function inCurrency(value, to) {
  const rate = await rateBetween(value.assetCode, to)
  if (rate === null) return null
  return amount(Math.round(Number(value.value) * rate), to)
}

function holdingView(h, bond) {
  const status = coupons.bondStatus(bond)
  return {
    id: h.id,
    bond: {
      id: bond.id, name: bond.name, currency: bond.currency, issuerName: bond.issuer_name, issuerNodeLabel: NODES[bond.issuer_node].label,
      annualRate: bond.annual_rate, termDays: bond.term_days, status: bond.status, lifecycle: status.lifecycle,
      lifecycleLabel: status.lifecycleLabel, nextCoupon: status.nextCoupon, maturityDay: status.maturityDay,
      couponsPaid: status.couponsPaid, couponsMissed: status.couponsMissed, missedInRow: status.missedInRow
    },
    amount: amount(h.amount, bond.currency),
    holder: { node: h.holder_node, nodeLabel: NODES[h.holder_node].label, name: h.holder_name, walletAddress: h.holder_wallet },
    buyer: { node: h.buyer_node, nodeLabel: NODES[h.buyer_node].label, name: h.buyer_name },
    paid: parse(h.paid),
    received: parse(h.received),
    coupons: couponTerms(bond, h.amount),
    paymentId: h.payment_id,
    boughtAt: h.created_at
  }
}

async function holdingsOf(student) {
  const own = student.assetCode
  const bondsById = new Map(db.prepare('SELECT * FROM bonds').all().map((b) => [b.id, b]))
  const withOwnCurrency = async (h) => {
    const v = holdingView(h, bondsById.get(h.bond_id))
    return { ...v, amountInOwnCurrency: await inCurrency(v.amount, own) }
  }

  // Coupons are per holder (all their slices of a bond together)
  const withCoupons = (v, h) => ({ ...v, coupons: { ...v.coupons, ...coupons.holderStatus(h.bond_id, h.holder_node, h.holder_account, bondsById.get(h.bond_id).currency) } })
  const issued = await Promise.all(
    db.prepare('SELECT * FROM bonds WHERE issuer_node = ? AND issuer_account = ? ORDER BY issued_at DESC').all(student.node, student.id).map(async (b) => {
      const v = view(b)
      const raised = db.prepare('SELECT received FROM holdings WHERE bond_id = ?').all(b.id).reduce((sum, h) => sum + BigInt(parse(h.received).value), BigInt(0))
      return { ...v, raised: amount(raised, b.currency), soldInOwnCurrency: await inCurrency(v.sold, own), history: coupons.couponHistory(b.id),
        grantTerms: b.lifecycle === 'awaiting_grant' ? coupons.grantTerms(b) : null }
    })
  )
  const held = await Promise.all(
    db.prepare('SELECT * FROM holdings WHERE holder_node = ? AND holder_account = ? ORDER BY created_at DESC').all(student.node, student.id)
      .map(async (h) => withCoupons(await withOwnCurrency(h), h))
  )
  const paidForOthers = await Promise.all(
    db.prepare(`SELECT * FROM holdings WHERE buyer_node = ? AND buyer_account = ? AND NOT (holder_node = buyer_node AND holder_account = buyer_account)
      ORDER BY created_at DESC`).all(student.node, student.id).map(async (h) => withCoupons(await withOwnCurrency(h), h))
  )
  return { currency: own, issued, held, paidForOthers }
}

module.exports = { FREQUENCIES, listBonds, issue, quotePurchase, buy, holdingsOf }
