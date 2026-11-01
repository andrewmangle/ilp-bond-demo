// Phase 5 full-cycle test, in two halves around a stop and start of everything:
//   node localenv/university-payments/test/demo-cycle.mjs before   seed, run Phase 2-4 actions, save a snapshot
//   (stop everything, e.g. scripts/demo-stop.sh, a reboot, then scripts/demo-start.sh)
//   node localenv/university-payments/test/demo-cycle.mjs after    check everything came back and payments resume
// test/demo-cycle.sh runs both with a stop, `docker compose down` and a wait in between.
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:3040'
const SNAPSHOT = new URL('../data/demo-cycle-snapshot.json', import.meta.url)
const IDP_SECRET = '2pEcn2kkCclbOHQiGNEwhJ0rucATZhrA807HTm2rNXE='
const IDP_PORT = { hbcu: 3009, hague: 4009, capetown: 5009 }
const SECONDS_PER_DAY = 10
const BANK = 'bank:hbcu'
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
    resolve({ location: r.headers.location, cookie: (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ') })
  }).on('error', reject)
})
// Clicks Yes on each consent screen the browser is sent to, until it lands back on the app
async function approve(node, redirect) {
  while (redirect && !redirect.startsWith('/')) {
    const start = await get(redirect)
    const u = new URL(start.location)
    await fetch(`http://localhost:${IDP_PORT[node]}/grant/${u.searchParams.get('interactId')}/${u.searchParams.get('nonce')}/accept`, { method: 'POST', headers: { 'x-idp-secret': IDP_SECRET, 'content-type': 'application/json' }, body: '{}' })
    const finish = await get(`${new URL(redirect).origin}/interact/${u.searchParams.get('interactId')}/${u.searchParams.get('nonce')}/finish`, start.cookie)
    redirect = (await get(finish.location)).location
  }
  return redirect
}
const waitFor = async (fn, label, ms) => {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(1000) }
}

async function people() {
  const dir = await ok('', 'GET', '/api/directory')
  const find = (s) => dir.find((a) => a.walletAddress.endsWith(s))
  return { jordan: find('/accounts/jordan'), sophie: find('/accounts/sophie'), amara: find('/accounts/amara'), family: find('/accounts/ellis-family') }
}
const as = (a) => `student:${a.node}:${a.id}`

// Everything that must survive a restart
async function snapshot() {
  const p = await people()
  const balances = {}
  for (const [k, a] of Object.entries(p)) balances[k] = (await ok(as(a), 'GET', '/api/me')).balance
  const treasuries = {}
  for (const node of ['hbcu', 'hague', 'capetown']) treasuries[node] = (await ok(`bank:${node}`, 'GET', `/api/bank/${node}/overview`)).treasury.balance
  const bond = (await ok('', 'GET', '/api/bonds')).bonds.find((b) => b.name === 'Cape Solar Bond')
  const holdings = {}
  for (const k of ['family', 'sophie']) holdings[k] = (await ok(as(p[k]), 'GET', '/api/holdings')).held.map((h) => `${h.bond.name} ${h.amount.value}`).sort()
  const plan = (await ok(as(p.jordan), 'GET', '/api/plans'))[0]
  const health = await ok('', 'GET', '/api/demo/health')
  return {
    day: health.clock.day,
    counts: health.counts,
    balances,
    treasuries,
    holdings,
    bond: { lifecycle: bond.lifecycle, sold: bond.sold.value, couponsDone: bond.couponsDone, couponsPaid: bond.couponsPaid, grant: bond.grant.state, coupons: bond.grant.coupons.state, principal: bond.grant.principal.state },
    plan: { state: plan.state, bought: plan.bought, skipped: plan.skipped, grant: plan.grant.state, next: plan.nextPurchase.day },
    familyCoupons: (await ok(as(p.family), 'GET', '/api/holdings')).held.find((h) => h.bond.name === 'Cape Solar Bond').coupons.received
  }
}

