// The Rhyza playground's nodes, acting as university central banks. Same keys as the Rafiki rail (hbcu, hague,
// capetown) so pages and stored rows read the same. Topology comes from rhyza/config.mjs: Node A and Node B,
// plus Node C (Cape Town) when RHYZA_NODES=3.
//
// `currency` is what the node's customer accounts hold in the app's ledger; `railCurrency` is what its Rhyza
// wallets hold and its payments move (see fx.js). RHYZA_HAGUE_CURRENCY=USD keeps the Hague node in USD.

const { config } = require('./rhyza')
const { db } = require('../../db')

const KEY_OF = { a: 'hbcu', b: 'hague', c: 'capetown' } // rhyza/config.mjs node -> app node

const node = (c, extra) => ({
  currency: extra.currency ?? config.ASSET,
  railCurrency: config.ASSET,
  adminUrl: c.adminUrl,
  ilpAddress: c.ilpAddress,
  // this node's id for each running peer, by app node key
  peers: Object.fromEntries(Object.entries(c.peers).filter(([k]) => config.nodes[k]).map(([k, id]) => [KEY_OF[k], id])),
  ...extra
})

const NODES = {
  hbcu: node(config.nodes.a, {
    label: 'HBCU node',
    bankName: 'HBCU central bank',
    rhyza: 'Node A',
    aseMock: 'http://localhost:3000',
    openPayments: 'http://localhost:3002',
    auth: 'http://localhost:3003'
  }),
  hague: node(config.nodes.b, {
    label: 'Hague node',
    bankName: 'Hague central bank',
    rhyza: 'Node B',
    currency: process.env.RHYZA_HAGUE_CURRENCY || 'EUR',
    aseMock: 'http://localhost:4300',
    openPayments: 'http://localhost:4002',
    auth: 'http://localhost:4003'
  }),
  ...(config.nodes.c ? {
    capetown: node(config.nodes.c, {
      label: 'Cape Town node',
      bankName: 'Cape Town central bank',
      rhyza: 'Node C',
      currency: process.env.RHYZA_CAPETOWN_CURRENCY || 'USD',
      aseMock: 'http://localhost:5300',
      openPayments: 'http://localhost:5002',
      auth: 'http://localhost:5003'
    })
  } : {})
}

// pathName of each node's treasury (Rhyza takes a single path segment)
const TREASURY_PATH = 'treasury'

// Which node holds a wallet address. Rhyza's URLs are opaque, so look the address up rather than parse it.
function nodeOfUrl(url) {
  return db.prepare('SELECT node FROM rhyza_accounts WHERE wallet_address = ?').get(String(url ?? ''))?.node ?? null
}

module.exports = { TREASURY_PATH, NODES, nodeOfUrl, ADMIN_API_SECRET: null }
