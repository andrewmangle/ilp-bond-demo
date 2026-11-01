// Phase 3 end-to-end test against the running app: node localenv/university-payments/test/coupons.e2e.mjs
// Needs the localenv and the app running, and the Phase 2 bond (test/bonds.e2e.mjs) already sold.
// Runs the demo clock at 1 day = 10 s (put back to 1 minute at the end) and drives three bonds:
// 1. the Phase 2 Cape Solar Bond: Amara approves the grant, 5 demo days of coupons to Sophie (EUR), the Ellis
//    family account (ZAR) and Jordan (USD)
// 2. a small bond whose issuer is drained after the sale: 3 missed coupons, then In Default
// 3. a 10-day bond through to Matured, principal repaid
// "Approving" sends the same requests the bank's consent screen sends when its Approve button is clicked.
import http from 'node:http'

const BASE = process.env.BASE || 'http://localhost:3040'
const IDP_SECRET = '2pEcn2kkCclbOHQiGNEwhJ0rucATZhrA807HTm2rNXE='
const IDP_PORT = { hbcu: 3009, hague: 4009, capetown: 5009 }
const SECONDS_PER_DAY = 10
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

// The issuer clicks Approve grants, then Yes on their bank's consent screen, twice: the app sends the browser
// from the first approval (coupons) straight to the second consent screen (principal)
async function approve(issuer, bondId) {
  let { redirect } = await ok(as(issuer), 'POST', `/api/bonds/${bondId}/grant`)
  const screens = []
  while (redirect && !redirect.startsWith('/')) {
    const start = await get(redirect) // auth server → the bank's consent screen
    const consent = new URL(start.location)
    const [interactId, nonce] = [consent.searchParams.get('interactId'), consent.searchParams.get('nonce')]
    const screen = await fetch(start.location)
    const accept = await fetch(`http://localhost:${IDP_PORT[issuer.node]}/grant/${interactId}/${nonce}/accept`, { method: 'POST', headers: { 'x-idp-secret': IDP_SECRET, 'content-type': 'application/json' }, body: '{}' })
    const finish = await get(`${new URL(redirect).origin}/interact/${interactId}/${nonce}/finish`, start.cookie) // → back to the app
    screens.push({ consentUrl: consent.origin + consent.pathname, screen: screen.status, accept: accept.status, appReturn: finish.location.split('?')[0] })
    redirect = (await get(finish.location)).location // the next consent screen, or back to the Bond Market
  }
  return { screens, landedOn: redirect }
}

const directory = await ok('', 'GET', '/api/directory')
const find = (suffix) => directory.find((x) => x.walletAddress.endsWith(suffix))
const as = (a) => `student:${a.node}:${a.id}`
const [amara, family, jordan, sophie, naledi] = ['/accounts/amara', '/accounts/ellis-family', '/accounts/jordan', '/accounts/sophie', '/accounts/ndlamini'].map(find)
const balance = async (a) => (await ok(as(a), 'GET', '/api/me')).balance
const bondById = async (id) => (await ok('', 'GET', '/api/bonds')).bonds.find((b) => b.id === id)

const { secondsPerDay: originalSpeed, paused: wasPaused } = await ok('', 'GET', '/api/clock')
await ok('bank:hbcu', 'POST', '/api/clock', { paused: false })
await ok('bank:hbcu', 'POST', '/api/clock', { secondsPerDay: SECONDS_PER_DAY })
console.log(`Demo clock: 1 day = ${SECONDS_PER_DAY} s (was ${originalSpeed} s)`)

console.log('\n== Setup')
const fund = async (node, who, amount) => {
  await ok(`bank:${node}`, 'POST', `/api/bank/${node}/mint`, { amount: '100000' })
  await ok(`bank:${node}`, 'POST', `/api/bank/${node}/fund`, { accountId: who.id, amount })
}
await fund('capetown', amara, '500') // pays the Cape Solar Bond's coupons
await fund('hague', sophie, '300')
await fund('hbcu', jordan, '100')

const solar = (await ok('', 'GET', '/api/bonds')).bonds.find((b) => b.name === 'Cape Solar Bond' && b.issuer.name === 'Amara Dube')
const solarApproved = solar?.lifecycle === 'active' // a previous run already approved it
check(solar && (solar.lifecycle === 'awaiting_grant' || solarApproved) && solar.sold.value !== '0',
  solarApproved ? 'Phase 2 bond already Active from an earlier run' : 'Phase 2 bond is waiting for its grant after the first sale', solar && `${solar.name}: ${f(solar.sold)} sold, ${solar.holders} holders`)
const studentRoleCannot = await api(as(sophie), 'POST', `/api/bonds/${solar.id}/grant`)
check(studentRoleCannot.status === 400, 'only the issuer can approve the grant', studentRoleCannot.data.error)
const solarDatesBefore = solar.couponsDone

