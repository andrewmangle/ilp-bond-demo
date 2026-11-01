// Central-bank actions for one node: treasury and money supply, minting, funding students, the node's
// exchange rate against USD, and the node's payment activity.

const { randomUUID } = require('crypto')
const { NODES, nodeOfUrl } = require('./nodes')
const { adminApi, AMOUNT } = require('./admin-api')
const mockBank = require('./mock-bank')
const payments = require('./payments')
const { db, now } = require('./db')
const { demoEpoch } = require('./maintenance')
const { UserError, toMinorUnits, toDecimalString } = require('./money')

const SCALE = 2 // every demo currency uses 2 decimal places

async function getAsset(nodeKey) {
  const node = NODES[nodeKey]
  const { assetByCodeAndScale: asset } = await adminApi(
    nodeKey,
    `query($code: String!, $scale: UInt8!) { assetByCodeAndScale(code: $code, scale: $scale) { id code scale liquidity } }`,
    { code: node.currency, scale: SCALE }
  )
  if (!asset) throw new Error(`${node.label} has no ${node.currency} asset`)
  return asset
}

// --- Treasury and money supply ---

async function overview(nodeKey) {
  const node = NODES[nodeKey]
  const [accounts, asset, rate, { peers }] = await Promise.all([
    mockBank.listNodeAccounts(nodeKey),
    getAsset(nodeKey),
    getRate(nodeKey),
    adminApi(nodeKey, `{ peers { edges { node { id name staticIlpAddress liquidity asset { code scale } } } } }`)
  ])

  // Money supply: everything held in this node's accounts, per currency (some seeded accounts aren't in the node currency)
  const supply = {}
  for (const a of accounts) {
    supply[a.assetCode] ??= { value: BigInt(0), assetCode: a.assetCode, assetScale: a.assetScale, accounts: 0 }
    supply[a.assetCode].value += BigInt(a.balance)
    supply[a.assetCode].accounts++
  }
  const treasury = accounts.find((a) => a.isTreasury) ?? null

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
    rafikiLiquidity: { value: asset.liquidity, assetCode: asset.code, assetScale: asset.scale },
    peerLiquidity: peers.edges.map(({ node: p }) => ({
      peer: p.staticIlpAddress,
      liquidity: { value: p.liquidity, assetCode: p.asset.code, assetScale: p.asset.scale }
    })),
    rate
  }
}

