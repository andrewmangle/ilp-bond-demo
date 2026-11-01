// Recurring bond purchases under an Open Payments grant from the buyer.
//
// A student sets up a plan: a bond, an amount per purchase in the bond's currency, weekly or monthly on the demo
// clock, a holder (themselves or e.g. a family account) and a number of purchase dates or an end date. They
// approve one outgoing-payment grant on their bank's consent screen, limited per purchase period to what one
// purchase costs in their own currency plus a buffer for rate changes.
//
// The first purchase is made when the grant is approved, then one per period. Each is a purchase like a manual
// buy, made by the app under the grant: incoming payment on the issuer's wallet, quote fixing what the issuer
// receives, then the outgoing payment, and the holding is recorded for the holder once it completes (the same
// settled-payment hook as a manual buy). A purchase is skipped, with the reason recorded, if the bond is sold
// out, matured or in default, if the buyer lacks the funds, or if the quote is over the grant's limit (a rate
// moved): that one is flagged, and nothing is spent. Paused plans skip their dates. A purchase count is a count
// of purchase dates, skipped ones included, so "4 weekly purchases" always ends after 4 weeks.

const { randomUUID } = require('crypto')
const { NODES } = require('./nodes')
const clock = require('./clock')
const mockBank = require('./mock-bank')
const payments = require('./payments')
const openPayments = require('./open-payments')
const coupons = require('./coupons')
const bonds = require('./bonds')
const { db, now } = require('./db')
const maintenance = require('./maintenance')
const { UserError, ForbiddenError, toMinorUnits, formatAmount } = require('./money')

const SCALE = 2
const FREQUENCIES = { weekly: { label: 'weekly', days: 7 }, monthly: { label: 'monthly', days: 30 } }
const RATE_BUFFER_PERCENT = 5 // the grant allows this much more than one purchase cost when the plan was set up
const MAX_PURCHASES = 520

const amount = (value, assetCode) => ({ value: String(value), assetCode, assetScale: SCALE })
const parse = (json) => (json ? JSON.parse(json) : null)
const periodMs = (plan) => FREQUENCIES[plan.frequency].days * clock.DAY_MS
const dueOf = (plan, k) => plan.start_demo + (k - 1) * periodMs(plan)

async function rateBetween(from, to) {
  if (from === to) return 1
  const perUsd = { USD: 1, ...(await mockBank.getUsdRates('hbcu')) }
  return perUsd[to] / perUsd[from]
}

function getPlan(planId, buyer) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan) throw new UserError('Plan not found')
  if (buyer && (plan.buyer_node !== buyer.node || plan.buyer_account !== buyer.id)) throw new ForbiddenError('This is another student’s plan')
  return plan
}

// --- Set up ---

