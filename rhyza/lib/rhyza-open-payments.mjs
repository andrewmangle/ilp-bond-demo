// Open Payments client for the Rhyza playground (Phase 4): GNAP grants on a node's open-payments-auth-service,
// quotes and outgoing payments on its open-payments-resource-service, and the identity provider API on its
// idp-interaction-service (docs/openapi/idp-service-api.yaml). No dependencies: Node 18+.
//
// The Admin API stays in rhyza-admin.mjs; this file covers the client-facing APIs.
//
// Requests are signed with HTTP message signatures (RFC 9421) as @interledger/http-signature-utils does
// (label sig1, params keyid then created, covering @method, @target-uri, authorization and the content
// headers). The servers rebuild the signed URL from the Host header, so a request to a Docker hostname
// (open-payments-resource-service-b:3002) goes to its localhost port with the original Host header.

import http from 'node:http';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { nodes, IDP_SECRET } from '../config.mjs';

// Docker host:port (as wallet address URLs carry it) -> localhost port
const LOCAL_PORT = Object.fromEntries(Object.values(nodes).map((n) => [n.openPayments.dockerHost, n.openPayments.localPort]));

function route(url) {
  const u = new URL(url);
  if (LOCAL_PORT[u.host]) return { u, port: LOCAL_PORT[u.host] };
  if (u.hostname === 'localhost') return { u, port: Number(u.port || 80) };
  throw new Error(`Don't know how to reach ${u.host} from the host`);
}

function request(method, url, { headers = {}, body } = {}) {
  const { u, port } = route(url);
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port, method, path: u.pathname + u.search, headers: { ...headers, host: u.host }, timeout: 20000 },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = raw;
          try { data = raw ? JSON.parse(raw) : null; } catch { /* keep text */ }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${url} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class OpenPaymentsError extends Error {
  constructor(method, url, status, body) {
    const detail = typeof body === 'string' ? body : body?.error?.description || body?.error?.code || body?.message || JSON.stringify(body);
    super(`${method} ${url} -> ${status} ${detail}`);
    this.status = status;
    this.body = body;
  }
}

const ok = (method, url) => (res) => {
  if (res.status >= 400) throw new OpenPaymentsError(method, url, res.status, res.data);
  return res.data;
};

// The public JWK for an Ed25519 private KeyObject, for createWalletAddressKey
export function publicJwk(keyId, privateKey) {
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' });
  return { kid: keyId, x, alg: 'EdDSA', kty: 'OKP', crv: 'Ed25519', use: 'sig' };
}

// A client signing with { keyId, privateKey } as the wallet address `clientWalletAddress`
export function createOpenPaymentsClient({ clientWalletAddress, keyId, privateKey }) {
  function signedHeaders(method, url, { token, payload }) {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `GNAP ${token}`;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
      headers['content-digest'] = `sha-512=:${createHash('sha512').update(payload).digest('base64')}:`;
    }
    const components = ['@method', '@target-uri'];
    if (headers.authorization) components.push('authorization');
    if (headers['content-digest']) components.push('content-digest', 'content-length', 'content-type');
    const created = Math.floor(Date.now() / 1000);
    const params = `(${components.map((c) => `"${c}"`).join(' ')});keyid="${keyId}";created=${created}`;
    const value = (c) => (c === '@method' ? method : c === '@target-uri' ? url : headers[c]);
    const base = [...components.map((c) => `"${c}": ${value(c)}`), `"@signature-params": ${params}`].join('\n');
    headers.signature = `sig1=:${sign(null, Buffer.from(base), privateKey).toString('base64')}:`;
    headers['signature-input'] = `sig1=${params}`;
    return headers;
  }

  const signed = (method, url, { token, body } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return request(method, url, { headers: signedHeaders(method, url, { token, payload }), body: payload }).then(ok(method, url));
  };

  return {
    clientWalletAddress,
    getWalletAddress: (url) => request('GET', url, { headers: { accept: 'application/json' } }).then(ok('GET', url)),

    // GNAP grant request (POST to the auth server's root). Returns the auth server's response as is.
    requestGrant: (authServer, { access, interact }) =>
      signed('POST', authServer.endsWith('/') ? authServer : `${authServer}/`, {
        body: { access_token: { access }, client: clientWalletAddress, ...(interact ? { interact } : {}) }
      }),
    continueGrant: (continueUri, continueToken, interactRef) =>
      signed('POST', continueUri, { token: continueToken, body: interactRef ? { interact_ref: interactRef } : {} }),
    rotateToken: (manageUrl, token) => signed('POST', manageUrl, { token }),
    revokeToken: (manageUrl, token) => signed('DELETE', manageUrl, { token }),

    createQuote: (resourceServer, token, body) => signed('POST', `${resourceServer}/quotes`, { token, body }),
    createOutgoingPayment: (resourceServer, token, body) => signed('POST', `${resourceServer}/outgoing-payments`, { token, body }),
    getOutgoingPayment: (url, token) => signed('GET', url, { token })
  };
}

// Unsigned request that does not follow redirects, for stepping through the interaction as a browser would.
// `cookie` is sent if given; the response's set-cookie and location come back.
//
// Sent with X-Forwarded-Proto: https. The auth server keeps the interaction session in a cookie that
// @fastify/session marks Secure by default and so never sets over plain http; the auth server trusts proxy
// headers (TRUST_PROXY defaults to true), so this header makes it set the cookie. A browser on the http
// playground can't do that, which is why the FSP (the demo app) makes the start and finish calls itself.
export async function browserStep(method, url, { cookie, form } = {}) {
  const headers = { 'x-forwarded-proto': 'https' };
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) {
    body = new URLSearchParams(form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  const res = await request(method, url, { headers, body });
  const setCookie = [res.headers['set-cookie'] ?? []].flat().map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, location: res.headers.location ?? null, cookie: setCookie || cookie || null, data: res.data };
}

// The identity provider API: what the FSP's consent screen calls to show a grant and record the decision
export function createIdpClient(idpUrl, secret = IDP_SECRET) {
  const call = (method, path) =>
    request(method, idpUrl + path, { headers: { 'x-idp-secret': secret, accept: 'application/json' } }).then(ok(method, idpUrl + path));
  return {
    getGrant: (grantId) => call('GET', `/grant/${encodeURIComponent(grantId)}`),
    accept: (grantId) => call('POST', `/interaction/${encodeURIComponent(grantId)}/accept`),
    reject: (grantId) => call('POST', `/interaction/${encodeURIComponent(grantId)}/reject`)
  };
}
