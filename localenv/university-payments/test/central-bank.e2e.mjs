// Phase 1 end-to-end test against the running app: node localenv/university-payments/test/central-bank.e2e.mjs
// Needs the localenv and the app running. Mints, funds and sends real (local) money, and changes the ZAR rate
// (19, then 17, back to 18.2), so do not run it during a demo. Takes about 3 minutes.
const BASE = 'http://localhost:3040'
let failures = 0
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`) }
async function api(role, method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-acting-as': role }, body: body && JSON.stringify(body) })
  const data = await res.json()
  return { status: res.status, data }
}
async function ok(role, method, path, body) {
  const r = await api(role, method, path, body)
  if (r.status !== 200) throw new Error(`${method} ${path} as ${role}: ${r.status} ${r.data.error}`)
  return r.data
}
const f = (a) => a ? `${(Number(a.value) / 10 ** a.assetScale).toFixed(a.assetScale)} ${a.assetCode}` : '—'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const nodes = await ok('', 'GET', '/api/nodes')
const directory = await ok('', 'GET', '/api/directory')
const studentOn = { hbcu: directory.find((a) => a.walletAddress.endsWith('/accounts/jordan')), hague: directory.find((a) => a.walletAddress.endsWith('/accounts/lars')), capetown: directory.find((a) => a.walletAddress.endsWith('/accounts/tnkosi')) }

console.log('\n== Mint on each node')
for (const n of nodes) {
  const before = await ok(`bank:${n.key}`, 'GET', `/api/bank/${n.key}/overview`)
  const r = await ok(`bank:${n.key}`, 'POST', `/api/bank/${n.key}/mint`, { amount: '50000' })
  const after = await ok(`bank:${n.key}`, 'GET', `/api/bank/${n.key}/overview`)
  const grew = (o) => BigInt(o.value)
  check(grew(after.moneySupply[0]) - grew(before.moneySupply[0]) === BigInt(5000000) &&
        BigInt(after.treasury.balance.value) - BigInt(before.treasury.balance.value) === BigInt(5000000) &&
        BigInt(after.rafikiLiquidity.value) - BigInt(before.rafikiLiquidity.value) === BigInt(5000000),
    `${n.bankName} minted ${f(r.minted)}`, `supply ${f(before.moneySupply[0])} → ${f(after.moneySupply[0])}, treasury → ${f(after.treasury.balance)}, Rafiki liquidity → ${f(after.rafikiLiquidity)}`)
}

console.log('\n== Fund one student per node')
for (const n of nodes) {
  const s = studentOn[n.key]
  const before = (await ok(`bank:${n.key}`, 'GET', `/api/bank/${n.key}/accounts`)).find((a) => a.id === s.id)
  const p = await ok(`bank:${n.key}`, 'POST', `/api/bank/${n.key}/fund`, { accountId: s.id, amount: '1000' })
  const after = (await ok(`bank:${n.key}`, 'GET', `/api/bank/${n.key}/accounts`)).find((a) => a.id === s.id)
  check(p.state === 'COMPLETED' && BigInt(after.balance.value) - BigInt(before.balance.value) === BigInt(100000),
    `${n.bankName} funded ${s.name}`, `${p.state}, treasury sent ${f(p.sent)}, ${s.name} ${f(before.balance)} → ${f(after.balance)}`)
}

console.log('\n== Open a student account with initial funding')
const opened = await ok('bank:hague', 'POST', '/api/bank/hague/accounts', { name: `Sanne Bakker ${Date.now() % 1000}`, initialFunding: '250' })
check(opened.account.balance.value === '25000' && opened.funding?.state === 'COMPLETED', `opened ${opened.account.name}`, `${f(opened.account.balance)} at ${opened.account.walletAddress}`)

console.log('\n== Roles')
const jordanRole = `student:hbcu:${studentOn.hbcu.id}`
for (const [role, method, path, body, want, label] of [
  [jordanRole, 'POST', '/api/bank/hbcu/mint', { amount: '1' }, 403, 'student cannot mint'],
  [jordanRole, 'GET', '/api/bank/hbcu/overview', undefined, 403, 'student cannot see central-bank overview'],
  [jordanRole, 'POST', '/api/bank/capetown/rate', { perUsd: '1' }, 403, 'student cannot set a rate'],
  ['bank:hbcu', 'POST', '/api/bank/hague/fund', { accountId: studentOn.hague.id, amount: '1' }, 403, 'HBCU central bank cannot fund on Hague'],
  ['bank:hbcu', 'GET', '/api/bank/capetown/activity', undefined, 403, "HBCU central bank cannot see Cape Town's activity"],
  ['bank:hbcu', 'POST', '/api/quote', { receiverNode: 'capetown', receiverId: studentOn.capetown.id, amount: '1' }, 403, 'central bank cannot send as a student'],
  ['', 'POST', '/api/bank/hbcu/mint', { amount: '1' }, 403, 'no role cannot mint'],
  ['bank:hbcu', 'POST', '/api/bank/hbcu/rate', { perUsd: '2' }, 400, 'USD rate cannot be changed']
]) {
  const r = await api(role, method, path, body)
  check(r.status === want, label, `${r.status} ${r.data.error ?? ''}`)
}

console.log('\n== Exchange rate: ZAR 18.2 → 19 → 18.2')
const quoteJordanToThabo = () => ok(jordanRole, 'POST', '/api/quote', { receiverNode: 'capetown', receiverId: studentOn.capetown.id, amount: '10' })
const ratio = (q) => Number(q.receiveAmount.value) / Number(q.debitAmount.value)
const start = await ok('bank:capetown', 'GET', '/api/bank/capetown/rate')
check(start.perUsd === 18.2, 'Cape Town starts at 18.2', `1 USD = ${start.perUsd} ZAR`)
const thabo = async () => BigInt((await ok('bank:capetown', 'GET', '/api/bank/capetown/accounts')).find((a) => a.id === studentOn.capetown.id).balance.value)
const jordan = async () => BigInt((await ok(jordanRole, 'GET', '/api/me')).balance.value)
const payAndMeasure = async (q) => {
  const [t0, j0] = [await thabo(), await jordan()]
  const p = await ok(jordanRole, 'POST', '/api/pay', { quoteId: q.quoteId })
  return { p, credited: (await thabo()) - t0, charged: j0 - (await jordan()) }
}
const zar = (v) => f({ value: v.toString(), assetCode: 'ZAR', assetScale: 2 })
const usd = (v) => f({ value: v.toString(), assetCode: 'USD', assetScale: 2 })

// Control: the same quote paid at 18.2
const control = await payAndMeasure(await quoteJordanToThabo())
console.log(`  control at 18.2: Jordan charged ${usd(control.charged)}, Thabo credited ${zar(control.credited)}`)
const oldQuote = await quoteJordanToThabo()
console.log(`  quote before change: ${f(oldQuote.debitAmount)} → ${f(oldQuote.receiveAmount)} (${oldQuote.rate}), fails below ${f(oldQuote.minReceiveAmount)}`)

const set19 = await ok('bank:capetown', 'POST', '/api/bank/capetown/rate', { perUsd: '19' })
const tables = await Promise.all(['3030', '3031', '3032'].map(async (p) => (await (await fetch(`http://localhost:${p}/rates?base=USD`)).json()).rates.ZAR))
check(tables.every((r) => r === 19), 'all three mock banks now serve USD→ZAR 19', tables.join(', '))
const zarRates = (await (await fetch('http://localhost:3032/rates?base=ZAR')).json()).rates
check(Math.abs(zarRates.USD - 1 / 19) < 1e-12 && Math.abs(zarRates.EUR - 0.92 / 19) < 1e-12, 'Cape Town derived ZAR→USD and ZAR→EUR', JSON.stringify(zarRates))
console.log(`  waiting for Rafiki's rate cache (until ${set19.effectiveBy})`)
await sleep(Math.max(0, new Date(set19.effectiveBy) - Date.now()) + 1500)
const newQuote = await quoteJordanToThabo()
console.log(`  quote after change:  ${f(newQuote.debitAmount)} → ${f(newQuote.receiveAmount)} (${newQuote.rate})`)
const scale = ratio(newQuote) / ratio(oldQuote)
check(Math.abs(scale - 19 / 18.2) < 0.002, 'new quote uses the new rate', `receive/debit grew ×${scale.toFixed(5)}, expected ×${(19 / 18.2).toFixed(5)}`)

