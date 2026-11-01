// Signed requests to a node's Rafiki admin GraphQL API

const { createHmac } = require('crypto')
const { ADMIN_API_SECRET, NODES } = require('./nodes')

// RFC 8785-style canonical JSON (sorted keys), matching what the backend verifies the signature against
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

// `t=<ms>, v1=<hex hmac-sha256(secret, "<t>.<body>")>`, used by the admin API and the mock banks' POST /rates
function signature(body) {
  const timestamp = Date.now()
  const digest = createHmac('sha256', ADMIN_API_SECRET).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp}, v1=${digest}`
}

async function adminApi(nodeKey, query, variables = {}) {
  const node = NODES[nodeKey]
  const body = canonicalize({ query, variables, operationName: null })
  const res = await fetch(node.graphql, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      signature: signature(body),
      'tenant-id': node.tenantId
    },
    body
  })
  const json = await res.json()
  if (json.errors?.length) {
    throw new Error(`${node.label}: ${json.errors.map((e) => e.message).join('; ')}`)
  }
  return json.data
}

const AMOUNT = 'value assetCode assetScale'

module.exports = { adminApi, signature, AMOUNT }
