// Currency conversion on the Rhyza rail, done by the app because Rhyza can't yet (interledger/rhyza#424 and
// #425: a node can only pay across a peer in its peering asset).
//
// Every Rhyza wallet holds the rail currency (rhyza/config.mjs ASSET, USD) and every payment moves rail
// currency between the nodes. Each node's customer accounts in the app's ledger hold that node's own currency
// (nodes.js), and the app converts when it books a payment: the sender's debit in the sender's currency, the
// receiver's credit in the receiver's currency, at the rates below. Same currency on both sides books the same
// amount on both.
//
// Rates (units per 1 USD): a central bank's own setting (the rates table) wins; otherwise the ECB reference rate
// from frankfurter.dev (free, no key, refreshed every 6 hours); otherwise the Rafiki rail's seed.yml baseline.

const { db, now } = require('../../db')
const { config } = require('./rhyza')

const RAIL = config.ASSET
const BASE_PER_USD = { EUR: 0.92, ZAR: 18.2 } // the Rafiki rail's seed.yml, if the rate service can't be reached
const MARKET_URL = 'https://api.frankfurter.dev/v1/latest?base=USD'
const MARKET_TTL_MS = 6 * 60 * 60 * 1000
const MARKET_RETRY_MS = 5 * 60 * 1000

db.exec(`CREATE TABLE IF NOT EXISTS market_rates (
  currency TEXT PRIMARY KEY,
  per_usd REAL NOT NULL,
  rate_date TEXT NOT NULL,   -- the ECB's publication date
  fetched_at TEXT NOT NULL
)`)

let lastTry = 0
// Fetches the ECB reference rates if the stored ones are older than 6 hours. Never throws: the stored or
// baseline rates stay in use.
async function refreshMarketRates({ force = false } = {}) {
  const newest = db.prepare('SELECT MAX(fetched_at) AS at FROM market_rates').get()?.at
  if (!force && newest && Date.now() - Date.parse(newest) < MARKET_TTL_MS) return
  if (!force && Date.now() - lastTry < MARKET_RETRY_MS) return
  lastTry = Date.now()
  try {
    const res = await fetch(MARKET_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const at = now()
    const upsert = db.prepare(
      `INSERT INTO market_rates (currency, per_usd, rate_date, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (currency) DO UPDATE SET per_usd = excluded.per_usd, rate_date = excluded.rate_date, fetched_at = excluded.fetched_at`
    )
    for (const [currency, perUsd] of Object.entries(body.rates ?? {})) if (perUsd > 0) upsert.run(currency, perUsd, body.date, at)
  } catch (err) {
    console.error(`Exchange rates: could not reach ${MARKET_URL} (${err.cause?.code ?? err.message}); using stored rates`)
  }
}

// Units of each currency per 1 USD, with where each came from
function ratesWithSource() {
  const out = { USD: { perUsd: 1, source: null } }
  for (const [c, perUsd] of Object.entries(BASE_PER_USD)) out[c] = { perUsd, source: 'Baseline rate (the rate service could not be reached)' }
  for (const r of db.prepare('SELECT currency, per_usd, rate_date FROM market_rates').all()) {
    out[r.currency] = { perUsd: r.per_usd, source: `ECB reference rate of ${r.rate_date} (frankfurter.dev)` }
  }
  for (const r of db.prepare('SELECT currency, per_usd FROM rates').all()) {
    out[r.currency] = { perUsd: r.per_usd, source: 'Set by this central bank' }
  }
  return out
}

function perUsd() {
  return Object.fromEntries(Object.entries(ratesWithSource()).map(([c, r]) => [c, r.perUsd]))
}

// Units of `currency` per 1 rail unit
function perRail(currency) {
  const rates = perUsd()
  if (!rates[currency] || !rates[RAIL]) throw new Error(`No exchange rate for ${currency}`)
  return rates[currency] / rates[RAIL]
}

// Minor units, both at scale 2. `round` is 'down' or 'up'.
const roundBy = (x, round) => BigInt(round === 'up' ? Math.ceil(x - 1e-9) : Math.floor(x + 1e-9))
const toRail = (value, currency, round) => (currency === RAIL ? BigInt(value) : roundBy(Number(value) / perRail(currency), round))
const fromRail = (value, currency, round) => (currency === RAIL ? BigInt(value) : roundBy(Number(value) * perRail(currency), round))

// What a payment books in the app and moves on Rhyza, for a fixed debit (sender's currency) or a fixed receive
// (receiver's currency). Rounded so the sender is never charged less, nor the receiver credited more, than the
// rail amount is worth.
function plan({ senderCurrency, receiverCurrency, debitValue, receiveValue }) {
  const same = senderCurrency === receiverCurrency
  if (debitValue !== undefined) {
    const debit = BigInt(debitValue)
    const rail = toRail(debit, senderCurrency, 'down')
    return { debit, rail, credit: same ? debit : fromRail(rail, receiverCurrency, 'down') }
  }
  const credit = BigInt(receiveValue)
  const rail = toRail(credit, receiverCurrency, 'up')
  return { credit, rail, debit: same ? credit : fromRail(rail, senderCurrency, 'up') }
}

// Share of a booked amount for the part of the rail amount that actually moved
function share(booked, moved, planned) {
  if (BigInt(moved) >= BigInt(planned)) return BigInt(booked)
  return (BigInt(booked) * BigInt(moved)) / BigInt(planned)
}

module.exports = { RAIL, refreshMarketRates, ratesWithSource, perUsd, plan, share, toRail, fromRail }