const old = await payAndMeasure(oldQuote)
const growth = Number(old.credited) / Number(control.credited)
check(old.p.state === 'COMPLETED' && old.charged === control.charged && Math.abs(growth - 19 / 18.2) < 0.003,
  'payment quoted at 18.2 charges the sender the quoted amount; receiver gets the new-rate amount',
  `Jordan charged ${usd(old.charged)} (control ${usd(control.charged)}), Thabo credited ${zar(old.credited)} vs quoted ${f(oldQuote.receiveAmount)} (×${growth.toFixed(4)})`)

// A rate more than 1% worse than the quote: Rafiki retries, then fails the payment rather than deliver less
const worseQuote = await quoteJordanToThabo()
const set17 = await ok('bank:capetown', 'POST', '/api/bank/capetown/rate', { perUsd: '17' })
await sleep(Math.max(0, new Date(set17.effectiveBy) - Date.now()) + 1500)
const [t0, j0] = [await thabo(), await jordan()]
const worse = await ok(jordanRole, 'POST', '/api/pay', { quoteId: worseQuote.quoteId })
check(worse.state === 'SENDING' && worse.retrying && (await jordan()) === j0 && (await thabo()) === t0,
  'payment quoted at 19, confirmed at 17: Rafiki retries, nothing charged', `${worse.state}, retrying ${worse.retrying}`)

