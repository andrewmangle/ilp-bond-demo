// Phase 2 end-to-end test against the running app: node localenv/university-payments/test/bonds.e2e.mjs
// Needs the localenv and the app running. Mints and funds demo money, issues a bond and buys slices of it.
// Amara (Cape Town) issues 10,000 ZAR at 9% for 365 days; Jordan (HBCU) buys 728 ZAR for the Ellis family
// account on Cape Town; Sophie (Hague) buys 910 ZAR for herself; a buyer without enough money fails cleanly.
const BASE = process.env.BASE || 'http://localhost:3040'
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
const v = (a) => BigInt(a.value)

const directory = await ok('', 'GET', '/api/directory')
const find = (suffix) => {
  const a = directory.find((x) => x.walletAddress.endsWith(suffix))
  if (!a) throw new Error(`No account ${suffix}; restart the mock banks so they seed it`)
  return a
}
const amara = find('/accounts/amara'), family = find('/accounts/ellis-family'), jordan = find('/accounts/jordan'), sophie = find('/accounts/sophie')
const as = (a) => `student:${a.node}:${a.id}`
const balance = async (a) => v((await ok(as(a), 'GET', '/api/me')).balance)

console.log('== Setup: central banks mint and fund the buyers')
for (const [node, who, amt] of [['hbcu', jordan, '100'], ['hague', sophie, '100']]) {
  await ok(`bank:${node}`, 'POST', `/api/bank/${node}/mint`, { amount: '10000' })
  const p = await ok(`bank:${node}`, 'POST', `/api/bank/${node}/fund`, { accountId: who.id, amount: amt })
  console.log(`  ${who.name}: funded ${f(p.received)}, now ${f({ ...p.received, value: (await balance(who)).toString() })}`)
}
const lowFunds = await ok('bank:hague', 'POST', '/api/bank/hague/accounts', { name: `Lee Low-Balance ${Date.now() % 1000}`, initialFunding: '15' })
const lee = { ...lowFunds.account }
console.log(`  ${lee.name} opened on Hague with ${f(lee.balance)}`)

console.log('\n== Issue')
check((await api('bank:capetown', 'POST', '/api/bonds', { name: 'x', size: '1', annualRate: '1', termDays: 1, minSlice: '1' })).status === 403, 'a central bank cannot issue a bond')
const bond = await ok(as(amara), 'POST', '/api/bonds', { name: 'Cape Solar Bond', size: '10000', annualRate: '9', termDays: 365, minSlice: '100', couponFrequency: 'daily' })
check(bond.currency === 'ZAR' && bond.size.value === '1000000' && bond.annualRate === 9 && bond.termDays === 365 && bond.couponFrequency === 'daily' && bond.issuer.name === 'Amara Dube',
  'Amara issued a 10,000 ZAR bond at 9% for 365 days', `${bond.name}, matures ${bond.maturesAt.slice(0, 10)}`)
const listed = () => ok('', 'GET', '/api/bonds').then((m) => m.bonds.find((b) => b.id === bond.id))
check((await listed()).remaining.value === '1000000', 'listed as open with 10,000 ZAR remaining')

console.log('\n== Jordan (HBCU, USD) buys 728 ZAR held by the Ellis family account (Cape Town)')
const [amara0, jordan0] = [await balance(amara), await balance(jordan)]
const q1 = await ok(as(jordan), 'POST', `/api/bonds/${bond.id}/quote`, { amount: '728', holderNode: family.node, holderId: family.id })
console.log(`  quote: pay ${f(q1.debitAmount)}, issuer receives ${f(q1.receiveAmount)} (${q1.rate}); holder ${q1.holder.name}; coupons ≈ ${f(q1.coupons.perCoupon)} ${q1.coupons.frequency}, ${f(q1.coupons.totalInterest)} in all`)
check(q1.debitAmount.assetCode === 'USD' && q1.receiveAmount.value === '72800' && q1.holder.name === 'Ellis Family Savings', 'quote is in the buyer’s currency for 728 ZAR')
check((await listed()).reserved.value === '72800', 'the quoted 728 ZAR is reserved while the quote is open')
const p1 = await ok(as(jordan), 'POST', '/api/bonds/buy', { quoteId: q1.quoteId })
const [amara1, jordan1] = [await balance(amara), await balance(jordan)]
check(p1.state === 'COMPLETED' && p1.outcome?.recorded && jordan0 - jordan1 === v(p1.sent) && amara1 - amara0 === v(p1.received),
  'payment completed, then the holding was recorded', `Jordan paid ${f(p1.sent)}, Amara received ${f(p1.received)}`)