async function createPlan(buyer, { bondId, amount: faceInput, frequency, holderNode, holderId, purchases, endDay }) {
  const bond = db.prepare('SELECT * FROM bonds WHERE id = ?').get(bondId)
  if (!bond) throw new UserError('Pick a bond')
  if (bond.status !== 'open' || ['matured', 'in_default'].includes(bond.lifecycle)) throw new UserError('This bond is no longer for sale')
  if (!FREQUENCIES[frequency]) throw new UserError('Pick weekly or monthly')
  const face = toMinorUnits(faceInput, SCALE)
  if (BigInt(face) < BigInt(bond.min_slice)) throw new UserError(`The minimum slice is ${formatAmount(amount(bond.min_slice, bond.currency))}`)
  if (buyer.node === bond.issuer_node && buyer.id === bond.issuer_account) throw new UserError('You can’t buy your own bond')

  const holder = holderNode && holderId ? await mockBank.findAccount(holderNode, holderId) : buyer
  if (holder.isTreasury) throw new UserError('A treasury can’t hold a bond')
  if (holder.node === bond.issuer_node && holder.id === bond.issuer_account) throw new UserError('The issuer can’t hold their own bond')

  let maxPurchases = null
  let endDemo = null
  if (String(purchases ?? '').trim()) {
    maxPurchases = Number(purchases)
    if (!Number.isInteger(maxPurchases) || maxPurchases < 1 || maxPurchases > MAX_PURCHASES) throw new UserError(`Enter 1 to ${MAX_PURCHASES} purchases`)
  } else if (String(endDay ?? '').trim()) {
    const day = Number(endDay)
    if (!Number.isInteger(day) || day <= clock.state().day) throw new UserError(`Enter an end day after today (day ${clock.state().day})`)
    endDemo = clock.now() + (day - clock.dayOf(clock.now())) * clock.DAY_MS
  } else {
    throw new UserError('Give a number of purchases or an end day')
  }

  // What one purchase costs the buyer today, and the grant's limit per period with a buffer for rate changes
  const rate = await rateBetween(bond.currency, buyer.assetCode)
  const estimate = BigInt(Math.ceil(Number(face) * rate))
  const limit = estimate + (estimate * BigInt(RATE_BUFFER_PERCENT) + BigInt(99)) / BigInt(100)

  const id = randomUUID()
  db.prepare(
    `INSERT INTO plans (id, bond_id, buyer_node, buyer_account, buyer_name, buyer_wallet, holder_node, holder_account, holder_name,
      holder_wallet, amount, frequency, max_purchases, end_demo, state, estimate, limit_amount, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_grant', ?, ?, ?)`
  ).run(
    id, bond.id, buyer.node, buyer.id, buyer.name, buyer.walletAddress, holder.node, holder.id, holder.name, holder.walletAddress,
    face, frequency, maxPurchases, endDemo === null ? null : Math.floor(endDemo),
    JSON.stringify(amount(estimate, buyer.assetCode)), JSON.stringify(amount(limit, buyer.assetCode)), now()
  )
  return planView(getPlan(id))
}

// --- Grant ---

const planGrant = (planId) => db.prepare(`SELECT * FROM grants WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1`).get(planId)

async function requestGrant(buyer, planId, appUrl) {
  const plan = getPlan(planId, buyer)
  if (plan.state !== 'awaiting_grant') throw new UserError('This plan already has its grant')
  await openPayments.ensureClient()
  const limit = parse(plan.limit_amount)
  const secondsPerDay = clock.secondsPerDay()
  const interval = `R/${new Date().toISOString()}/PT${FREQUENCIES[plan.frequency].days * secondsPerDay}S`
  const id = randomUUID()
  const clientNonce = randomUUID()
  const requested = await openPayments.requestOutgoingPaymentGrant({
    walletAddress: buyer.walletAddress,
    limits: { debitAmount: limit, interval },
    finishUri: `${appUrl}/grants/finish?grant=${id}`,
    nonce: clientNonce
  })
  db.prepare(
    `INSERT INTO grants (id, bond_id, plan_id, purpose, wallet_address, resource_server, state, client_nonce, finish_nonce, auth_server,
      continue_uri, continue_token, redirect, interval, interval_limit, planned_total, seconds_per_day, created_at)
     VALUES (?, ?, ?, 'plan', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, plan.bond_id, plan.id, buyer.walletAddress, requested.walletAddress.resourceServer, clientNonce, requested.finishNonce,
    requested.walletAddress.authServer, requested.continueUri, requested.continueToken, requested.redirect, interval,
    plan.limit_amount, plan.limit_amount, secondsPerDay, now()
  )
  return { grantId: id, redirect: requested.redirect, limits: { debitAmount: limit, interval } }
}

// The browser comes back from the buyer's consent screen
async function finishGrant(grant, query) {
  const outcome = await coupons.completeGrant(grant, query)
  if (outcome !== 'approved') return `/bonds?plan=${outcome}`
  db.prepare(`UPDATE plans SET state = 'active', start_demo = ?, runs_done = 0 WHERE id = ?`).run(Math.floor(clock.now()), grant.plan_id)
  return `/bonds?plan=approved`
}

async function revokeGrant(plan) {
  const grant = planGrant(plan.id)
  if (grant?.state !== 'approved') return
  try {
    await openPayments.revokeToken({ manage: grant.manage_uri, value: grant.access_token })
  } catch (err) {
    console.warn(`Revoking plan grant ${grant.id}: ${err.message}`)
  }
  db.prepare(`UPDATE grants SET state = 'revoked' WHERE id = ?`).run(grant.id)
}

// --- Manage ---

async function setState(buyer, planId, action) {
  const plan = getPlan(planId, buyer)
  if (action === 'pause') {
    if (plan.state !== 'active') throw new UserError('Only an active plan can be paused')
    db.prepare(`UPDATE plans SET state = 'paused' WHERE id = ?`).run(plan.id)
  } else if (action === 'resume') {
    if (plan.state !== 'paused') throw new UserError('Only a paused plan can be resumed')
    db.prepare(`UPDATE plans SET state = 'active' WHERE id = ?`).run(plan.id)
  } else if (action === 'cancel') {
    if (['completed', 'cancelled'].includes(plan.state)) throw new UserError('This plan has already ended')
    await revokeGrant(plan)
    db.prepare(`UPDATE plans SET state = 'cancelled', ended_at = ? WHERE id = ?`).run(now(), plan.id)
  } else {
    throw new UserError('Unknown action')
  }
  return planView(getPlan(plan.id))
}

// --- Each period ---

function recordRun(runId, fields) {
  const keys = Object.keys(fields)
  db.prepare(`UPDATE plan_runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => (fields[k] && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k] ?? null)), runId)
}

