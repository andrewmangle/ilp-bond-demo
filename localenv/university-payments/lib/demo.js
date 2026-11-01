// Demo control: health check, Reset Demo and Seed Demo.
//
// Reset Demo wipes the demo app's data (bonds, holdings, grants, plans, payments, mints, rates set) after revoking
// any grants still live, puts the demo clock back to day 1, and returns the three mock banks to their seeded state
// (accounts and balances from seed.yml, seed rates) by deleting their saved accounts and restarting them.
// Rafiki itself keeps its payment history; activity and the live feed only show what happened after the reset.
//
// Seed Demo resets, then sets up the starting point for the demo: funded treasuries on all three nodes, funded
// students Jordan (HBCU), Sophie (Hague) and Amara (Cape Town), the Ellis Family Savings account on Cape Town,
// and Amara's 10,000 ZAR bond at 9% for 365 days. No holdings yet.

const { execFile } = require('child_process')
const { promisify } = require('util')
const { NODES, TREASURY_PATH } = require('./nodes')
const { adminApi } = require('./admin-api')
const mockBank = require('./mock-bank')
const openPayments = require('./open-payments')
const payments = require('./payments')
const centralBank = require('./central-bank')
const bonds = require('./bonds')
const coupons = require('./coupons')
const plans = require('./plans')
const clock = require('./clock')
const maintenance = require('./maintenance')
const { db, now } = require('./db')
const { UserError } = require('./money')

const run = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const startedAt = Date.now()
const SCHEDULER_STALE_MS = 10_000

const DEMO_TABLES = ['plan_runs', 'plans', 'coupon_lines', 'coupon_events', 'accruals', 'holdings', 'grants', 'bonds', 'mints', 'rate_changes', 'rates', 'payments']

const SEED = {
  treasuries: { hbcu: '1000000', hague: '1000000', capetown: '20000000' },
  students: [
    { node: 'hbcu', path: 'accounts/jordan', funding: '1000' },
    { node: 'hague', path: 'accounts/sophie', funding: '1000' },
    { node: 'capetown', path: 'accounts/amara', funding: '5000' }, // pays the bond's coupons
    { node: 'capetown', path: 'accounts/ellis-family', funding: null }
  ],
  bond: { issuer: 'accounts/amara', name: 'Cape Solar Bond', size: '10000', annualRate: '9', termDays: 365, minSlice: '100', couponFrequency: 'daily' }
}

// --- Health ---

async function probe(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, detail: err.cause?.code ?? err.name }
  }
}