// Small bond: issued by a new HBCU student, bought by Sophie, then the issuer's account is drained
const dana = (await ok('bank:hbcu', 'POST', '/api/bank/hbcu/accounts', { name: `Dana Drain ${Date.now() % 1000}` })).account
const small = await ok(as(dana), 'POST', '/api/bonds', { name: 'Dana Laptop Bond', size: '100', annualRate: '10', termDays: 30, minSlice: '10', couponFrequency: 'daily' })
const sq = await ok(as(sophie), 'POST', `/api/bonds/${small.id}/quote`, { amount: '100' })
await ok(as(sophie), 'POST', '/api/bonds/buy', { quoteId: sq.quoteId })
console.log(`  ${dana.name} issued ${f(small.size)}; Sophie bought all of it`)

// 10-day bond: Naledi (Cape Town) issues; Jordan and Sophie buy
const note = await ok(as(naledi), 'POST', '/api/bonds', { name: 'Naledi 10-Day Note', size: '1000', annualRate: '12', termDays: 10, minSlice: '100', couponFrequency: 'daily' })
for (const [buyer, amt] of [[jordan, '200'], [sophie, '300']]) {
  const q = await ok(as(buyer), 'POST', `/api/bonds/${note.id}/quote`, { amount: amt })
  await ok(as(buyer), 'POST', '/api/bonds/buy', { quoteId: q.quoteId })
}
console.log(`  ${naledi.name} issued ${f(note.size)}; Jordan bought 200 ZAR, Sophie 300 ZAR`)

console.log('\n== Grants: each issuer approves on their bank’s consent screen')
const before = { sophie: await balance(sophie), family: await balance(family), jordan: await balance(jordan) }
for (const [issuer, bond] of [...(solarApproved ? [] : [[amara, solar]]), [dana, small], [naledi, note]]) {
  const a = await approve(issuer, bond.id)
  const b = await bondById(bond.id)
  const g = b.grant
  check(a.screens.length === 2 && a.screens.every((x) => x.screen === 200 && x.accept === 202) && a.landedOn.startsWith('/bonds?grant=approved') &&
        b.lifecycle === 'active' && g.state === 'approved' && g.coupons.state === 'approved' && g.principal.state === 'approved' &&
        g.coupons.interval.startsWith('R/') && !g.principal.interval,
    `${issuer.name} approved both grants for ${bond.name} on two consent screens`,
    `${a.screens[0].consentUrl}; coupons: ${f(g.coupons.limit)} per ${g.coupons.interval.split('/')[2]} (open-ended); principal: ${f(g.principal.limit)} once; next coupon day ${b.nextCoupon.day}`)
}
console.log('\n== Pause')
await ok('bank:hbcu', 'POST', '/api/clock', { paused: true })
const p0 = { clock: await ok('', 'GET', '/api/clock'), note: await bondById(note.id) }
await sleep(SECONDS_PER_DAY * 2500)
const p1 = { clock: await ok('', 'GET', '/api/clock'), note: await bondById(note.id) }
check(p0.clock.paused && p1.clock.day === p0.clock.day && p1.note.couponsDone === p0.note.couponsDone && p1.note.nextCoupon.paused,
  `paused for ${SECONDS_PER_DAY * 2.5} s (2.5 demo days): the day and the coupons stayed put`, `day ${p1.clock.day}, ${p1.note.couponsDone} coupon dates`)
const studentPause = await api(as(sophie), 'POST', '/api/clock', { paused: false })
check(studentPause.status === 403, 'a student cannot resume the clock')
await ok('bank:hbcu', 'POST', '/api/clock', { paused: false })
console.log('  resumed')

const drained = await ok(as(dana), 'POST', '/api/quote', { receiverNode: jordan.node, receiverId: jordan.id, amount: f(await balance(dana)).split(' ')[0] })
await ok(as(dana), 'POST', '/api/pay', { quoteId: drained.quoteId })
console.log(`  drained ${dana.name}: balance now ${f(await balance(dana))}`)

console.log(`\n== Letting demo days run (${SECONDS_PER_DAY} s each)`)
const startDay = (await ok('', 'GET', '/api/clock')).day
for (let i = 0; i < 40; i++) {
  await sleep(5000)
  const [s, d, n] = await Promise.all([bondById(solar.id), bondById(small.id), bondById(note.id)])
  console.log(`  day ${(await ok('', 'GET', '/api/clock')).day}: solar ${s.couponsDone} dates (${s.couponsPaid} paid) · dana ${d.lifecycleLabel}, ${d.couponsMissed} missed · note ${n.lifecycleLabel}, ${n.couponsDone}/${n.couponDates}`)
  if (s.couponsDone - solarDatesBefore >= 5 && d.lifecycle !== 'active' && n.lifecycle !== 'active') break
}

