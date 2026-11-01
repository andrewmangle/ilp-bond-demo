// Amounts are { value, assetCode, assetScale } with value a string of minor units, as Rafiki returns them

// A mistake the user can fix (shown as-is, HTTP 400)
class UserError extends Error {}

// The acting role isn't allowed to do this (HTTP 403)
class ForbiddenError extends Error {}

function formatAmount({ value, assetScale, assetCode }) {
  const v = BigInt(value)
  const negative = v < BigInt(0)
  const abs = negative ? -v : v
  const d = BigInt(10) ** BigInt(assetScale)
  const fraction = assetScale ? `.${(abs % d).toString().padStart(assetScale, '0')}` : ''
  return `${negative ? '-' : ''}${abs / d}${fraction} ${assetCode}`
}

function toMinorUnits(amount, scale) {
  const match = String(amount ?? '').trim().match(/^(\d+)(?:\.(\d+))?$/)
  if (!match) throw new UserError('Enter a positive amount, e.g. 25 or 25.50')
  const [, whole, fraction = ''] = match
  if (fraction.length > scale) throw new UserError(`Use at most ${scale} decimal places`)
  const value = BigInt(whole + fraction.padEnd(scale, '0'))
  if (value <= BigInt(0)) throw new UserError('Amount must be greater than zero')
  return value.toString()
}

function toDecimalString({ value, assetScale }) {
  return formatAmount({ value, assetScale, assetCode: '' }).trim()
}

module.exports = { UserError, ForbiddenError, formatAmount, toMinorUnits, toDecimalString }
