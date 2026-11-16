// Open Payments grants on the Rhyza rail: not yet (Phase 4: Rhyza's open-payments-auth-service and
// idp-interaction-service). Until then this stands in for the GNAP client with the same exports, so the
// coupons and recurring-purchase flows in coupons.js and plans.js run unchanged:
//   - a grant request "redirects" straight back to the app's finish URL with an interact_ref, so there is no
//     consent screen and the grant is recorded as approved at once
//   - tokens never expire; revoking does nothing at Rhyza
// The payments made "under" these grants go through the Admin API (rails/rhyza/payments.js payUnderGrant).
// The grant's limits are stored and shown, but Rhyza does not enforce them yet.

const DIRECT = 'rhyza-direct'
const TEN_YEARS_S = 10 * 365 * 24 * 60 * 60

const clientWalletAddress = 'rhyza: grants arrive in Phase 4 (payments go through the Admin API)'

async function ensureClient() {
  return clientWalletAddress
}

async function getWalletAddress(url) {
  return { id: url, authServer: DIRECT, resourceServer: DIRECT }
}

async function requestOutgoingPaymentGrant({ walletAddress, finishUri }) {
  const sep = finishUri.includes('?') ? '&' : '?'
  return {
    walletAddress: { id: walletAddress, authServer: DIRECT, resourceServer: DIRECT },
    finishNonce: DIRECT,
    continueUri: DIRECT,
    continueToken: DIRECT,
    redirect: `${finishUri}${sep}interact_ref=${DIRECT}`
  }
}

const token = () => ({ value: DIRECT, manage: DIRECT, expires_in: TEN_YEARS_S })

async function continueGrant() {
  return token()
}

async function rotateToken() {
  return token()
}

async function revokeToken() {}

function notOnRhyza() {
  throw new Error('Open Payments quotes and outgoing payments are not used on the Rhyza rail yet (Phase 4)')
}

module.exports = {
  clientWalletAddress,
  ensureClient,
  getWalletAddress,
  requestOutgoingPaymentGrant,
  continueGrant,
  rotateToken,
  revokeToken,
  createQuote: notOnRhyza,
  createOutgoingPayment: notOnRhyza
}
