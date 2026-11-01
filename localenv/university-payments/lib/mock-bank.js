// Each node's mock account servicing entity (the "mock bank"): customer accounts, balances and the rates it
// serves to its Rafiki backend. Accounts live in the mock bank's memory and reset when its container restarts.

const { randomUUID } = require('crypto')
const { NODES, TREASURY_PATH } = require('./nodes')
const { signature } = require('./admin-api')
const { UserError } = require('./money')

async function listNodeAccounts(nodeKey) {
  const node = NODES[nodeKey]
  const res = await fetch(`${node.mockBank}/?_data=routes%2F_index`)
  if (!res.ok) throw new Error(`${node.label} mock bank returned ${res.status}`)
  const { accountsWithBalance } = await res.json()
  return accountsWithBalance.map((account) => ({
    node: nodeKey,
    nodeLabel: node.label,
    id: account.id,
    name: account.name,
    walletAddress: account.walletAddress,
    walletAddressId: account.walletAddressID,
    isTreasury: account.walletAddress.endsWith(`/${TREASURY_PATH}`),
    balance: account.balance,
    assetCode: account.assetCode,
    assetScale: account.assetScale
  }))
}

async function listAccounts() {
  const perNode = await Promise.all(Object.keys(NODES).map(listNodeAccounts))
  return perNode.flat()
}

async function findAccount(nodeKey, accountId) {
  if (!NODES[nodeKey]) throw new UserError('Unknown node')
  const account = (await listNodeAccounts(nodeKey)).find((a) => a.id === accountId)
  if (!account) throw new UserError('Account not found. Was the mock bank restarted?')
  if (!account.walletAddressId) throw new UserError(`${account.name} has no wallet address`)
  return account
}

async function findTreasury(nodeKey) {
  const treasury = (await listNodeAccounts(nodeKey)).find((a) => a.isTreasury)
  if (!treasury) {
    throw new Error(`${NODES[nodeKey].label} has no treasury account (${TREASURY_PATH} in its seed.yml)`)
  }
  return treasury
}

// Uses the mock bank's own create-account form, which also creates the Rafiki wallet address
async function createAccount(nodeKey, assetId, name) {
  const node = NODES[nodeKey]
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account'
  const created = await fetch(`${node.mockBank}/accounts/create`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ name, path: `${slug}-${randomUUID().slice(0, 6)}`, assetId })
  })
  const accountId = (created.headers.get('location') || '').match(/\/accounts\/([0-9a-f-]{36})$/)?.[1]
  if (created.status !== 302 || !accountId) {
    throw new Error(`${node.label} mock bank could not create the account (HTTP ${created.status})`)
  }
  return findAccount(nodeKey, accountId)
}

// Credits an account in the mock bank's books, like a cash deposit. Only used to mint into a treasury.
async function deposit(nodeKey, accountId, decimalAmount) {
  const res = await fetch(`${NODES[nodeKey].mockBank}/accounts/${accountId}`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ intent: 'add-liquidity', id: accountId, amount: decimalAmount })
  })
  if (res.status !== 302) throw new Error(`${NODES[nodeKey].label} mock bank deposit failed (HTTP ${res.status})`)
}

// Rates the mock bank serves to its Rafiki backend (EXCHANGE_RATES_URL): units of each currency per 1 USD
async function getUsdRates(nodeKey) {
  const res = await fetch(`${NODES[nodeKey].mockBank}/rates?base=USD`)
  if (!res.ok) throw new Error(`${NODES[nodeKey].label} rates returned ${res.status}`)
  return (await res.json()).rates
}

async function setUsdRate(nodeKey, currency, perUsd) {
  const body = JSON.stringify({ currency, perUsd })
  const res = await fetch(`${NODES[nodeKey].mockBank}/rates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', signature: signature(body) },
    body
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`${NODES[nodeKey].label} rejected the rate (HTTP ${res.status}): ${detail.slice(0, 200)}`)
  }
}

module.exports = {
  listNodeAccounts,
  listAccounts,
  findAccount,
  findTreasury,
  createAccount,
  deposit,
  getUsdRates,
  setUsdRate
}
