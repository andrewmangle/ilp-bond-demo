// Shared by the Rhyza rail modules: the Admin API clients (rhyza/lib/rhyza-admin.mjs, the only code that calls
// Rhyza), the playground topology (rhyza/config.mjs) and the rail's own tables.
//
// Rhyza keeps no customer balances: an FSP holds its customers' accounts and Rhyza only moves money between
// FSPs (liquidity sits on peers). Rafiki's localenv had a mock bank for that; Rhyza's playground mock
// (ase-mock-service) only approves payments. So on this rail the demo app is the FSP's ledger: accounts and
// balances live in rhyza_accounts, a payment holds the debit when it is created and books both sides when it
// settles, as the Rafiki mock bank did on its webhooks.

const path = require('path')
const { db } = require('../../db')

const ROOT = path.join(__dirname, '..', '..', '..', '..', '..')
const { createRhyzaAdmin, RhyzaError } = require(path.join(ROOT, 'rhyza', 'lib', 'rhyza-admin.mjs'))
const config = require(path.join(ROOT, 'rhyza', 'config.mjs'))

db.exec(`
  CREATE TABLE IF NOT EXISTS rhyza_accounts (
    id TEXT PRIMARY KEY,                -- the app's account id
    node TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,                 -- the pathName given to Rhyza
    wallet_address TEXT NOT NULL UNIQUE, -- as Rhyza returned it (opaque)
    wallet_id TEXT NOT NULL,            -- Rhyza's wallet address id (opaque)
    asset_code TEXT NOT NULL,
    asset_scale INTEGER NOT NULL,
    balance TEXT NOT NULL,              -- minor units; a sending payment's debit is already held out of it
    is_treasury INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rhyza_payments (
    id TEXT PRIMARY KEY,                -- Rhyza payment id (also payments.id)
    sender_node TEXT NOT NULL,
    sender_intent_id TEXT NOT NULL,     -- the sender node's id for the intent (needed to read the payment)
    receiver_node TEXT NOT NULL,
    receiver_intent_id TEXT NOT NULL,   -- the receiver node's id for the intent
    hold TEXT NOT NULL                  -- debit held from the sender's balance until it settles
  );
`)

const admins = {}
function admin(nodeKey) {
  const { NODES } = require('./nodes')
  const node = NODES[nodeKey]
  if (!node) throw new Error(`Unknown node ${nodeKey}`)
  return (admins[nodeKey] ??= createRhyzaAdmin(node.adminUrl))
}

const SCALE = config.SCALE

// Rhyza amounts come at the asset's scale; the demo keeps everything at scale 2
function toScale(amount, scale = SCALE) {
  if (!amount) return null
  const from = Number(amount.assetScale ?? scale)
  let value = BigInt(amount.value)
  if (from > scale) value /= BigInt(10) ** BigInt(from - scale)
  if (from < scale) value *= BigInt(10) ** BigInt(scale - from)
  return { value: value.toString(), assetCode: amount.assetCode, assetScale: scale }
}

// Rhyza payment states, in the app's terms (COMPLETED | FAILED | CANCELLED, else still SENDING)
function appState(state) {
  if (state === 'COMPLETED') return 'COMPLETED'
  if (state === 'FAILED' || state === 'REJECTED') return 'FAILED'
  if (state === 'CANCELLED') return 'CANCELLED'
  return 'SENDING'
}

module.exports = { admin, config, RhyzaError, SCALE, toScale, appState }
