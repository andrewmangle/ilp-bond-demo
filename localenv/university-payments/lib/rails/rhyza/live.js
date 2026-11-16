// Live activity feed on the Rhyza rail: every payment across the nodes, newest first, pushed over SSE. Same
// behavior as the Rafiki rail's live.js, polling each node's GET /payments instead of outgoingPayments.

const { NODES } = require('./nodes')
const { admin, appState, toScale } = require('./rhyza')
const bank = require('./mock-bank')
const { db } = require('../../db')
const { demoEpoch } = require('../../maintenance')

const POLL_MS = 1500
const PER_NODE = 40
const FEED_SIZE = 80
const NAMES_TTL_MS = 10_000

const parse = (json) => (json ? JSON.parse(json) : null)
const clients = new Set()
let feed = new Map()

let names = { at: 0, byWallet: new Map() }
async function accountNames() {
  if (Date.now() - names.at < NAMES_TTL_MS) return names.byWallet
  const accounts = await bank.listAccounts().catch(() => [])
  names = { at: Date.now(), byWallet: new Map(accounts.map((a) => [a.walletAddress, a.name])) }
  return names.byWallet
}

function typeOf(row, metadata) {
  const type = row?.type ?? metadata?.type
  if (type === 'bond') return parse(row?.details)?.planId ? 'recurring buy' : 'bond buy'
  if (type === 'payment' || !type) return 'transfer'
  return type
}

function paymentItem(nodeKey, o, row, byWallet) {
  const toNode = row?.receiver_node && NODES[row.receiver_node] ? row.receiver_node : nodeKey
  const state = appState(o.state)
  const final = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(state)
  const sent = toScale(o.sentAmount)
  return {
    id: o.id,
    at: o.createdAt,
    type: typeOf(row, o.metadata),
    state,
    error: o.failReason ?? null,
    from: { node: nodeKey, nodeLabel: NODES[nodeKey].label, name: row?.sender_name ?? byWallet.get(o.senderWalletAddress) ?? o.metadata?.fromName ?? 'an account' },
    to: { node: toNode, nodeLabel: NODES[toNode].label, name: row?.receiver_name ?? o.metadata?.toName ?? `an account on ${NODES[toNode].label}` },
    // The app's booking (each side in its own currency) once settled, else what Rhyza moves (rail currency)
    sent: parse(row?.sent) ?? (sent.value !== '0' || final ? sent : parse(row?.quoted_debit) ?? toScale(o.debitAmount)),
    received: parse(row?.received) ?? (state === 'COMPLETED' ? null : parse(row?.quoted_receive) ?? toScale(o.receiveAmount)),
    estimated: !row?.received
  }
}

function mintItem(m) {
  const node = NODES[m.node]
  const { value, assetCode, assetScale } = parse(m.amount)
  return {
    id: m.id, at: m.created_at, type: 'mint', state: 'COMPLETED', error: null,
    from: { node: m.node, nodeLabel: node.label, name: node.bankName },
    to: { node: m.node, nodeLabel: node.label, name: m.treasury_name },
    sent: null, received: { value, assetCode, assetScale }, estimated: false
  }
}

async function collect() {
  const since = demoEpoch()
  const byWallet = await accountNames()
  const items = []
  await Promise.all(Object.keys(NODES).map(async (nodeKey) => {
    const { result } = await admin(nodeKey).listPayments({ first: PER_NODE, sortOrder: 'desc' }).catch(() => ({ result: [] }))
    for (const o of result) {
      if (o.createdAt < since) continue
      items.push(paymentItem(nodeKey, o, db.prepare('SELECT * FROM payments WHERE id = ?').get(o.id), byWallet))
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
    const reset = [...feed.keys()].some((id) => !next.has(id)) && items.length < feed.size
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