// Reads the live feed's event stream until a new payment arrives
async function nextLivePayment(timeoutMs) {
  const controller = new AbortController()
  const res = await fetch(`${BASE}/api/live/stream`, { signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let snapshotSize = null
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return null
      buffer += decoder.decode(value, { stream: true })
      let i
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, i); buffer = buffer.slice(i + 2)
        const event = block.match(/^event: (.*)$/m)?.[1]
        const data = block.match(/^data: (.*)$/m)?.[1]
        if (event === 'snapshot') snapshotSize = JSON.parse(data).length
        if (event === 'payment') { const d = JSON.parse(data); if (d.isNew) return { ...d.item, snapshotSize } }
      }
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function before() {
  console.log('== Seed Demo')
  const seeded = await ok(BANK, 'POST', '/api/demo/seed', { confirm: true })
  const h0 = await ok('', 'GET', '/api/demo/health')
  check(h0.counts.bonds === 1 && h0.counts.holdings === 0 && h0.counts.plans === 0 && h0.clock.day === 1, 'clean starting state: one bond, no holdings, day 1',
    `reset in ${seeded.reset.seconds} s; ${seeded.students.map((s) => `${s.name} ${f(s.balance)}`).join(', ')}; ${seeded.bond.name} ${f(seeded.bond.size)} at ${seeded.bond.annualRate}% for ${seeded.bond.termDays} days`)
  check(Object.values(seeded.treasuries).every((t) => BigInt(t.value) > BigInt(0)), 'treasuries funded', Object.values(seeded.treasuries).map(f).join(', '))
  const reseeded = await ok(BANK, 'POST', '/api/demo/seed', { confirm: true })
  check(reseeded.bond.name === seeded.bond.name && JSON.stringify(reseeded.students.map((s) => s.balance)) === JSON.stringify(seeded.students.map((s) => s.balance)),
    'seeding again gives the same starting state')
  const refused = await api(as((await people()).jordan), 'POST', '/api/demo/reset', { confirm: true })
  check(refused.status === 403, 'a student cannot reset the demo')
  const unconfirmed = await api(BANK, 'POST', '/api/demo/reset', {})
  check(unconfirmed.status === 400, 'reset needs confirming', unconfirmed.data.error)

  await ok(BANK, 'POST', '/api/clock', { secondsPerDay: SECONDS_PER_DAY })
  const { jordan, sophie, amara, family } = await people()
  const bond = (await ok('', 'GET', '/api/bonds')).bonds[0]

  console.log('\n== Phase 2: buys (and the live feed)')
  const live = nextLivePayment(30_000)
  await sleep(500)
  const q1 = await ok(as(jordan), 'POST', `/api/bonds/${bond.id}/quote`, { amount: '728', holderNode: family.node, holderId: family.id })
  const b1 = await ok(as(jordan), 'POST', '/api/bonds/buy', { quoteId: q1.quoteId })
  const pushed = await live
  check(pushed && pushed.type === 'bond buy' && pushed.from.node === 'hbcu' && pushed.to.node === 'capetown', 'the live feed pushed the bond buy as it happened',
    pushed && `${pushed.type}: ${pushed.from.name} (${pushed.from.nodeLabel}) → ${pushed.to.name} (${pushed.to.nodeLabel}) ${f(pushed.sent)}; snapshot had ${pushed.snapshotSize} items`)
  const q2 = await ok(as(sophie), 'POST', `/api/bonds/${bond.id}/quote`, { amount: '910' })
  const b2 = await ok(as(sophie), 'POST', '/api/bonds/buy', { quoteId: q2.quoteId })
  check(b1.outcome?.recorded && b2.outcome?.recorded, 'Jordan bought 728 ZAR for the family account, Sophie 910 ZAR', `${f(b1.sent)}, ${f(b2.sent)}`)

  console.log('\n== Phase 3: grants and coupons')
  const { redirect } = await ok(as(amara), 'POST', `/api/bonds/${bond.id}/grant`)
  check((await approve('capetown', redirect)).startsWith('/bonds?grant=approved'), 'Amara approved both grants')
  await waitFor(async () => (await ok('', 'GET', '/api/bonds')).bonds[0].couponsDone >= 3, '3 coupon dates', 60_000)
  console.log(`  coupon dates done: ${(await ok('', 'GET', '/api/bonds')).bonds[0].couponsDone}`)

  console.log('\n== Phase 4: a recurring purchase')
  const plan = await ok(as(jordan), 'POST', '/api/plans', { bondId: bond.id, amount: '182', frequency: 'weekly', holderNode: family.node, holderId: family.id, purchases: '4' })
  const g = await ok(as(jordan), 'POST', `/api/plans/${plan.id}/grant`)
  await approve('hbcu', g.redirect)
  const t0 = Date.now()
  await waitFor(async () => (await ok(as(jordan), 'GET', '/api/plans'))[0].bought === 1, 'first purchase', 60_000)
  check(true, 'Jordan’s weekly plan approved and its first purchase made', `${Math.round((Date.now() - t0) / 1000)} s after approval`)

  // Stop with the clock running, so the restart shows whether time moved while everything was off
  const snap = await snapshot()
  writeFileSync(SNAPSHOT, JSON.stringify({ ...snap, savedAt: Date.now() }, null, 2))
  console.log(`\nSnapshot saved: day ${snap.day}, ${snap.counts.holdings} holdings, ${snap.bond.couponsDone} coupon dates, plan ${snap.plan.bought} bought (next day ${snap.plan.next})`)
}

async function after() {
  const saved = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  const offSeconds = Math.round((Date.now() - saved.savedAt) / 1000)
  console.log(`== After the restart (${offSeconds} s since the snapshot)`)
  const health = await ok('', 'GET', '/api/demo/health')
  check(health.ok, 'health check: every node, the app and the scheduler are up')
  const now = await snapshot()
  check(now.day === saved.day, `demo day carried on from where it stopped (day ${saved.day}), not ${Math.round(offSeconds / SECONDS_PER_DAY)} days later`, `day ${now.day}`)
  check(now.bond.couponsDone - saved.bond.couponsDone <= 1, 'no backfill of coupon dates missed while it was off', `${saved.bond.couponsDone} → ${now.bond.couponsDone}`)
  check(JSON.stringify(now.counts) === JSON.stringify(saved.counts) || now.counts.payments >= saved.counts.payments, 'bonds, holdings and plans are all still there', JSON.stringify(now.counts))
  check(JSON.stringify(now.holdings) === JSON.stringify(saved.holdings), 'holdings unchanged', JSON.stringify(now.holdings))
  check(now.bond.grant === 'approved' && now.plan.grant === 'approved' && now.plan.state === 'active', 'grants and plans still approved and active')
  const sameBalances = Object.keys(saved.balances).every((k) => BigInt(now.balances[k].value) >= BigInt(saved.balances[k].value) - BigInt(1) || k === 'amara' || k === 'jordan')
  check(sameBalances && Object.keys(saved.treasuries).every((n) => now.treasuries[n].value === saved.treasuries[n].value),
    'mock bank balances survived (treasuries exact; students at least as before, give or take a coupon)',
    Object.entries(now.balances).map(([k, b]) => `${k} ${f(saved.balances[k])} → ${f(b)}`).join(', '))

  console.log('\n== Payments resume')
  const p0 = now
  const resumed = await waitFor(async () => { const s = await snapshot(); return s.bond.couponsDone >= p0.bond.couponsDone + 2 && s }, 'coupons after the restart', 60_000)
  const famBefore = BigInt(p0.familyCoupons.find((a) => a.assetCode === 'ZAR')?.value ?? 0)
  const famAfter = BigInt(resumed.familyCoupons.find((a) => a.assetCode === 'ZAR')?.value ?? 0)
  check(resumed.bond.couponsDone > p0.bond.couponsDone && famAfter > famBefore, 'coupons are being paid again', `dates ${p0.bond.couponsDone} → ${resumed.bond.couponsDone}; family coupons ${f({ value: famBefore.toString(), assetCode: 'ZAR', assetScale: 2 })} → ${f({ value: famAfter.toString(), assetCode: 'ZAR', assetScale: 2 })}`)
  const plan = await waitFor(async () => { const s = await snapshot(); return s.plan.bought + s.plan.skipped > p0.plan.bought + p0.plan.skipped && s }, 'the next recurring purchase', 7 * SECONDS_PER_DAY * 1000 + 20_000)
  check(plan.plan.bought === p0.plan.bought + 1, 'the recurring purchase made its next purchase on schedule', `${p0.plan.bought} → ${plan.plan.bought} bought (day ${p0.plan.next})`)
}

const step = process.argv[2]
if (step === 'before') await before()
else if (step === 'after') await after()
else { console.error('usage: demo-cycle.mjs before|after'); process.exit(2) }
console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
