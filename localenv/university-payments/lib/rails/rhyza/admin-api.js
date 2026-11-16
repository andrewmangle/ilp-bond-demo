// The Rafiki admin GraphQL API does not exist on the Rhyza rail. Anything still calling it is a bug in the port.

function adminApi() {
  throw new Error('The Rafiki admin API is not available on the Rhyza rail (PAYMENT_RAIL=rhyza)')
}

function signature() {
  throw new Error('Rafiki request signing is not used on the Rhyza rail (PAYMENT_RAIL=rhyza)')
}

module.exports = { adminApi, signature, AMOUNT: 'value assetCode assetScale' }
