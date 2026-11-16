// The payment rail: what moves money underneath the bond market. PAYMENT_RAIL=rafiki (default) or rhyza.
//
// The rail is the set of modules the rest of the app (bonds, coupons, plans, clock, pages) calls for money
// movement and accounts. Each rail provides all of them, with the same exports:
//
//   nodes          NODES, TREASURY_PATH, nodeOfUrl            the central-bank nodes
//   mock-bank      listNodeAccounts, listAccounts, findAccount, findTreasury,
//                  createAccount, deposit, getUsdRates, setUsdRate
//                                                             create account, balances, fund (mint), rates
//   payments       quote, pay, payUnderGrant, quoteAndPay, getPendingQuote, listPendingQuotes, cancelQuote,
//                  clearPendingQuotes, onSettled, settleSending
//                                                             send payment, payment status, settled events
//   open-payments  ensureClient, requestOutgoingPaymentGrant, continueGrant, rotateToken, revokeToken, ...
//   central-bank   overview, mint, listStudents, fundStudent, openStudentAccount, getRate, setRate, syncRates,
//                  rateHistory, activity
//   live           stream                                     live feed (polls the rail for payment events)
//   demo           health, reset, seed
//   admin-api      adminApi, signature, AMOUNT                Rafiki only; the Rhyza rail has a stub that throws
//
// rafiki: the existing modules in lib/, unchanged. Nothing below runs.
// rhyza:  the modules in lib/rails/rhyza/, built on rhyza/lib/rhyza-admin.mjs (the only code that calls Rhyza).
//         Requests for lib/<module>.js are resolved to lib/rails/rhyza/<module>.js instead, so bonds.js,
//         coupons.js, plans.js and server.js run unchanged on either rail. Must be required before any of them.

const path = require('path')
const Module = require('module')

const RAIL = (process.env.PAYMENT_RAIL || 'rafiki').toLowerCase()
if (!['rafiki', 'rhyza'].includes(RAIL)) throw new Error(`PAYMENT_RAIL must be rafiki or rhyza, not "${RAIL}"`)

const RAIL_MODULES = ['nodes', 'mock-bank', 'admin-api', 'payments', 'open-payments', 'central-bank', 'live', 'demo']

if (RAIL === 'rhyza') {
  // Keep each rail's registry in its own database, so bonds and holdings never mix
  process.env.DB_FILE ||= path.join(__dirname, '..', 'data', 'demo-rhyza.db')

  const libDir = __dirname
  const swap = new Map(RAIL_MODULES.map((name) => [path.join(libDir, `${name}.js`), path.join(libDir, 'rails', 'rhyza', `${name}.js`)]))
  const resolve = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const resolved = resolve.call(this, request, parent, ...rest)
    return swap.get(resolved) ?? resolved
  }
}

module.exports = { RAIL }
