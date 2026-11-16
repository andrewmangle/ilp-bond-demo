// Rhyza rail only: the app converts currencies because Rhyza moves USD only (lib/rails/rhyza/fx.js).
//   node localenv/university-payments/test/rhyza-fx.e2e.mjs      (app running with PAYMENT_RAIL=rhyza, seeded)
// Jordan (HBCU, USD) sends 100.00 USD to Sophie (Hague, EUR); Sophie sends 50.00 EUR back; Jordan buys a
// 100.00 EUR slice of a bond Sophie issues. Each booking must match its quote at the Hague rate (ECB reference).
const BASE = process.env.BASE || 'http://localhost:3040'
let failures = 0
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`) }
async function api(role, method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-acting-as': role }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
async function ok(role, method, path, body) {
  const r = await api(role, method, path, body)
  if (r.status !== 200) throw new Error(`${method} ${path} as ${role}: ${r.status} ${r.data.error}`)
  return r.data
}
const f = (a) => (a ? `${(Number(a.value) / 10 ** a.assetScale).toFixed(a.assetScale)} ${a.assetCode}` : '-')
const v = (a) => BigInt(a.value)

const health = await ok('', 'GET', '/api/demo/health')
if (health.rail !== 'rhyza') throw new Error('This test is for PAYMENT_RAIL=rhyza')
const nodes = await ok('', 'GET', '/api/nodes')
const hague = nodes.find((n) => n.key === 'hague')
if (hague.currency === 'USD') throw new Error('The Hague node is in USD (RHYZA_HAGUE_CURRENCY); nothing to convert')

const rate = await ok('bank:hague', 'GET', '/api/bank/hague/rate')
console.log(`Rate: 1 USD = ${rate.perUsd} ${rate.currency} (${rate.source})`)
check(rate.perUsd > 0, 'Hague has a rate against USD')

const directory = await ok('', 'GET', '/api/directory')
const find = (node, name) => directory.find((x) => x.node === node && x.name === name) ?? (() => { throw new Error(`No ${name} on ${node}; seed the demo`) })()
const jordan = find('hbcu', 'Jordan Ellis'), sophie = find('hague', 'Sophie Janssen')
const as = (a) => `student:${a.node}:${a.id}`
const balance = async (a) => v((await ok(as(a), 'GET', '/api/me')).balance)
check(jordan.assetCode === 'USD' && sophie.assetCode === rate.currency, `Jordan holds USD, Sophie holds ${rate.currency}`)

for (const [who, node, amount] of [[jordan, 'hbcu', '200'], [sophie, 'hague', '200']]) {
  if ((await balance(who)) < 20000n) await ok(`bank:${node}`, 'POST', `/api/bank/${node}/fund`, { accountId: who.id, amount })
}

async function send(from, to, amount, expectReceive) {
  const [fromBefore, toBefore] = [await balance(from), await balance(to)]
  const q = await ok(as(from), 'POST', '/api/quote', { receiverNode: to.node, receiverId: to.id, amount })
  console.log(`\n${from.name} -> ${to.name}: quote ${f(q.debitAmount)} -> ${f(q.receiveAmount)} (${q.rate})`)
  check(v(q.receiveAmount) === expectReceive, `quote converts at the Hague rate`, `expected ${expectReceive}, got ${q.receiveAmount.value}`)
  const p = await ok(as(from), 'POST', '/api/pay', { quoteId: q.quoteId })
  check(p.state === 'COMPLETED', `payment completed`, p.state)
  check(v(p.received) === v(q.receiveAmount) && p.received.assetCode === to.assetCode, `received the quoted ${f(q.receiveAmount)}`, f(p.received))
  check(fromBefore - (await balance(from)) === v(q.debitAmount), `${from.name} debited ${f(q.debitAmount)}`)
  check((await balance(to)) - toBefore === v(q.receiveAmount), `${to.name} credited ${f(q.receiveAmount)}`)
}

const per = rate.perUsd
await send(jordan, sophie, '100', BigInt(Math.floor(10000 * per + 1e-9)))
await send(sophie, jordan, '50', BigInt(Math.floor(5000 / per + 1e-9)))

console.log('\n== Bond in EUR, bought in USD')
const bond = await ok(as(sophie), 'POST', '/api/bonds', { name: `Hague FX Bond ${Date.now() % 1000}`, size: '1000', annualRate: '5', termDays: '365', minSlice: '10', couponFrequency: 'monthly' })
check(bond.currency === rate.currency, `bond is in ${rate.currency}`, bond.currency)
const q = await ok(as(jordan), 'POST', `/api/bonds/${bond.id}/quote`, { amount: '100' })
const usd = Math.ceil(10000 / per - 1e-9)
console.log(`Quote: Jordan pays ${f(q.debitAmount)} for ${f(q.receiveAmount)}`)
check(v(q.receiveAmount) === 10000n && v(q.debitAmount) === BigInt(usd), 'bond quote fixes the EUR face and converts the USD cost', `${q.debitAmount.value} vs ${usd}`)
const bought = await ok(as(jordan), 'POST', '/api/bonds/buy', { quoteId: q.quoteId })
check(bought.state === 'COMPLETED', 'purchase completed', bought.state)
const holdings = await ok(as(jordan), 'GET', '/api/holdings')
const held = (holdings.held ?? holdings).find?.((h) => h.bond?.id === bond.id)
check(held && v(held.amount) === 10000n, 'holding recorded for 100.00 EUR face', held ? f(held.amount) : 'none')

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