// Why this period's purchase can't go ahead before quoting, or null
function skipReason(plan, bond, issuer) {
  if (plan.state === 'paused') return 'plan paused'
  if (bond.lifecycle === 'matured') return 'bond has matured'
  if (bond.lifecycle === 'in_default') return 'bond is in default'
  if (bond.status !== 'open') return 'bond is sold out'
  if (!issuer) return 'issuer’s account not found'
  const { remaining } = bonds.listBonds().find((b) => b.id === bond.id)
  if (BigInt(remaining.value) < BigInt(plan.amount)) return remaining.value === '0' ? 'bond is sold out' : `only ${formatAmount(remaining)} left`
  return null
}

async function runPurchase(plan, k) {
  let run = db.prepare('SELECT * FROM plan_runs WHERE plan_id = ? AND idx = ?').get(plan.id, k)
  if (!run) {
    db.prepare(`INSERT INTO plan_runs (id, plan_id, idx, due_demo, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run(randomUUID(), plan.id, k, dueOf(plan, k), now())
    run = db.prepare('SELECT * FROM plan_runs WHERE plan_id = ? AND idx = ?').get(plan.id, k)
  }
  // Interrupted after paying: settle from the payment instead of paying again
  const made = run.status === 'pending' && db.prepare(`SELECT id FROM payments WHERE details LIKE ?`).get(`%"runId":"${run.id}"%`)
  if (made) recordRun(run.id, { status: 'sending', payment_id: made.id })
  else if (run.status === 'pending') await attemptPurchase(plan, run)

  db.prepare('UPDATE plans SET runs_done = ? WHERE id = ?').run(k, plan.id)
  const status = db.prepare('SELECT status, reason FROM plan_runs WHERE id = ?').get(run.id)
  console.log(`Plan ${plan.id.slice(0, 8)} (${plan.buyer_name} → ${plan.holder_name}): purchase ${k}: ${status.status}${status.reason ? ` (${status.reason})` : ''}`)

  const ended = (plan.max_purchases && k >= plan.max_purchases) || (plan.end_demo && dueOf(plan, k + 1) > plan.end_demo)
  if (ended) {
    await revokeGrant(plan)
    db.prepare(`UPDATE plans SET state = 'completed', ended_at = ? WHERE id = ?`).run(now(), plan.id)
  }
}

async function attemptPurchase(plan, run) {
  const bond = db.prepare('SELECT * FROM bonds WHERE id = ?').get(plan.bond_id)
  const issuer = await mockBank.findAccount(bond.issuer_node, bond.issuer_account).catch(() => null)
  const reason = skipReason(plan, bond, issuer)
  if (reason) return recordRun(run.id, { status: 'skipped', reason })

  const buyer = await mockBank.findAccount(plan.buyer_node, plan.buyer_account).catch(() => null)
  if (!buyer) return recordRun(run.id, { status: 'skipped', reason: 'buyer’s account not found' })
  const grant = await coupons.freshToken(planGrant(plan.id))
  const limit = parse(plan.limit_amount)
  const holder = { node: plan.holder_node, nodeLabel: NODES[plan.holder_node].label, id: plan.holder_account, name: plan.holder_name, walletAddress: plan.holder_wallet }

  const result = await payments.payUnderGrant({
    type: 'bond',
    grant: { id: grant.id, resourceServer: grant.resource_server, accessToken: grant.access_token },
    sender: buyer,
    receiver: issuer,
    receiveAmount: amount(plan.amount, bond.currency),
    details: { bondId: bond.id, bondName: bond.name, amount: plan.amount, holder, planId: plan.id, runId: run.id },
    // Never overspend: a quote over the grant's limit (the rate moved) or over the buyer's balance is skipped
    check: (quote) => {
      if (BigInt(quote.debitAmount.value) > BigInt(limit.value)) {
        const flag = `Purchase ${run.idx} (day ${clock.dayOf(run.due_demo)}) skipped: the quote, ${formatAmount(quote.debitAmount)}, was over the grant’s limit of ${formatAmount(limit)}`
        db.prepare('UPDATE plans SET flag = ? WHERE id = ?').run(flag, plan.id)
        return `over the grant limit: quote ${formatAmount(quote.debitAmount)}, limit ${formatAmount(limit)}`
      }
      if (BigInt(quote.debitAmount.value) > BigInt(buyer.balance)) {
        return `not enough funds: needs ${formatAmount(quote.debitAmount)}, has ${formatAmount({ ...buyer, value: buyer.balance })}`
      }
      return null
    }
  }).catch((err) => ({ state: 'ERROR', error: err.message }))

  if (result.state === 'SKIPPED') return recordRun(run.id, { status: 'skipped', reason: result.reason, debit: result.quote.debitAmount })
  if (result.state === 'COMPLETED') {
    // The holding is recorded by the bond purchase's settled-payment hook, whichever settler ran it
    const holding = db.prepare('SELECT id FROM holdings WHERE payment_id = ?').get(result.id)
    return recordRun(run.id, holding
      ? { status: 'bought', payment_id: result.id, debit: result.debit, sent: result.sent, received: result.received }
      : { status: 'skipped', reason: result.outcome?.reason ?? 'holding not recorded', payment_id: result.id })
  }
  if (result.state === 'SENDING') return recordRun(run.id, { status: 'sending', payment_id: result.id, debit: result.debit })
  const why = result.state === 'CANCELLED' ? 'not enough funds (the bank refused the payment)' : result.error || `payment ${String(result.state).toLowerCase()}`
  return recordRun(run.id, { status: 'skipped', reason: why, payment_id: result.id ?? null })
}

// Runs still sending: finish them from the payment record (the holding is recorded by the payment's own hook)
function reconcileSending() {
  for (const run of db.prepare(`SELECT * FROM plan_runs WHERE status = 'sending'`).all()) {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(run.payment_id)
    if (!p || ['SENDING', 'SETTLING'].includes(p.state)) continue
    const holding = db.prepare('SELECT id FROM holdings WHERE payment_id = ?').get(p.id)
    recordRun(run.id, holding
      ? { status: 'bought', sent: parse(p.sent), received: parse(p.received) }
      : { status: 'skipped', reason: p.error || `payment ${p.state.toLowerCase()}` })
  }
}

let running = false
let lastTickAt = 0
async function tick() {
  lastTickAt = Date.now()
  if (running || clock.isPaused() || maintenance.state.active) return
  running = true
  try {
    reconcileSending()
    for (const plan of db.prepare(`SELECT * FROM plans WHERE state IN ('active', 'paused')`).all()) {
      const k = plan.runs_done + 1
      if (clock.now() >= dueOf(plan, k)) {
        await runPurchase(plan, k).catch((err) => console.error(`Plan ${plan.id}: purchase ${k} failed to run: ${err.message}`))
      }
    }
  } finally {
    running = false
  }
}

// --- What the pages show ---

const STATE_LABELS = { awaiting_grant: 'Awaiting grant', active: 'Active', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled' }

function planView(plan) {
  const bond = db.prepare('SELECT name, currency, issuer_name, issuer_node FROM bonds WHERE id = ?').get(plan.bond_id)
  const runs = db.prepare('SELECT * FROM plan_runs WHERE plan_id = ? ORDER BY idx DESC').all(plan.id)
  const grant = planGrant(plan.id)
  const limit = parse(plan.limit_amount)
  const spent = runs.filter((r) => r.status === 'bought').reduce((sum, r) => sum + BigInt(parse(r.debit)?.value ?? 0), BigInt(0))
  // At most one purchase per period, so this period's remaining limit is the whole limit until it has bought
  const k = plan.runs_done
  const thisPeriod = plan.start_demo && k > 0 ? runs.find((r) => r.idx === k) : null
  const usedThisPeriod = thisPeriod?.status === 'bought' && clock.now() < dueOf(plan, k + 1) ? BigInt(parse(thisPeriod.debit)?.value ?? 0) : BigInt(0)
  const live = ['active', 'paused'].includes(plan.state)
  const nextDue = live ? dueOf(plan, k + 1) : null
  const nextReal = nextDue === null ? null : clock.realTimeOf(nextDue)
  return {
    id: plan.id,
    state: plan.state,
    stateLabel: STATE_LABELS[plan.state],
    bond: { id: plan.bond_id, name: bond.name, currency: bond.currency, issuerName: bond.issuer_name, issuerNodeLabel: NODES[bond.issuer_node].label },
    buyer: { name: plan.buyer_name, nodeLabel: NODES[plan.buyer_node].label },
    holder: { name: plan.holder_name, nodeLabel: NODES[plan.holder_node].label },
    amount: amount(plan.amount, bond.currency),
    frequency: plan.frequency,
    frequencyLabel: FREQUENCIES[plan.frequency].label,
    ends: plan.max_purchases ? `after ${plan.max_purchases} purchase dates` : `on day ${clock.dayOf(plan.end_demo)}`,
    maxPurchases: plan.max_purchases,
    estimate: parse(plan.estimate),
    grant: grant && {
      state: grant.state,
      limit,
      interval: grant.interval,
      usedThisPeriod: { ...limit, value: usedThisPeriod.toString() },
      remainingThisPeriod: { ...limit, value: (BigInt(limit.value) - usedThisPeriod).toString() },
      redirect: grant.state === 'pending' ? grant.redirect : null,
      error: ['failed', 'rejected'].includes(grant.state) ? grant.error : null
    },
    spent: { ...limit, value: spent.toString() },
    nextPurchase: nextDue === null ? null : { day: clock.dayOf(nextDue), paused: clock.isPaused(), inSeconds: nextReal === null ? null : Math.max(0, Math.ceil((nextReal - Date.now()) / 1000)) },
    bought: runs.filter((r) => r.status === 'bought').length,
    skipped: runs.filter((r) => r.status === 'skipped').length,
    flag: plan.flag,
    runs: runs.slice(0, 20).map((r) => ({ idx: r.idx, day: clock.dayOf(r.due_demo), status: r.status, reason: r.reason, debit: parse(r.debit), received: parse(r.received) }))
  }
}

function plansOf(student) {
  return db
    .prepare(`SELECT * FROM plans WHERE buyer_node = ? AND buyer_account = ? ORDER BY created_at DESC`)
    .all(student.node, student.id)
    .map(planView)
}

const schedulerState = () => ({ running, lastTickAt })

module.exports = { schedulerState, FREQUENCIES, createPlan, requestGrant, finishGrant, setState, tick, plansOf }
