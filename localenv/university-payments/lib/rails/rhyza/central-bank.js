// Central-bank actions on the Rhyza rail. Same exports as the Rafiki rail's central-bank.js.
//
// Differences that come from Rhyza:
//   - Rhyza has no asset liquidity, only peer liquidity. Minting books the money to the treasury in the app's
//     ledger and deposits the same value (in the peering asset) as liquidity on each of the node's peers, so
//     the money supply and the capacity to pay every other node grow together.
//   - Rhyza has no read of a peer's liquidity. The overview shows what has been deposited (the playground seed
//     plus mints), not what is left after payments.
//   - Activity comes from GET /payments and GET /payment-intents on the node, joined to the app's records.

const { randomUUID } = require('crypto')
const { NODES } = require('./nodes')
const { admin, appState, toScale, config, SCALE } = require('./rhyza')
const bank = require('./mock-bank')
const payments = require('./payments')
const fx = require('./fx')
const { db, now } = require('../../db')
const { demoEpoch } = require('../../maintenance')
const { UserError, toMinorUnits } = require('../../money')

const parse = (json) => (json ? JSON.parse(json) : null)

async function getAsset(nodeKey) {
  const node = NODES[nodeKey]
  const { assets } = await admin(nodeKey).listAssets()
  if (!assets.find((a) => a.code === node.railCurrency)) throw new Error(`${node.label} has no ${node.railCurrency} asset (run node rhyza/seed.mjs)`)
  // The node's own currency lives in the app's ledger; Rhyza carries it as railCurrency (fx.js)
  return { id: node.currency, code: node.currency, scale: SCALE }
}

// Liquidity this app knows was deposited on one of the node's peers: the playground seed and every mint since
function depositedPeerLiquidity(nodeKey) {
  const minted = db.prepare('SELECT amount FROM mints WHERE node = ?').all(nodeKey)
    .reduce((sum, m) => sum + BigInt(parse(m.amount).peerDeposit ?? 0), BigInt(0)) // deposited on every peer
  return { value: (BigInt(config.PEER_LIQUIDITY) + minted).toString(), assetCode: config.ASSET, assetScale: SCALE }
}

// --- Treasury and money supply ---

async function overview(nodeKey) {
  const node = NODES[nodeKey]
  const [accounts, rate] = await Promise.all([bank.listNodeAccounts(nodeKey), getRate(nodeKey)])
  await getAsset(nodeKey) // fails clearly if the node isn't seeded

  const supply = {}
  for (const a of accounts) {
    supply[a.assetCode] ??= { value: BigInt(0), assetCode: a.assetCode, assetScale: a.assetScale, accounts: 0 }
    supply[a.assetCode].value += BigInt(a.balance)
    supply[a.assetCode].accounts++
  }
  const treasury = accounts.find((a) => a.isTreasury) ?? null
  const totalMinted = db.prepare('SELECT amount FROM mints WHERE node = ?').all(nodeKey)
    .reduce((sum, m) => sum + BigInt(parse(m.amount).value), BigInt(0))

  return {
    node: nodeKey,
    label: node.label,
    bankName: node.bankName,
    currency: node.currency,
    moneySupply: Object.values(supply)
      .sort((a, b) => (a.assetCode === node.currency ? -1 : b.assetCode === node.currency ? 1 : 0))
      .map((s) => ({ ...s, value: s.value.toString() })),
    treasury: treasury && {
      id: treasury.id,
      name: treasury.name,
      walletAddress: treasury.walletAddress,
      balance: { value: treasury.balance, assetCode: treasury.assetCode, assetScale: treasury.assetScale }
    },
    // The page's "Rafiki liquidity" line: on Rhyza, the total minted on this node
    rafikiLiquidity: { value: totalMinted.toString(), assetCode: node.currency, assetScale: SCALE },
    peerLiquidity: Object.keys(node.peers).map((key) => ({ peer: NODES[key].ilpAddress, liquidity: depositedPeerLiquidity(nodeKey) })),
    rate
  }
}

// Value of an amount in the peering asset, at the stored rates
async function inPeeringAsset(value, currency) {
  if (currency === config.ASSET) return BigInt(value)
  const perUsd = { USD: 1, ...(await bank.getUsdRates()) }
  return BigInt(Math.floor((Number(value) * perUsd[config.ASSET]) / perUsd[currency]))
}

