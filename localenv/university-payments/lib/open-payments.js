// The demo app as an Open Payments client ("University Bond Desk"): its own wallet address and Ed25519 key,
// GNAP grant requests to a node's auth server, and quotes and outgoing payments under a grant on a node's
// resource server. Requests are signed with HTTP message signatures (RFC 9421), the way
// @interledger/http-signature-utils signs them, so the auth server and backend can check them against the
// public key in the client wallet address's JWKS.
//
// Wallet addresses, auth servers and resource servers use Docker hostnames (https://cape-town-node-backend,
// http://cape-town-node-auth:3006). From the host, each request goes to the matching localhost port with the
// original Host header, and is signed for the plain-http URL, which is what the dev-mode servers rebuild from
// the Host header to check the signature.

const http = require('http')
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } = require('crypto')
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs')
const path = require('path')
const { NODES } = require('./nodes')
const { adminApi } = require('./admin-api')

const CLIENT_NODE = 'hbcu'
const CLIENT_PATH = 'accounts/bond-desk'
const CLIENT_NAME = 'University Bond Desk'
const KEY_FILE = process.env.CLIENT_KEY_FILE || path.join(__dirname, '..', 'data', 'client-key.json')

const clientWalletAddress = `https://${NODES[CLIENT_NODE].backendHost}/${CLIENT_PATH}`

// --- Key ---