const back = await ok('bank:capetown', 'POST', '/api/bank/capetown/rate', { perUsd: '18.2' })
await sleep(Math.max(0, new Date(back.effectiveBy) - Date.now()) + 1500)
const restored = await quoteJordanToThabo()
check(Math.abs(ratio(restored) / ratio(oldQuote) - 1) < 0.002 && (await ok('bank:capetown', 'GET', '/api/bank/capetown/rate')).perUsd === 18.2,
  'rate back to 18.2 and quotes match the original', `${f(restored.debitAmount)} → ${f(restored.receiveAmount)}`)

console.log('  waiting for Rafiki to give up on the worse-rate payment (18.2 is still below its minimum)')
let worseRow
for (let i = 0; i < 60; i++) {
  worseRow = (await ok('bank:hbcu', 'GET', '/api/bank/hbcu/activity')).find((r) => r.paymentId === worse.id)
  if (worseRow?.state !== 'SENDING') break
  await sleep(5000)
}
// Jordan may receive bond coupons meanwhile, so check he wasn't charged rather than that nothing changed
check(worseRow?.state === 'FAILED' && (await jordan()) >= j0 && (await thabo()) === t0,
  'worse-rate payment ends FAILED and moved no money', `${worseRow?.state} (${worseRow?.error}); Jordan ${usd(j0)} → ${usd(await jordan())}`)
const paidOld = old.p

console.log('\n== Activity')
for (const n of nodes) {
  const rows = await ok(`bank:${n.key}`, 'GET', `/api/bank/${n.key}/activity`)
  const sorted = rows.every((r, i) => i === 0 || rows[i - 1].at >= r.at)
  const types = [...new Set(rows.map((r) => r.type))]
  check(sorted && types.includes('mint') && types.includes('funding'), `${n.label} activity newest first with mint and funding`, `${rows.length} rows; types ${types.join(', ')}`)
  for (const r of rows.slice(0, 4)) console.log(`    ${r.at.slice(11, 19)} ${r.type.padEnd(8)} ${r.direction.padEnd(6)} ${r.from} → ${r.to}: sent ${f(r.sent)}, received ${f(r.received)} [${r.state}]`)
}
const ctRows = await ok('bank:capetown', 'GET', '/api/bank/capetown/activity')
const hbcuRows = await ok('bank:hbcu', 'GET', '/api/bank/hbcu/activity')
check(ctRows.some((r) => r.paymentId && r.direction === 'in' && r.from === studentOn.hbcu.name && r.sent && r.received) &&
      hbcuRows.some((r) => r.paymentId === paidOld.id && r.direction === 'out' && r.received),
  "cross-node payment shows on both nodes with sent and received", '')

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
