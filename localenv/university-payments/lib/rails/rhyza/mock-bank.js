// The FSP ledger on the Rhyza rail: customer accounts and balances, kept by the app (Rhyza holds none; see
// rhyza.js). Same exports as the Rafiki rail's mock-bank.js. Each account has a Rhyza wallet address.
//
// The treasury and story accounts are created on Rhyza the first time they are needed after a start or a
// Reset Demo. Rhyza has no way to look up an existing wallet address, so every wallet's pathName carries a
// suffix that is new after each reset (settings.rhyza_instance): a reset starts clean wallets instead of
// colliding with old ones.

const { randomUUID } = require('crypto')
const { NODES, TREASURY_PATH } = require('./nodes')
const { admin, SCALE } = require('./rhyza')
const fx = require('./fx')
const { db, now } = require('../../db')
const { UserError, toMinorUnits } = require('../../money')

// Created on every node / the named node, all at balance 0 (fund them from the treasury)
const STORY_ACCOUNTS = [
  { node: 'hbcu', path: 'jordan', name: 'Jordan Ellis' },
  { node: 'hague', path: 'sophie', name: 'Sophie Janssen' },
  { node: 'hague', path: 'ellis-family', name: 'Ellis Family Savings' }
]

function instance() {
  let row = db.prepare(`SELECT value FROM settings WHERE key = 'rhyza_instance'`).get()
  if (!row) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('rhyza_instance', ?)`).run(randomUUID().slice(0, 6))
    row = db.prepare(`SELECT value FROM settings WHERE key = 'rhyza_instance'`).get()
  }
  return row.value
}

function newInstance() {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('rhyza_instance', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
    .run(randomUUID().slice(0, 6))
}

const view = (row) => ({
  node: row.node,
  nodeLabel: NODES[row.node]?.label ?? row.node,
  id: row.id,
  name: row.name,
  walletAddress: row.wallet_address,
  walletAddressId: row.wallet_id,
  isTreasury: !!row.is_treasury,
  balance: row.balance,
  assetCode: row.asset_code,
  assetScale: row.asset_scale
})

async function openWallet(nodeKey, { path, name, isTreasury = false }) {
  const pathName = `${path}-${instance()}`
  const { currency, railCurrency } = NODES[nodeKey]
  const created = await admin(nodeKey).createWalletAddress(pathName, railCurrency, name) // the account itself holds `currency`
  const id = randomUUID()
  db.prepare(
    `INSERT INTO rhyza_accounts (id, node, name, path, wallet_address, wallet_id, asset_code, asset_scale, balance, is_treasury, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?)`
  ).run(id, nodeKey, name, pathName, created.address, created.id, currency, SCALE, isTreasury ? 1 : 0, now())
  return id
}

// The treasury on every node and the story accounts, once per start or reset
let readyPromise = null
function ready() {
  readyPromise ??= (async () => {
    for (const nodeKey of Object.keys(NODES)) {
      const has = (path) => db.prepare('SELECT 1 FROM rhyza_accounts WHERE node = ? AND path = ?').get(nodeKey, `${path}-${instance()}`)
      if (!has(TREASURY_PATH)) await openWallet(nodeKey, { path: TREASURY_PATH, name: NODES[nodeKey].bankName.replace('central bank', 'Central Bank'), isTreasury: true })
      for (const s of STORY_ACCOUNTS.filter((s) => s.node === nodeKey)) if (!has(s.path)) await openWallet(nodeKey, s)
    }
  })().catch((err) => {
    readyPromise = null // try again on the next request
    throw err
  })
  return readyPromise
}

// After a reset: forget the accounts and start a new set of wallets
function resetAccounts() {
  db.exec('DELETE FROM rhyza_accounts')
  db.exec('DELETE FROM rhyza_payments')
  newInstance()
  readyPromise = null
}

async function listNodeAccounts(nodeKey) {
  if (!NODES[nodeKey]) throw new UserError('Unknown node')
  await ready()
  return db.prepare('SELECT * FROM rhyza_accounts WHERE node = ? ORDER BY is_treasury DESC, created_at').all(nodeKey).map(view)
}

async function listAccounts() {
  const perNode = await Promise.all(Object.keys(NODES).map(listNodeAccounts))
  return perNode.flat()
}

async function findAccount(nodeKey, accountId) {
  if (!NODES[nodeKey]) throw new UserError('Unknown node')
  await ready()
  const row = db.prepare('SELECT * FROM rhyza_accounts WHERE node = ? AND id = ?').get(nodeKey, accountId)
  if (!row) throw new UserError('Account not found. Was the demo reset?')
  return view(row)
}

async function findTreasury(nodeKey) {
  await ready()
  const row = db.prepare('SELECT * FROM rhyza_accounts WHERE node = ? AND is_treasury = 1').get(nodeKey)
  if (!row) throw new Error(`${NODES[nodeKey].label} has no treasury account`)
  return view(row)
}

// A story account by its pathName before the instance suffix (e.g. 'jordan'), for seeding
async function findByPath(nodeKey, path) {
  await ready()
  const row = db.prepare('SELECT * FROM rhyza_accounts WHERE node = ? AND path = ?').get(nodeKey, `${path}-${instance()}`)
  return row ? view(row) : null
}

// A new customer account and its Rhyza wallet address. assetId is the asset code on this rail.
async function createAccount(nodeKey, assetId, name) {
  if (!NODES[nodeKey]) throw new UserError('Unknown node')
  if (assetId && assetId !== NODES[nodeKey].currency) throw new UserError(`${NODES[nodeKey].label} holds ${NODES[nodeKey].currency} accounts`)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account'
  const id = await openWallet(nodeKey, { path: `${slug}-${randomUUID().slice(0, 4)}`, name })
  return findAccount(nodeKey, id)
}

// --- Balance movements (synchronous, so a check and its change can't interleave with another request) ---

function adjust(accountId, delta) {
  const row = db.prepare('SELECT balance FROM rhyza_accounts WHERE id = ?').get(accountId)
  if (!row) throw new Error(`Account ${accountId} is gone (was the demo reset?)`)
  db.prepare('UPDATE rhyza_accounts SET balance = ? WHERE id = ?').run((BigInt(row.balance) + BigInt(delta)).toString(), accountId)
}

// Takes a payment's debit out of the balance while it is sent; refuses if the balance is short
function hold(accountId, value) {
  const row = db.prepare('SELECT name, balance FROM rhyza_accounts WHERE id = ?').get(accountId)
  if (BigInt(row.balance) < BigInt(value)) return false
  adjust(accountId, -BigInt(value))
  return true
}

// Credits an account like a cash deposit. Only used to mint into a treasury.
async function deposit(nodeKey, accountId, decimalAmount) {
  const account = await findAccount(nodeKey, accountId)
  adjust(account.id, toMinorUnits(decimalAmount, account.assetScale))
}

// --- Rates: units of each currency per 1 USD (fx.js). Rhyza doesn't convert, so nothing is pushed to it. ---

async function getUsdRates() {
  const { USD, ...rest } = fx.perUsd()
  return rest
}

async function setUsdRate() {}

module.exports = {
  listNodeAccounts,
  listAccounts,
  findAccount,
  findTreasury,
  findByPath,
  createAccount,
  deposit,
  getUsdRates,
  setUsdRate,
  // Rhyza rail only
  ready,
  resetAccounts,
  hold,
  adjust,
  STORY_ACCOUNTS
}