function loadKey() {
  if (!existsSync(KEY_FILE)) {
    const { privateKey } = generateKeyPairSync('ed25519')
    mkdirSync(path.dirname(KEY_FILE), { recursive: true })
    writeFileSync(KEY_FILE, JSON.stringify({ keyId: randomUUID(), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 })
  }
  const { keyId, privateKey } = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
  return { keyId, privateKey: createPrivateKey(privateKey) }
}
const key = loadKey()

function publicJwk() {
  const { x } = createPublicKey(key.privateKey).export({ format: 'jwk' })
  return { kid: key.keyId, x, alg: 'EdDSA', kty: 'OKP', crv: 'Ed25519' }
}

// Creates the client's wallet address and registers the key, once
async function ensureClient() {
  const { walletAddressByUrl } = await adminApi(
    CLIENT_NODE,
    `query($url: String!) { walletAddressByUrl(url: $url) { id walletAddressKeys { edges { node { jwk { kid } revoked } } } } }`,
    { url: clientWalletAddress }
  )
  let walletAddressId = walletAddressByUrl?.id
  if (!walletAddressId) {
    const { assetByCodeAndScale: asset } = await adminApi(
      CLIENT_NODE,
      `query($code: String!, $scale: UInt8!) { assetByCodeAndScale(code: $code, scale: $scale) { id } }`,
      { code: NODES[CLIENT_NODE].currency, scale: 2 }
    )
    const { createWalletAddress } = await adminApi(
      CLIENT_NODE,
      `mutation($input: CreateWalletAddressInput!) { createWalletAddress(input: $input) { walletAddress { id } } }`,
      { input: { assetId: asset.id, address: clientWalletAddress, publicName: CLIENT_NAME, idempotencyKey: randomUUID() } }
    )
    walletAddressId = createWalletAddress.walletAddress.id
  }
  const keys = walletAddressByUrl?.walletAddressKeys?.edges ?? []
  if (!keys.some(({ node }) => node.jwk.kid === key.keyId && !node.revoked)) {
    await adminApi(
      CLIENT_NODE,
      `mutation($input: CreateWalletAddressKeyInput!) { createWalletAddressKey(input: $input) { walletAddressKey { id } } }`,
      { input: { walletAddressId, jwk: publicJwk(), idempotencyKey: randomUUID() } }
    )
  }
  return clientWalletAddress
}

// --- Signed requests ---

// Docker hostname -> localhost port
function route(url) {
  const u = new URL(url.replace(/^https:/, 'http:'))
  for (const node of Object.values(NODES)) {
    if (u.hostname === node.backendHost) return { u, port: node.openPaymentsPort }
    if (u.hostname === node.authHost) return { u, port: node.authPort }
  }
  if (u.hostname === 'localhost') return { u, port: Number(u.port || 80) }
  throw new Error(`Don't know how to reach ${u.host} from the host`)
}

// RFC 9421 signature over @method, @target-uri, authorization and the content headers, as
// @interledger/http-signature-utils createHeaders does (params keyid then created, label sig1)
function signatureHeaders(method, targetUri, headers) {
  const components = ['@method', '@target-uri']
  if (headers.authorization) components.push('authorization')
  if (headers['content-digest']) components.push('content-digest', 'content-length', 'content-type')
  const created = Math.floor(Date.now() / 1000)
  const params = `(${components.map((c) => `"${c}"`).join(' ')});keyid="${key.keyId}";created=${created}`
  const value = (c) => (c === '@method' ? method.toUpperCase() : c === '@target-uri' ? targetUri : headers[c])
  const base = [...components.map((c) => `"${c}": ${value(c)}`), `"@signature-params": ${params}`].join('\n')
  const signature = sign(null, Buffer.from(base), key.privateKey).toString('base64')
  return { signature: `sig1=:${signature}:`, 'signature-input': `sig1=${params}` }
}

function signedRequest(method, url, { token, body } = {}) {
  const { u, port } = route(url)
  const targetUri = u.href
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = `GNAP ${token}`
  let payload
  if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(Buffer.byteLength(payload))
    headers['content-digest'] = `sha-512=:${createHash('sha512').update(payload).digest('base64')}:`
  }
  Object.assign(headers, signatureHeaders(method, targetUri, headers))

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port, method, path: u.pathname + u.search, headers: { ...headers, host: u.host }, timeout: 20_000 },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => (raw += chunk))
        res.on('end', () => {
          let data = null
          try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
          if (res.statusCode >= 400) {
            const detail = typeof data === 'string' ? data : data?.error?.description || data?.error?.code || data?.message || JSON.stringify(data)
            const err = new Error(`${method} ${targetUri} → ${res.statusCode}: ${detail}`)
            err.status = res.statusCode
            err.body = data
            return reject(err)
          }
          resolve(data)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`${method} ${targetUri} timed out`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// --- Open Payments ---

const getWalletAddress = (url) => signedRequest('GET', url)

// Interactive outgoing-payment grant (plus quotes) on the wallet address's auth server. Returns the URL to
// send the account holder to (their bank's consent screen) and what's needed to continue after they approve.
async function requestOutgoingPaymentGrant({ walletAddress, limits, finishUri, nonce }) {
  const wa = await getWalletAddress(walletAddress)
  const grant = await signedRequest('POST', wa.authServer, {
    body: {
      access_token: {
        access: [
          { type: 'quote', actions: ['create', 'read'] },
          { type: 'outgoing-payment', actions: ['create', 'read', 'list'], identifier: wa.id, limits }
        ]
      },
      client: clientWalletAddress,
      interact: { start: ['redirect'], finish: { method: 'redirect', uri: finishUri, nonce } }
    }
  })
  if (!grant.interact?.redirect) throw new Error('The auth server did not ask for interaction')
  return { walletAddress: wa, redirect: grant.interact.redirect, finishNonce: grant.interact.finish, continueUri: grant.continue.uri, continueToken: grant.continue.access_token.value }
}

// After the redirect back: exchange interact_ref for the access token. The auth server refuses a continue sooner
// than its "wait" period after the grant request (too_fast), which only a scripted approval can hit.
async function continueGrant({ continueUri, continueToken, interactRef }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await signedRequest('POST', continueUri, { token: continueToken, body: { interact_ref: interactRef } })
      if (!result.access_token) throw new Error('The auth server returned no access token')
      return result.access_token // { value, manage, expires_in, access }
    } catch (err) {
      if (err.body?.error?.code !== 'too_fast' || attempt >= 10) throw err
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

async function rotateToken({ manage, value }) {
  const result = await signedRequest('POST', manage, { token: value })
  return result.access_token
}

function revokeToken({ manage, value }) {
  return signedRequest('DELETE', manage, { token: value })
}

const createQuote = (resourceServer, token, body) => signedRequest('POST', `${resourceServer}/quotes`, { token, body })
const createOutgoingPayment = (resourceServer, token, body) => signedRequest('POST', `${resourceServer}/outgoing-payments`, { token, body })

module.exports = {
  clientWalletAddress,
  ensureClient,
  getWalletAddress,
  requestOutgoingPaymentGrant,
  continueGrant,
  rotateToken,
  revokeToken,
  createQuote,
  createOutgoingPayment
}