console.log('\n== Cape Solar Bond after 5 demo days')
const s5 = await bondById(solar.id)
const after = { sophie: await balance(sophie), family: await balance(family), jordan: await balance(jordan) }
const grew = (k) => BigInt(after[k].value) - BigInt(before[k].value)
const hSophie = (await ok(as(sophie), 'GET', '/api/holdings')).held.find((h) => h.bond.id === solar.id)
const hFamily = (await ok(as(family), 'GET', '/api/holdings')).held.find((h) => h.bond.id === solar.id)
const eur = hSophie.coupons.received.find((a) => a.assetCode === 'EUR')
const zar = hFamily.coupons.received.find((a) => a.assetCode === 'ZAR')
console.log(`  this run: Sophie +${f({ ...after.sophie, value: grew('sophie').toString() })} (her balance also moved for her purchases), family +${f({ ...after.family, value: grew('family').toString() })}`)
check(s5.couponsDone - solarDatesBefore >= 5 && s5.couponsMissed === 0 && s5.lifecycle === 'active', '5 more coupon dates ran, none missed', `${s5.couponsDone - solarDatesBefore} dates this run, ${s5.couponsPaid} paid in all, next day ${s5.nextCoupon?.day}`)
check(eur && BigInt(eur.value) > BigInt(0), 'Sophie (Hague) received her coupons in EUR', `${f(eur)} in ${hSophie.coupons.paymentsReceived} payments; carried ${f(hSophie.coupons.carried)}`)
check(zar && BigInt(zar.value) > BigInt(0), 'Ellis Family Savings (Cape Town) received coupons in ZAR', `${f(zar)} in ${hFamily.coupons.paymentsReceived} payments`)
check(grew('family') > BigInt(0), 'the family account’s balance grew from this run’s coupons', `+${f({ ...after.family, value: grew('family').toString() })}`)
console.log(`  grant: used ${f(s5.grant.used)} of ${f(s5.grant.planned)}, ${f(s5.grant.remaining)} left`)

console.log('\n== Dana Laptop Bond (issuer drained)')
const dd = await bondById(small.id)
const hDana = (await ok(as(sophie), 'GET', '/api/holdings')).held.find((h) => h.bond.id === small.id)
check(dd.lifecycle === 'in_default' && dd.couponsMissed >= 3 && dd.grant.state === 'revoked', 'reached In Default after 3 missed coupons; both grants revoked', `${dd.couponsMissed} missed, closed day ${dd.closedDay}`)
check(hDana.bond.lifecycleLabel === 'In Default' && hDana.coupons.carried.value !== '0', 'Sophie sees it In Default, with what she is still owed', `owed ${f(hDana.coupons.carried)}`)
const missedPayments = (await ok('bank:hbcu', 'GET', '/api/bank/hbcu/activity')).filter((r) => r.from === dana.name && r.state === 'CANCELLED')
check(missedPayments.length >= 3, 'each missed coupon was a real payment the issuer’s bank cancelled', `${missedPayments.length} cancelled: ${missedPayments[0]?.error ?? ''}`)

console.log('\n== Naledi 10-Day Note')
const nn = await bondById(note.id)
const hJordan = (await ok(as(jordan), 'GET', '/api/holdings')).held.find((h) => h.bond.id === note.id)
const hSophieNote = (await ok(as(sophie), 'GET', '/api/holdings')).held.find((h) => h.bond.id === note.id)
check(nn.lifecycle === 'matured' && nn.couponsDone === 10 && nn.couponsMissed === 0 && nn.grant.state === 'revoked' && nn.grant.principal.used.value !== '0',
  'matured after 10 days, principal paid under the principal grant, both grants revoked', `matured day ${nn.closedDay}; ${nn.couponsPaid} dates paid`)
check(hJordan.coupons.principalRepaid && hSophieNote.coupons.principalRepaid, 'both holders had their principal repaid',
  `Jordan received ${hJordan.coupons.received.map(f).join(', ')}; Sophie ${hSophieNote.coupons.received.map(f).join(', ')}`)
const usd = hJordan.coupons.received.find((a) => a.assetCode === 'USD')
check(usd && Number(usd.value) >= 1095, 'Jordan got 200 ZAR principal plus interest back in USD (≈ 11 USD)', f(usd))
console.log(`  coupons grant used ${f(nn.grant.coupons.used)} of ${f(nn.grant.coupons.planned)}; principal grant used ${f(nn.grant.principal.used)} of ${f(nn.grant.principal.planned)}`)

await ok('bank:hbcu', 'POST', '/api/clock', { secondsPerDay: originalSpeed })
if (wasPaused) await ok('bank:hbcu', 'POST', '/api/clock', { paused: true })
console.log(`\nDemo clock back to 1 day = ${originalSpeed} s${wasPaused ? ', paused' : ''} (started on day ${startDay})`)
console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
