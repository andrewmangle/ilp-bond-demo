// Live activity feed: every payment across the three nodes, newest first, pushed to the browser as it happens
// (Server-Sent Events). Polls each node's Rafiki for outgoing payments and adds what the app knows: the payment
// type (funding, transfer, bond buy, recurring buy, coupon, principal) and both parties' names. Mints from the
// app's records are included too. Only payments since the last Reset Demo are shown.

const { NODES, nodeOfUrl } = require('./nodes')
const { adminApi, AMOUNT } = require('./admin-api')
const mockBank = require('./mock-bank')
const { db } = require('./db')
const { demoEpoch } = require('./maintenance')

const POLL_MS = 1500
const PER_NODE = 40
const FEED_SIZE = 80
const NAMES_TTL_MS = 10_000

const parse = (json) => (json ? JSON.parse(json) : null)
const clients = new Set()
let feed = new Map() // id -> item (JSON string, to spot changes)

// Account names by wallet address id, per node (refreshed now and then; mock bank calls are cheap)
let names = { at: 0, byWalletId: new Map() }
async function accountNames() {
  if (Date.now() - names.at < NAMES_TTL_MS) return names.byWalletId
  const accounts = await mockBank.listAccounts().catch(() => [])
  names = { at: Date.now(), byWalletId: new Map(accounts.map((a) => [a.walletAddressId, a.name])) }
  return names.byWalletId
}

function typeOf(row, metadata) {
  const type = row?.type ?? metadata?.type
  if (type === 'bond') return parse(row?.details)?.planId ? 'recurring buy' : 'bond buy'
  if (type === 'payment' || !type) return 'transfer'
  return type // funding, coupon, principal
}

function paymentItem(nodeKey, o, row, byWalletId) {
  const toNode = nodeOfUrl(o.receiver) ?? nodeKey
  const final = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(o.state)
  return {
    id: o.id,
    at: o.createdAt,
    type: typeOf(row, o.metadata),
    state: o.state,
    error: o.error ?? o.metadata?.cancellationReason ?? null,
    from: { node: nodeKey, nodeLabel: NODES[nodeKey].label, name: row?.sender_name ?? byWalletId.get(o.walletAddressId) ?? o.metadata?.fromName ?? 'an account' },
    to: { node: toNode, nodeLabel: NODES[toNode].label, name: row?.receiver_name ?? o.metadata?.toName ?? `an account on ${NODES[toNode].label}` },
    sent: o.sentAmount.value !== '0' || final ? o.sentAmount : o.debitAmount,
    received: parse(row?.received) ?? (o.state === 'COMPLETED' ? null : o.receiveAmount),
    estimated: !row?.received
  }
}

function mintItem(m) {
  const node = NODES[m.node]
  return {
    id: m.id,
    at: m.created_at,
    type: 'mint',
    state: 'COMPLETED',
    error: null,
    from: { node: m.node, nodeLabel: node.label, name: node.bankName },
    to: { node: m.node, nodeLabel: node.label, name: m.treasury_name },
    sent: null,
    received: parse(m.amount),
    estimated: false
  }
}

async function collect() {
  const since = demoEpoch()
  const byWalletId = await accountNames()
  const items = []
  await Promise.all(Object.keys(NODES).map(async (nodeKey) => {
    const { outgoingPayments } = await adminApi(
      nodeKey,
      `query($first: Int!) { outgoingPayments(first: $first, sortOrder: DESC) { edges { node {
        id walletAddressId state error createdAt receiver metadata
        debitAmount { ${AMOUNT} } sentAmount { ${AMOUNT} } receiveAmount { ${AMOUNT} } } } } }`,
      { first: PER_NODE }
    ).catch(() => ({ outgoingPayments: { edges: [] } })) // a node that is down just shows nothing new
    for (const { node: o } of outgoingPayments.edges) {
      if (o.createdAt < since) continue
      items.push(paymentItem(nodeKey, o, db.prepare('SELECT * FROM payments WHERE id = ?').get(o.id), byWalletId))
    }
  }))
  for (const m of db.prepare('SELECT * FROM mints WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?').all(since, PER_NODE)) items.push(mintItem(m))
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, FEED_SIZE)
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

let polling = false
async function poll() {
  if (polling || clients.size === 0) return
  polling = true
  try {
    const items = await collect()
    const next = new Map(items.map((i) => [i.id, JSON.stringify(i)]))
    const changes = items.filter((i) => feed.get(i.id) !== next.get(i.id)).map((i) => ({ item: i, isNew: !feed.has(i.id) }))
    const reset = [...feed.keys()].some((id) => !next.has(id)) && items.length < feed.size // e.g. after Reset Demo
    feed = next
    for (const res of clients) {
      if (reset) send(res, 'snapshot', items)
      else for (const change of changes.reverse()) send(res, 'payment', change)
    }
  } catch (err) {
    console.error('Live feed:', err.message)
  } finally {
    polling = false
  }
}
setInterval(poll, POLL_MS).unref()

// GET /api/live/stream: the current feed, then each new or changed payment
async function stream(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  const items = await collect().catch(() => [])
  if (clients.size === 0) feed = new Map(items.map((i) => [i.id, JSON.stringify(i)]))
  send(res, 'snapshot', items)
  clients.add(res)
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(keepAlive)
    clients.delete(res)
  })
}

module.exports = { stream }