async function health() {
  const nodes = await Promise.all(Object.entries(NODES).map(async ([key, n]) => {
    const base = n.openPaymentsPort // 3000 / 4000 / 5000
    const [mockBankUp, backend, openPaymentsUp, auth] = await Promise.all([
      probe(`${n.mockBank}/healthz`),
      probe(`http://localhost:${base + 1}/healthz`),
      probe(`http://localhost:${base}/healthz`),
      probe(`http://localhost:${n.authPort}/discovery`)
    ])
    const checks = { mockBank: mockBankUp, adminApi: backend, openPayments: openPaymentsUp, auth }
    return { node: key, label: n.label, ok: Object.values(checks).every((c) => c.ok), checks }
  }))
  const schedulers = { coupons: coupons.schedulerState(), plans: plans.schedulerState() }
  const scheduler = {
    // Up if it ran recently (or the app only just started and it hasn't had its first run yet)
    ok: Object.values(schedulers).every((s) => Date.now() - (s.lastTickAt || startedAt) < SCHEDULER_STALE_MS),
    paused: clock.isPaused(),
    maintenance: maintenance.state.active,
    lastRunSecondsAgo: Object.fromEntries(Object.entries(schedulers).map(([k, s]) => [k, s.lastTickAt ? Math.round((Date.now() - s.lastTickAt) / 1000) : null]))
  }
  const app = { ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }
  return {
    ok: nodes.every((n) => n.ok) && scheduler.ok,
    at: now(),
    clock: clock.state(),
    app,
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

async function revokeLiveGrants() {
  for (const grant of db.prepare(`SELECT * FROM grants WHERE state = 'approved'`).all()) {
    await Promise.race([
      openPayments.revokeToken({ manage: grant.manage_uri, value: grant.access_token }),
      sleep(5000)
    ]).catch((err) => console.warn(`Reset: revoking grant ${grant.id}: ${err.message}`))
  }
}

// Back once the treasury and every account the demo seeds on this node have their wallet addresses
async function waitForSeeded(nodeKey, timeoutMs = 120_000) {
  const paths = [TREASURY_PATH, ...SEED.students.filter((s) => s.node === nodeKey).map((s) => s.path)]
  const end = Date.now() + timeoutMs
  for (;;) {
    const accounts = await mockBank.listNodeAccounts(nodeKey).catch(() => [])
    if (paths.every((path) => accounts.some((a) => a.walletAddress.endsWith(`/${path}`) && a.walletAddressId))) return
    if (Date.now() > end) throw new Error(`${NODES[nodeKey].label} mock bank did not come back after the reset`)
    await sleep(1000)
  }
}

// Deletes the mock bank's saved accounts and restarts it, so it seeds again from seed.yml
async function resetMockBank(nodeKey) {
  const container = NODES[nodeKey].mockBankContainer
  await run('docker', ['exec', container, 'rm', '-f', '/workspace/state/accounts.json'])
  await run('docker', ['restart', container])
}

async function reset({ confirm } = {}) {
  if (confirm !== true) throw new UserError('Confirm the reset: it wipes all demo data')
  if (maintenance.state.active) throw new UserError('A reset is already running')
  maintenance.state.active = true
  const t0 = Date.now()
  try {
    await waitForSchedulersIdle()
    await revokeLiveGrants()
    db.exec('BEGIN')
    try {
      for (const table of DEMO_TABLES) db.exec(`DELETE FROM ${table}`)
      db.prepare(`INSERT INTO settings (key, value) VALUES ('demo_epoch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    payments.clearPendingQuotes()
    clock.reset()
    await Promise.all(Object.keys(NODES).map(resetMockBank))
    await Promise.all(Object.keys(NODES).map((key) => waitForSeeded(key)))
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

  for (const [node, amount] of Object.entries(SEED.treasuries)) {
    const minted = await centralBank.mint(node, amount)
    out.treasuries[node] = minted.treasuryBalance
  }
  const byPath = async (node, path) => {
    const account = (await mockBank.listNodeAccounts(node)).find((a) => a.walletAddress.endsWith(`/${path}`))
    if (!account) throw new Error(`${NODES[node].label} has no ${path} (is it in seed.yml?)`)
    return account
  }
  for (const s of SEED.students) {
    const account = await byPath(s.node, s.path)
    if (s.funding) {
      const paid = await centralBank.fundStudent(s.node, account.id, s.funding)
      if (paid.state !== 'COMPLETED') throw new Error(`Funding ${account.name} did not complete (${paid.state} ${paid.error ?? ''})`)
      // Wait until the student's bank has booked it, so the demo starts with the money there
      const end = Date.now() + 30_000
      while (BigInt((await mockBank.findAccount(s.node, account.id)).balance) < BigInt(paid.received.value)) {
        if (Date.now() > end) throw new Error(`${account.name}'s bank has not booked the funding`)
        await sleep(500)
      }
    }
    const after = await mockBank.findAccount(s.node, account.id)
    out.students.push({ name: after.name, nodeLabel: after.nodeLabel, walletAddress: after.walletAddress, balance: { value: after.balance, assetCode: after.assetCode, assetScale: after.assetScale } })
  }
  const issuer = await byPath('capetown', SEED.bond.issuer)
  out.bond = await bonds.issue(issuer, SEED.bond)
  console.log(`Seed Demo done: ${out.bond.name} by ${issuer.name}, ${out.students.length} students`)
  return out
}

module.exports = { health, reset, seed }
