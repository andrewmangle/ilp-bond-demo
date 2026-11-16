// Demo control on the Rhyza rail: health, Reset Demo and Seed Demo. Same exports as the Rafiki rail's demo.js.
//
// Reset Demo wipes the demo app's data and the app's FSP ledger (accounts, balances), puts the demo clock back
// to day 1, and opens a fresh set of wallet addresses on Rhyza (new pathName suffix). Nothing is restarted:
// Rhyza keeps its own history, and activity and the live feed only show what happened after the reset.
// Peers and their liquidity are set up once by rhyza/seed.mjs and survive a Reset Demo.
//
// Seed Demo resets, then sets up the starting point: funded treasuries on every node, funded students Jordan
// (BSU), Sophie (HBCU South East) and, with Node C, Amara (HBCU South West), the Ellis Family Savings account on
// HBCU South East, and Sophie's bond. No holdings yet.

const { NODES } = require('./nodes')
const { admin } = require('./rhyza')
const bank = require('./mock-bank')
const payments = require('./payments')
const centralBank = require('./central-bank')
const bonds = require('../../bonds')
const coupons = require('../../coupons')
const plans = require('../../plans')
const clock = require('../../clock')
const maintenance = require('../../maintenance')
const { db, now } = require('../../db')
const { UserError } = require('../../money')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const startedAt = Date.now()
const SCHEDULER_STALE_MS = 10_000

const DEMO_TABLES = ['plan_runs', 'plans', 'coupon_lines', 'coupon_events', 'accruals', 'holdings', 'grants', 'bonds', 'mints', 'rate_changes', 'rates', 'payments']

const SEED = {
  treasuries: { hbcu: '1000000', hague: '1000000', capetown: '1000000' },
  students: [
    { node: 'hbcu', path: 'jordan', funding: '1000' },
    { node: 'hague', path: 'sophie', funding: '1000' }, // pays the bond's coupons
    { node: 'hague', path: 'ellis-family', funding: null },
    { node: 'capetown', path: 'amara', funding: '1000' }
  ],
  bond: { issuer: { node: 'hague', path: 'sophie' }, name: 'South East Housing Bond', size: '1000', annualRate: '6', termDays: 365, minSlice: '100', couponFrequency: 'daily' }
}

// --- Health ---

// Any HTTP answer means the service is up (the Open Payments and auth roots have no health route)
async function reachable(url, timeoutMs = 3000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: err.cause?.code ?? err.name }
  }
}

async function health() {
  const nodes = await Promise.all(Object.entries(NODES).map(async ([key, n]) => {
    const [aseMock, adminUp, openPayments, auth] = await Promise.all([
      fetch(`${n.aseMock}/healthz`, { signal: AbortSignal.timeout(3000) })
        .then((r) => (r.ok ? { ok: true } : { ok: false, detail: `HTTP ${r.status}` }), (err) => ({ ok: false, detail: err.cause?.code ?? err.name })),
      admin(key).ping().then(() => ({ ok: true }), (err) => ({ ok: false, detail: err.message.slice(0, 80) })),
      reachable(n.openPayments),
      reachable(n.auth)
    ])
    // mockBank: on Rhyza, the playground's ase-mock-service (approves payments); the ledger is the app's own
    const checks = { mockBank: aseMock, adminApi: adminUp, openPayments, auth }
    return { node: key, label: `${n.label} (Rhyza ${n.rhyza})`, ok: Object.values(checks).every((c) => c.ok), checks }
  }))
  const schedulers = { coupons: coupons.schedulerState(), plans: plans.schedulerState() }
  const scheduler = {
    ok: Object.values(schedulers).every((s) => Date.now() - (s.lastTickAt || startedAt) < SCHEDULER_STALE_MS),
    paused: clock.isPaused(),
    maintenance: maintenance.state.active,
    lastRunSecondsAgo: Object.fromEntries(Object.entries(schedulers).map(([k, s]) => [k, s.lastTickAt ? Math.round((Date.now() - s.lastTickAt) / 1000) : null]))
  }
  return {
    ok: nodes.every((n) => n.ok) && scheduler.ok,
    rail: 'rhyza',
    at: now(),
    clock: clock.state(),
    app: { ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
    scheduler,
    nodes,
    counts: Object.fromEntries(['bonds', 'holdings', 'plans', 'payments'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]))
  }
}

// --- Reset ---

async function waitForSchedulersIdle(timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while ((coupons.schedulerState().running || plans.schedulerState().running) && Date.now() < end) await sleep(250)
}

async function reset({ confirm } = {}) {
  if (confirm !== true) throw new UserError('Confirm the reset: it wipes all demo data')
  if (maintenance.state.active) throw new UserError('A reset is already running')
  maintenance.state.active = true
  const t0 = Date.now()
  try {
    await waitForSchedulersIdle()
    db.exec('BEGIN')
    try {
      for (const table of DEMO_TABLES) db.exec(`DELETE FROM ${table}`)
      db.prepare(`INSERT INTO settings (key, value) VALUES ('demo_epoch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    bank.resetAccounts()
    payments.clearPendingQuotes()
    clock.reset()
    await bank.ready() // new treasuries and story accounts on Rhyza
    console.log(`Reset Demo done in ${Math.round((Date.now() - t0) / 1000)} s`)
    return { reset: true, seconds: Math.round((Date.now() - t0) / 1000), clock: clock.state() }
  } finally {
    maintenance.state.active = false
  }
}

// --- Seed ---

async function seed({ confirm } = {}) {
  const resetResult = await reset({ confirm })
  const out = { reset: resetResult, treasuries: {}, students: [], bond: null }

  for (const [node, amount] of Object.entries(SEED.treasuries).filter(([node]) => NODES[node])) {
    out.treasuries[node] = (await centralBank.mint(node, amount)).treasuryBalance
  }
  const byPath = async (node, path) => {
    const account = await bank.findByPath(node, path)
    if (!account) throw new Error(`${NODES[node].label} has no ${path} account`)
    return account
  }
  for (const s of SEED.students.filter((s) => NODES[s.node])) { // HBCU South West only with Node C
    const account = await byPath(s.node, s.path)
    if (s.funding) {
      const paid = await centralBank.fundStudent(s.node, account.id, s.funding)
      if (paid.state !== 'COMPLETED') throw new Error(`Funding ${account.name} did not complete (${paid.state} ${paid.error ?? ''})`)
    }
    const after = await bank.findAccount(s.node, account.id)
    out.students.push({ name: after.name, nodeLabel: after.nodeLabel, walletAddress: after.walletAddress, balance: { value: after.balance, assetCode: after.assetCode, assetScale: after.assetScale } })
  }
  const issuer = await byPath(SEED.bond.issuer.node, SEED.bond.issuer.path)
  out.bond = await bonds.issue(issuer, { ...SEED.bond, issuer: undefined })
  console.log(`Seed Demo done: ${out.bond.name} by ${issuer.name}, ${out.students.length} students`)
  return out
}

module.exports = { health, reset, seed }