console.log('\n== Sophie (Hague, EUR) buys 910 ZAR for herself')
const q2 = await ok(as(sophie), 'POST', `/api/bonds/${bond.id}/quote`, { amount: '910' })
console.log(`  quote: pay ${f(q2.debitAmount)}, issuer receives ${f(q2.receiveAmount)} (${q2.rate})`)
const p2 = await ok(as(sophie), 'POST', '/api/bonds/buy', { quoteId: q2.quoteId })
check(p2.state === 'COMPLETED' && p2.outcome?.recorded && q2.holder.name === 'Sophie Janssen', 'Sophie’s slice recorded', `paid ${f(p2.sent)}, Amara received ${f(p2.received)}`)
const after2 = await listed()
check(after2.sold.value === '163800' && after2.remaining.value === '836200' && after2.reserved.value === '0' && after2.holders === 2,
  'bond shows 1,638 ZAR sold, 8,362 ZAR remaining, 2 holders', `${f(after2.sold)} sold, ${f(after2.remaining)} left`)

console.log('\n== A buy without enough money fails cleanly and records nothing')
const holdingsBefore = (await ok(as(lee), 'GET', '/api/holdings')).held.length
const tooMuch = await api(as(lee), 'POST', `/api/bonds/${bond.id}/quote`, { amount: '910' })
check(tooMuch.status === 400 && (await listed()).remaining.value === '836200', 'quote refused before any payment', tooMuch.data.error)
// Enough at quote time, but spent before confirming: refused before an outgoing payment is created
const q3 = await ok(as(lee), 'POST', `/api/bonds/${bond.id}/quote`, { amount: '200' })
console.log(`  ${lee.name} quoted ${f(q3.debitAmount)} for 200 ZAR, then sends 10 EUR to Sophie`)
const spend = await ok(as(lee), 'POST', '/api/quote', { receiverNode: sophie.node, receiverId: sophie.id, amount: '10' })
await ok(as(lee), 'POST', '/api/pay', { quoteId: spend.quoteId })
const failed = await api(as(lee), 'POST', '/api/bonds/buy', { quoteId: q3.quoteId })
const after3 = await listed()
check(failed.status === 400 && after3.sold.value === '163800' && after3.remaining.value === '836200' && after3.reserved.value === '0' &&
      (await ok(as(lee), 'GET', '/api/holdings')).held.length === holdingsBefore,
  'confirm refused, no holding, reserved amount released', failed.data.error)

console.log('\n== Rules')
for (const [role, path, body, label] of [
  [as(amara), `/api/bonds/${bond.id}/quote`, { amount: '100' }, 'issuer cannot buy their own bond'],
  [as(jordan), `/api/bonds/${bond.id}/quote`, { amount: '50' }, 'below the minimum slice'],
  [as(jordan), `/api/bonds/${bond.id}/quote`, { amount: '9000' }, 'more than remains'],
  [as(jordan), `/api/bonds/${bond.id}/quote`, { amount: '100', holderNode: amara.node, holderId: amara.id }, 'issuer cannot be the holder']
]) {
  const r = await api(role, 'POST', path, body)
  check(r.status === 400, label, r.data.error)
}
const bondQuote = await ok(as(jordan), 'POST', `/api/bonds/${bond.id}/quote`, { amount: '100' })
const viaPay = await api(as(jordan), 'POST', '/api/pay', { quoteId: bondQuote.quoteId })
check(viaPay.status === 400, 'a bond quote can’t be confirmed as a plain payment', viaPay.data.error)

console.log('\n== Holdings')
const hFamily = await ok(as(family), 'GET', '/api/holdings')
const fh = hFamily.held.find((h) => h.bond.id === bond.id)
check(fh && fh.amount.value === '72800' && fh.amountInOwnCurrency.value === '72800' && fh.buyer.name === 'Jordan Ellis', 'Ellis Family Savings holds 728 ZAR, paid by Jordan', `coupons ≈ ${fh && f(fh.coupons.perCoupon)} ${fh?.coupons.frequency}`)
const hJordan = await ok(as(jordan), 'GET', '/api/holdings')
const jh = hJordan.paidForOthers.find((h) => h.bond.id === bond.id)
check(jh && jh.holder.name === 'Ellis Family Savings' && jh.amountInOwnCurrency.assetCode === 'USD' && hJordan.held.every((h) => h.bond.id !== bond.id),
  'Jordan sees it under “bought for someone else”, not as his own', jh && `${f(jh.amount)} ≈ ${f(jh.amountInOwnCurrency)}, paid ${f(jh.paid)}`)
const hSophie = await ok(as(sophie), 'GET', '/api/holdings')
const sh = hSophie.held.find((h) => h.bond.id === bond.id)
check(sh && sh.amount.value === '91000' && sh.amountInOwnCurrency.assetCode === 'EUR', 'Sophie holds 910 ZAR, shown in EUR too', sh && `${f(sh.amount)} ≈ ${f(sh.amountInOwnCurrency)}`)
const hAmara = await ok(as(amara), 'GET', '/api/holdings')
const ai = hAmara.issued.find((b) => b.id === bond.id)
check(ai && ai.sold.value === '163800' && v(ai.raised) === v(p1.received) + v(p2.received), 'Amara sees her bond: 1,638 ZAR sold', ai && `received ${f(ai.raised)}`)

const ctActivity = await ok('bank:capetown', 'GET', '/api/bank/capetown/activity')
check(ctActivity.filter((r) => r.type === 'bond' && r.to === 'Amara Dube').length >= 2, 'Cape Town central bank sees the bond payments in its activity')

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
