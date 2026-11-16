// The Rhyza playground's two nodes, acting as university central banks. Same keys as the Rafiki rail (hbcu,
// hague) so pages and stored rows read the same; Cape Town is Phase 5. Topology comes from rhyza/config.mjs.
//
// `currency` is what the node's customer accounts hold in the app's ledger; `railCurrency` is what its Rhyza
// wallets hold and its payments move (see fx.js). RHYZA_HAGUE_CURRENCY=USD keeps the Hague node in USD.

const { config } = require('./rhyza')
const { db } = require('../../db')

const node = (c, extra) => ({
  currency: extra.currency ?? config.ASSET,
  railCurrency: config.ASSET,
  adminUrl: c.adminUrl,
  ilpAddress: c.ilpAddress,
  peerId: c.peerIdForOther, // this node's id for its peer (the other node)
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
  })
}

// pathName of each node's treasury (Rhyza takes a single path segment)
const TREASURY_PATH = 'treasury'

// Which node holds a wallet address. Rhyza's URLs are opaque, so look the address up rather than parse it.
function nodeOfUrl(url) {
  return db.prepare('SELECT node FROM rhyza_accounts WHERE wallet_address = ?').get(String(url ?? ''))?.node ?? null
}

module.exports = { TREASURY_PATH, NODES, nodeOfUrl, ADMIN_API_SECRET: null }
