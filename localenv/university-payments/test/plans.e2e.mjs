// Phase 4 end-to-end test against the running app: node localenv/university-payments/test/plans.e2e.mjs
// Needs the localenv and the app running, and an open Cape Solar Bond by Amara (test/bonds.e2e.mjs).
// Runs the demo clock at 1 day = 5 s (a week is 35 s) and puts it back as it was. About 4 minutes.
// 1. Jordan (HBCU, USD) sets up a weekly 182 ZAR purchase held by Ellis Family Savings, for 4 weeks, and approves
//    it on his bank's consent screen. Two purchases run; the plan is paused (the third date is skipped), resumed,
//    then cancelled, and no more purchases happen.
// 2. A second plan, set up at USD/ZAR 18.2; the ZAR rate is then raised sharply (1 USD = 16 ZAR) so the next
//    purchase costs more than the grant allows: it is skipped and flagged, and nothing is spent. Back at 18.2 the
//    following purchase goes through.
import http from 'node:http'

const BASE = process.env.BASE || 'http://localhost:3040'
const IDP_SECRET = '2pEcn2kkCclbOHQiGNEwhJ0rucATZhrA807HTm2rNXE='
const IDP_PORT = { hbcu: 3009, hague: 4009, capetown: 5009 }
const SECONDS_PER_DAY = 5
const WEEK_MS = 7 * SECONDS_PER_DAY * 1000
let failures = 0
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`) }
async function api(role, method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-acting-as': role }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
async function ok(role, method, path, body) {
  const r = await api(role, method, path, body)
  if (r.status !== 200) throw new Error(`${method} ${path} as ${role}: ${r.status} ${r.data.error}`)
  return r.data
}
const f = (a) => a ? `${(Number(a.value) / 10 ** a.assetScale).toFixed(a.assetScale)} ${a.assetCode}` : '—'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = (url, cookie) => new Promise((resolve, reject) => {
  const u = new URL(url)
  http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: cookie ? { cookie } : {} }, (r) => {
    r.resume()
    resolve({ status: r.statusCode, location: r.headers.location, cookie: (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ') })
  }).on('error', reject)
})
// What the bank's consent screen does when Yes is clicked, then follow the browser back to the app
async function consent(node, redirect) {
  const start = await get(redirect)
  const u = new URL(start.location)
  const [interactId, nonce] = [u.searchParams.get('interactId'), u.searchParams.get('nonce')]
  const screen = await fetch(start.location)
  await fetch(`http://localhost:${IDP_PORT[node]}/grant/${interactId}/${nonce}/accept`, { method: 'POST', headers: { 'x-idp-secret': IDP_SECRET, 'content-type': 'application/json' }, body: '{}' })
  const finish = await get(`${new URL(redirect).origin}/interact/${interactId}/${nonce}/finish`, start.cookie)
  return { consentScreen: `${u.origin}${u.pathname} (${screen.status})`, landedOn: (await get(finish.location)).location }
}

const directory = await ok('', 'GET', '/api/directory')
const find = (suffix) => directory.find((x) => x.walletAddress.endsWith(suffix))
const as = (a) => `student:${a.node}:${a.id}`
const [jordan, family] = [find('/accounts/jordan'), find('/accounts/ellis-family')]
const J = as(jordan)
const balance = async (a) => BigInt((await ok(as(a), 'GET', '/api/me')).balance.value)
const planById = async (id) => (await ok(J, 'GET', '/api/plans')).find((p) => p.id === id)
const familySlices = async (bondId) => (await ok(as(family), 'GET', '/api/holdings')).held.filter((h) => h.bond.id === bondId)
const waitFor = async (fn, label, ms) => {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(1000) }
}
const setRate = async (perUsd) => {
  const r = await ok('bank:capetown', 'POST', '/api/bank/capetown/rate', { perUsd })
  await sleep(Math.max(0, new Date(r.effectiveBy) - Date.now()) + 1500) // Rafiki's 15 s rate cache
}