// Minting adds the money to Rafiki's liquidity for the node's asset (admin API) and books it to the
// treasury account at the mock bank, the only place the app credits a balance without a payment.
async function mint(nodeKey, amount) {
  const asset = await getAsset(nodeKey)
  const treasury = await mockBank.findTreasury(nodeKey)
  const value = toMinorUnits(amount, asset.scale)
  const minted = { value, assetCode: asset.code, assetScale: asset.scale }

  const id = randomUUID()
  const { depositAssetLiquidity } = await adminApi(
    nodeKey,
    `mutation($input: DepositAssetLiquidityInput!) { depositAssetLiquidity(input: $input) { success } }`,
    { input: { id, assetId: asset.id, amount: value, idempotencyKey: randomUUID() } }
  )
  if (!depositAssetLiquidity.success) throw new Error('Rafiki did not accept the liquidity deposit')
  await mockBank.deposit(nodeKey, treasury.id, toDecimalString(minted))

  db.prepare(
    `INSERT INTO mints (id, node, treasury_account, treasury_name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, nodeKey, treasury.id, treasury.name, JSON.stringify(minted), now())

  const after = await mockBank.findTreasury(nodeKey)
  return {
    id,
    minted,
    treasuryBalance: { value: after.balance, assetCode: after.assetCode, assetScale: after.assetScale }
  }
}

// --- Students ---

async function listStudents(nodeKey) {
  return (await mockBank.listNodeAccounts(nodeKey)).filter((a) => !a.isTreasury)
}

// Treasury -> student payment on the same node; the student receives exactly `amount`, fees come on top
async function fundStudent(nodeKey, accountId, amount) {
  const treasury = await mockBank.findTreasury(nodeKey)
  const student = await mockBank.findAccount(nodeKey, accountId)
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
  if (fundingRequested) toMinorUnits(initialFunding, SCALE) // validate before creating anything

  const asset = await getAsset(nodeKey)
  const account = await mockBank.createAccount(nodeKey, asset.id, name)
  const funding = fundingRequested ? await fundStudent(nodeKey, account.id, initialFunding) : null
  return { account: await mockBank.findAccount(nodeKey, account.id), funding }
}

// --- Exchange rate against USD ---
// Each node's Rafiki backend reads rates from its mock bank's /rates (EXCHANGE_RATES_URL) and caches them for
// 15 s. Peering between the nodes is in USD, so a node's own rate is what converts into and out of its
// currency. The app sets it on the node's mock bank and publishes it to the other two so every table agrees.

const RATE_CACHE_SECONDS = 15

async function getRate(nodeKey) {
  const { currency } = NODES[nodeKey]
  if (currency === 'USD') return { currency, perUsd: 1, editable: false }
  const rates = await mockBank.getUsdRates(nodeKey)
  return { currency, perUsd: rates[currency] ?? null, editable: true }
}

async function setRate(nodeKey, perUsdInput) {
  const { currency } = NODES[nodeKey]
  if (currency === 'USD') throw new UserError('USD is the base currency of the network; its rate is always 1')
  const perUsd = Number(perUsdInput)
  if (!/^\d+(\.\d+)?$/.test(String(perUsdInput).trim()) || !(perUsd > 0)) {
    throw new UserError(`Enter how many ${currency} one USD buys, e.g. 18.2`)
  }

  const { perUsd: oldPerUsd } = await getRate(nodeKey)
  await mockBank.setUsdRate(nodeKey, currency, perUsd)
  const others = Object.keys(NODES).filter((key) => key !== nodeKey)
  await Promise.all(others.map((key) => mockBank.setUsdRate(key, currency, perUsd)))

  const at = now()
  db.prepare(
    `INSERT INTO rates (currency, node, per_usd, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (currency) DO UPDATE SET node = excluded.node, per_usd = excluded.per_usd, updated_at = excluded.updated_at`
  ).run(currency, nodeKey, perUsd, at)
  db.prepare(
    `INSERT INTO rate_changes (node, currency, old_per_usd, new_per_usd, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(nodeKey, currency, oldPerUsd, perUsd, at)

  return {
    currency,
    oldPerUsd,
    perUsd,
    effectiveBy: new Date(Date.now() + RATE_CACHE_SECONDS * 1000).toISOString()
  }
}

// A restarted mock bank goes back to its seed.yml rates; put back the ones the central banks have set
async function syncRates() {
  const stored = db.prepare('SELECT currency, per_usd FROM rates').all()
  for (const nodeKey of Object.keys(NODES)) {
    let current
    try {
      current = await mockBank.getUsdRates(nodeKey)
    } catch {
      continue // node not running yet
    }
    for (const { currency, per_usd: perUsd } of stored) {
      if (Math.abs((current[currency] ?? 0) - perUsd) > 1e-9) {
        await mockBank.setUsdRate(nodeKey, currency, perUsd)
        console.log(`Restored ${currency} rate ${perUsd} on ${NODES[nodeKey].label}`)
      }
    }
  }
}

function rateHistory(nodeKey) {
  return db
    .prepare('SELECT currency, old_per_usd AS oldPerUsd, new_per_usd AS perUsd, created_at AS at FROM rate_changes WHERE node = ? ORDER BY id DESC LIMIT 10')
    .all(nodeKey)
}

// --- Activity: every payment into or out of this node, from Rafiki, with names and types from our records ---

const ACTIVITY_LIMIT = 100
const parse = (json) => (json ? JSON.parse(json) : null)

async function activity(nodeKey) {
  const [accounts, { outgoingPayments }, { incomingPayments }] = await Promise.all([
    mockBank.listAccounts().catch(() => mockBank.listNodeAccounts(nodeKey)),
    adminApi(
      nodeKey,
      `query($first: Int!) { outgoingPayments(first: $first, sortOrder: DESC) { edges { node {
        id walletAddressId state error createdAt receiver metadata sentAmount { ${AMOUNT} } } } } }`,
      { first: ACTIVITY_LIMIT }
    ),
    adminApi(
      nodeKey,
      `query($first: Int!) { incomingPayments(first: $first, sortOrder: DESC) { edges { node {
        id url walletAddressId state createdAt metadata receivedAmount { ${AMOUNT} } } } } }`,
      { first: ACTIVITY_LIMIT }
    )
  ])

  const local = accounts.filter((a) => a.node === nodeKey)
  const nameByWalletId = new Map(local.map((a) => [a.walletAddressId, a.name]))
  const nameByWallet = new Map(accounts.map((a) => [a.walletAddress, a.name]))
  const otherNode = (url) => {
    const key = nodeOfUrl(url)
    return key && key !== nodeKey ? `account on ${NODES[key].label}` : 'unknown account'
  }
  const record = (sql, arg) => db.prepare(sql).get(arg)

  const incomingByUrl = new Map(incomingPayments.edges.map(({ node }) => [node.url, node]))
  const rows = []

  for (const { node: o } of outgoingPayments.edges) {
    const r = record('SELECT * FROM payments WHERE id = ?', o.id)
    const localIncoming = incomingByUrl.get(o.receiver)
    if (localIncoming) incomingByUrl.delete(o.receiver) // a payment within this node: one row, not two
    rows.push({
      at: o.createdAt,
      type: r?.type ?? o.metadata?.type ?? 'payment',
      direction: localIncoming ? 'within' : 'out',
      from: r?.sender_name ?? nameByWalletId.get(o.walletAddressId) ?? 'unknown account',
      to: r?.receiver_name ?? o.metadata?.toName ?? (localIncoming && nameByWalletId.get(localIncoming.walletAddressId)) ?? otherNode(o.receiver),
      sent: o.sentAmount,
      received: parse(r?.received) ?? localIncoming?.receivedAmount ?? null,
      state: o.state,
      error: o.error ?? o.metadata?.cancellationReason ?? null,
      paymentId: o.id
    })
  }

  for (const i of incomingByUrl.values()) {
    if (i.receivedAmount.value === '0') continue // quoted but never paid
    const r = record('SELECT * FROM payments WHERE incoming_payment_url = ?', i.url)
    rows.push({
      at: i.createdAt,
      type: r?.type ?? i.metadata?.type ?? 'payment',
      direction: 'in',
      from: r?.sender_name ?? i.metadata?.fromName ?? nameByWallet.get(i.metadata?.fromWallet) ?? 'account on another node',
      to: r?.receiver_name ?? nameByWalletId.get(i.walletAddressId) ?? 'unknown account',
      sent: parse(r?.sent),
      received: i.receivedAmount,
      state: i.state,
      error: null,
      paymentId: i.id
    })
  }

  for (const m of db.prepare('SELECT * FROM mints WHERE node = ? ORDER BY created_at DESC LIMIT ?').all(nodeKey, ACTIVITY_LIMIT)) {
    rows.push({
      at: m.created_at,
      type: 'mint',
      direction: 'in',
      from: NODES[nodeKey].bankName,
      to: m.treasury_name,
      sent: null,
      received: parse(m.amount),
      state: 'COMPLETED',
      error: null,
      paymentId: m.id
    })
  }

  const since = demoEpoch()
  return rows.filter((r) => r.at >= since).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, ACTIVITY_LIMIT)
}

module.exports = {
  overview,
  mint,
  listStudents,
  fundStudent,
  openStudentAccount,
  getRate,
  setRate,
  syncRates,
  rateHistory,
  activity
}