async function mint(nodeKey, amount) {
  const node = NODES[nodeKey]
  const asset = await getAsset(nodeKey)
  const treasury = await bank.findTreasury(nodeKey)
  const value = toMinorUnits(amount, asset.scale)
  const peerDeposit = await inPeeringAsset(value, asset.code)

  const id = randomUUID()
  for (const peerId of Object.values(node.peers)) await admin(nodeKey).depositLiquidity(peerId, config.ASSET, Number(peerDeposit), SCALE)
  bank.adjust(treasury.id, value)
  const minted = { value, assetCode: asset.code, assetScale: asset.scale }
  db.prepare(`INSERT INTO mints (id, node, treasury_account, treasury_name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, nodeKey, treasury.id, treasury.name, JSON.stringify({ ...minted, peerDeposit: peerDeposit.toString() }), now())

  const after = await bank.findTreasury(nodeKey)
  return { id, minted, treasuryBalance: { value: after.balance, assetCode: after.assetCode, assetScale: after.assetScale } }
}

// --- Students ---

async function listStudents(nodeKey) {
  return (await bank.listNodeAccounts(nodeKey)).filter((a) => !a.isTreasury)
}

async function fundStudent(nodeKey, accountId, amount) {
  const treasury = await bank.findTreasury(nodeKey)
  const student = await bank.findAccount(nodeKey, accountId)
  if (student.isTreasury) throw new UserError('Pick a student account')
  if (student.assetCode !== treasury.assetCode) {
    throw new UserError(`${student.name} holds ${student.assetCode}; the treasury can only fund ${treasury.assetCode} accounts`)
  }
  return payments.quoteAndPay({
    type: 'funding',
    sender: treasury,
    receiver: student,
    receiveAmount: { value: toMinorUnits(amount, SCALE), assetCode: student.assetCode, assetScale: student.assetScale }
  })
}

async function openStudentAccount(nodeKey, name, initialFunding) {
  name = String(name ?? '').trim()
  if (!name) throw new UserError('Enter a name')
  const fundingRequested = String(initialFunding ?? '').trim() !== '' && Number(initialFunding) !== 0
  if (fundingRequested) toMinorUnits(initialFunding, SCALE)
  const asset = await getAsset(nodeKey)
  const account = await bank.createAccount(nodeKey, asset.id, name)
  const funding = fundingRequested ? await fundStudent(nodeKey, account.id, initialFunding) : null
  return { account: await bank.findAccount(nodeKey, account.id), funding }
}

// --- Exchange rate against USD, used by the app to convert (fx.js); Rhyza moves USD only ---

async function getRate(nodeKey) {
  const { currency } = NODES[nodeKey]
  if (currency === 'USD') return { currency, perUsd: 1, editable: false }
  const rate = fx.ratesWithSource()[currency]
  return { currency, perUsd: rate?.perUsd ?? null, editable: true, source: rate?.source ?? null }
}

async function setRate(nodeKey, perUsdInput) {
  const { currency } = NODES[nodeKey]
  if (currency === 'USD') throw new UserError('USD is the base currency of the network; its rate is always 1')
  const perUsd = Number(perUsdInput)
  if (!/^\d+(\.\d+)?$/.test(String(perUsdInput).trim()) || !(perUsd > 0)) throw new UserError(`Enter how many ${currency} one USD buys, e.g. 0.92`)
  const { perUsd: oldPerUsd } = await getRate(nodeKey)
  const at = now()
  db.prepare(
    `INSERT INTO rates (currency, node, per_usd, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (currency) DO UPDATE SET node = excluded.node, per_usd = excluded.per_usd, updated_at = excluded.updated_at`
  ).run(currency, nodeKey, perUsd, at)
  db.prepare(`INSERT INTO rate_changes (node, currency, old_per_usd, new_per_usd, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(nodeKey, currency, oldPerUsd, perUsd, at)
  return { currency, oldPerUsd, perUsd, effectiveBy: at }
}

// Called every 30 s by server.js: refreshes the ECB reference rates when they are 6 hours old
async function syncRates() {
  await fx.refreshMarketRates()
}

function rateHistory(nodeKey) {
  return db.prepare('SELECT currency, old_per_usd AS oldPerUsd, new_per_usd AS perUsd, created_at AS at FROM rate_changes WHERE node = ? ORDER BY id DESC LIMIT 10').all(nodeKey)
}

// --- Activity ---

const ACTIVITY_LIMIT = 100

async function activity(nodeKey) {
  const a = admin(nodeKey)
  const [accounts, { result: outgoing }, { result: intents }] = await Promise.all([
    bank.listAccounts(),
    a.listPayments({ first: ACTIVITY_LIMIT, sortOrder: 'desc' }),
    a.listPaymentIntents({ first: ACTIVITY_LIMIT, sortOrder: 'desc' })
  ])
  const local = accounts.filter((acc) => acc.node === nodeKey)
  const localByWallet = new Map(local.map((acc) => [acc.walletAddress, acc]))
  const nameByWallet = new Map(accounts.map((acc) => [acc.walletAddress, acc.name]))
  const paymentRow = (id) => db.prepare('SELECT * FROM payments WHERE id = ?').get(id)
  const byReceiverIntent = (id) =>
    db.prepare('SELECT p.* FROM payments p JOIN rhyza_payments r ON r.id = p.id WHERE r.receiver_intent_id = ?').get(id)

  // Only intents for this node's own accounts: quoting another node's intent leaves a copy on the sender's node
  const localIntents = new Map(intents.filter((i) => localByWallet.has(i.walletAddress)).map((i) => [i.id, i]))
  const rows = []

  for (const o of outgoing) {
    const r = paymentRow(o.id)
    const rp = db.prepare('SELECT * FROM rhyza_payments WHERE id = ?').get(o.id)
    const within = rp && rp.receiver_node === nodeKey
    const localIntent = within ? localIntents.get(rp.receiver_intent_id) : null
    if (within) localIntents.delete(rp.receiver_intent_id) // a payment within this node: one row, not two
    rows.push({
      at: o.createdAt,
      type: r?.type ?? o.metadata?.type ?? 'payment',
      direction: within ? 'within' : 'out',
      from: r?.sender_name ?? nameByWallet.get(o.senderWalletAddress) ?? 'unknown account',
      to: r?.receiver_name ?? o.metadata?.toName ?? 'account on another node',
      sent: parse(r?.sent) ?? toScale(o.sentAmount), // the app's booking, in the sender's currency
      received: parse(r?.received) ?? toScale(localIntent?.receivedAmount) ?? null,
      state: appState(o.state),
      error: o.failReason ?? null,
      paymentId: o.id
    })
  }

  for (const i of localIntents.values()) {
    if (i.receivedAmount?.value === '0') continue // quoted but never paid
    const r = byReceiverIntent(i.id)
    rows.push({
      at: i.createdAt,
      type: r?.type ?? i.metadata?.type ?? 'payment',
      direction: 'in',
      from: r?.sender_name ?? i.metadata?.fromName ?? nameByWallet.get(i.metadata?.fromWallet) ?? 'account on another node',
      to: r?.receiver_name ?? localByWallet.get(i.walletAddress)?.name ?? 'unknown account',
      sent: parse(r?.sent),
      received: toScale(i.receivedAmount),
      state: i.state,
      error: null,
      paymentId: i.id
    })
  }

  for (const m of db.prepare('SELECT * FROM mints WHERE node = ? ORDER BY created_at DESC LIMIT ?').all(nodeKey, ACTIVITY_LIMIT)) {
    const { value, assetCode, assetScale } = parse(m.amount)
    rows.push({
      at: m.created_at, type: 'mint', direction: 'in', from: NODES[nodeKey].bankName, to: m.treasury_name,
      sent: null, received: { value, assetCode, assetScale }, state: 'COMPLETED', error: null, paymentId: m.id
    })
  }

  const since = demoEpoch()
  return rows.filter((r) => r.at >= since).sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, ACTIVITY_LIMIT)
}

module.exports = { overview, mint, listStudents, fundStudent, openStudentAccount, getRate, setRate, syncRates, rateHistory, activity }