const { secondsPerDay: originalSpeed, paused: wasPaused } = await ok('', 'GET', '/api/clock')
await ok('bank:hbcu', 'POST', '/api/clock', { paused: false })
await ok('bank:hbcu', 'POST', '/api/clock', { secondsPerDay: SECONDS_PER_DAY })
console.log(`Demo clock: 1 day = ${SECONDS_PER_DAY} s, so a week is ${WEEK_MS / 1000} s`)
try {
  await ok('bank:hbcu', 'POST', '/api/bank/hbcu/mint', { amount: '1000' })
  await ok('bank:hbcu', 'POST', '/api/bank/hbcu/fund', { accountId: jordan.id, amount: '100' })
  const bond = (await ok('', 'GET', '/api/bonds')).bonds.find((b) => b.name === 'Cape Solar Bond' && b.issuer.name === 'Amara Dube' && b.status === 'open')
  if (!bond) throw new Error('No open Cape Solar Bond by Amara: run test/bonds.e2e.mjs first')
  console.log(`Bond: ${bond.name} (${bond.lifecycleLabel}), ${f(bond.remaining)} left`)

  console.log('\n== Plan 1: weekly 182 ZAR for Ellis Family Savings, 4 purchases')
  const plan = await ok(J, 'POST', '/api/plans', { bondId: bond.id, amount: '182', frequency: 'weekly', holderNode: family.node, holderId: family.id, purchases: '4' })
  check(plan.state === 'awaiting_grant' && plan.estimate.assetCode === 'USD' && plan.holder.name === 'Ellis Family Savings',
    'set up, waiting for the grant', `≈ ${f(plan.estimate)} each`)
  const { redirect, limits } = await ok(J, 'POST', `/api/plans/${plan.id}/grant`)
  check(limits.debitAmount.value === String(Math.ceil(Number(plan.estimate.value) * 1.05)) && limits.interval.endsWith(`PT${7 * SECONDS_PER_DAY}S`),
    'grant limit per week = one purchase + 5%', `${f(limits.debitAmount)} per ${limits.interval.split('/')[2]}`)
  const slices0 = (await familySlices(bond.id)).length
  const jordan0 = await balance(jordan)
  const c1 = await consent(jordan.node, redirect)
  check(c1.landedOn === '/bonds?plan=approved', 'Jordan approved on his bank’s consent screen', c1.consentScreen)

  const p1 = await waitFor(async () => { const p = await planById(plan.id); return p.runs.length >= 1 && p.runs[0].status !== 'pending' && p }, 'purchase 1', 15000)
  const s1 = await familySlices(bond.id)
  check(p1.runs[0].status === 'bought' && s1.length === slices0 + 1 && s1[0].amount.value === '18200' && s1[0].buyer.name === 'Jordan Ellis',
    'purchase 1 on approval: holding recorded for the family account', `paid ${f(p1.runs[0].debit)}; Jordan ${f({ value: (jordan0 - await balance(jordan)).toString(), assetCode: 'USD', assetScale: 2 })} less`)

  const p2 = await waitFor(async () => { const p = await planById(plan.id); return p.runs.length >= 2 && p.runs[0].status !== 'pending' && p }, 'purchase 2', WEEK_MS + 15000)
  check(p2.runs[0].status === 'bought' && (await familySlices(bond.id)).length === slices0 + 2, 'purchase 2 a week later', `day ${p2.runs[0].day}`)
  console.log(`  grant: ${f(p2.grant.remainingThisPeriod)} of ${f(p2.grant.limit)} left this week, ${f(p2.spent)} spent; next purchase day ${p2.nextPurchase.day}`)

  await ok(J, 'POST', `/api/plans/${plan.id}/pause`)
  const p3 = await waitFor(async () => { const p = await planById(plan.id); return p.runs.length >= 3 && p.runs[0].status !== 'pending' && p }, 'date 3', WEEK_MS + 15000)
  check(p3.state === 'paused' && p3.runs[0].status === 'skipped' && p3.runs[0].reason === 'plan paused' && (await familySlices(bond.id)).length === slices0 + 2,
    'paused: the third date was skipped, nothing bought', `${p3.bought} made, ${p3.skipped} skipped`)
  const resumed = await ok(J, 'POST', `/api/plans/${plan.id}/resume`)
  check(resumed.state === 'active' && resumed.nextPurchase, 'resumed', `next purchase day ${resumed.nextPurchase.day}`)
  const cancelled = await ok(J, 'POST', `/api/plans/${plan.id}/cancel`)
  check(cancelled.state === 'cancelled' && cancelled.grant.state === 'revoked' && !cancelled.nextPurchase, 'cancelled, grant revoked')
  const bal = await balance(jordan)
  await sleep(WEEK_MS + 8000)
  const after = await planById(plan.id)
  check(after.runs.length === 3 && (await familySlices(bond.id)).length === slices0 + 2 && (await balance(jordan)) === bal,
    'a week after cancelling: no more purchases', `${after.bought} made, ${after.skipped} skipped`)
  const otherStudent = await api(as(family), 'POST', `/api/plans/${plan.id}/resume`)
  check(otherStudent.status === 403, 'another student can’t manage Jordan’s plan', otherStudent.data.error)

  console.log('\n== Plan 2: the ZAR rate moves sharply, the purchase is over the grant limit')
  const plan2 = await ok(J, 'POST', '/api/plans', { bondId: bond.id, amount: '182', frequency: 'weekly', holderNode: family.node, holderId: family.id, purchases: '2' })
  const g2 = await ok(J, 'POST', `/api/plans/${plan2.id}/grant`)
  console.log(`  set up at 1 USD = 18.2 ZAR: ≈ ${f(plan2.estimate)} each, grant limit ${f(g2.limits.debitAmount)} per week`)
  await setRate('16')
  console.log('  Cape Town central bank: 1 USD = 16 ZAR')
  const jordanBefore = await balance(jordan)
  const outgoingBefore = (await ok('bank:hbcu', 'GET', '/api/bank/hbcu/activity')).filter((r) => r.from === 'Jordan Ellis').length
  await consent(jordan.node, g2.redirect)
  const q1 = await waitFor(async () => { const p = await planById(plan2.id); return p.runs.length >= 1 && p.runs[0].status !== 'pending' && p }, 'plan 2 purchase 1', 15000)
  const outgoingAfter = (await ok('bank:hbcu', 'GET', '/api/bank/hbcu/activity')).filter((r) => r.from === 'Jordan Ellis').length
  check(q1.runs[0].status === 'skipped' && /over the grant limit/.test(q1.runs[0].reason) && q1.flag && (await balance(jordan)) === jordanBefore && outgoingAfter === outgoingBefore,
    'over-limit purchase skipped and flagged; nothing spent, no payment created', `${q1.runs[0].reason}`)
  console.log(`  flag: ${q1.flag}`)
  await setRate('18.2')
  console.log('  rate back to 1 USD = 18.2 ZAR')
  const q2 = await waitFor(async () => { const p = await planById(plan2.id); return p.runs.length >= 2 && p.runs[0].status !== 'pending' && p }, 'plan 2 purchase 2', WEEK_MS + 15000)
  check(q2.runs[0].status === 'bought' && q2.state === 'completed' && q2.grant.state === 'revoked', 'next week, at 18.2, the purchase goes through; 2 dates done, plan completed, grant revoked',
    `paid ${f(q2.runs[0].debit)}`)
} finally {
  await ok('bank:capetown', 'POST', '/api/bank/capetown/rate', { perUsd: '18.2' })
  await ok('bank:hbcu', 'POST', '/api/clock', { secondsPerDay: originalSpeed })
  if (wasPaused) await ok('bank:hbcu', 'POST', '/api/clock', { paused: true })
  console.log(`\nDemo clock back to 1 day = ${originalSpeed} s${wasPaused ? ', paused' : ''}; ZAR rate 18.2`)
}
console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
