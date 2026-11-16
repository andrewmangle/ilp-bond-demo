#!/usr/bin/env node
// Phase 4 spike: a coupon paid under an Open Payments grant between the two Rhyza nodes, with no browser.
//   1. The bond desk (an Open Payments client) gets a wallet address on Node A and registers its Ed25519 key.
//   2. It asks Node B's auth server for an interactive outgoing-payment grant on the issuer's wallet, with a
//      debitAmount limit and a repeating interval (as coupons.js does).
//   3. Interaction, as the browser and the FSP's consent screen would do it: GET interact.redirect (the auth
//      server sets a session cookie and redirects to IDP_URL), the IdP reads the grant and accepts it, then
//      POST /interaction/{id}/finish with the cookie redirects to the client's finish URI with interact_ref.
//   4. Continue the grant for an access token.
//   5. A payment intent on Node A (Admin API), then a quote and an outgoing payment on Node B's resource
//      server under the token; poll until it is final.
//   6. Probes: an over-limit payment and a payment with a made-up token (records what Rhyza does).
// Exits non-zero if steps 1 to 5 fail. Probes only report.
import { generateKeyPairSync, randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRhyzaAdmin, waitForPayment } from './lib/rhyza-admin.mjs';
import { createOpenPaymentsClient, createIdpClient, browserStep, publicJwk } from './lib/rhyza-open-payments.mjs';
import { nodes, ASSET, SCALE } from './config.mjs';

const STATE = fileURLToPath(new URL('./.state.json', import.meta.url));
if (!existsSync(STATE)) { console.error('No rhyza/.state.json. Run: node rhyza/seed.mjs'); process.exit(1); }
const { wallets } = JSON.parse(readFileSync(STATE, 'utf8'));
const A = createRhyzaAdmin(nodes.a.adminUrl);
const B = createRhyzaAdmin(nodes.b.adminUrl);
const run = randomUUID().slice(0, 6);
const amt = (value) => ({ value: String(value), assetCode: ASSET, assetScale: SCALE });
const step = (n, text) => console.log(`\n${n}. ${text}`);
const show = (label, x) => console.log(`   ${label}: ${typeof x === 'string' ? x : JSON.stringify(x)}`);

step(1, 'Client wallet address and key on Node A');
const desk = await A.createWalletAddress(`bond-desk-${run}`, ASSET, 'University Bond Desk');
const { privateKey } = generateKeyPairSync('ed25519');
const keyId = `bond-desk-${run}`;
await A.createWalletAddressKey(desk.id, publicJwk(keyId, privateKey));
show('client', desk.address);
const op = createOpenPaymentsClient({ clientWalletAddress: desk.address, keyId, privateKey });
show('jwks', await op.getWalletAddress(`${desk.address}/jwks.json`));

const issuer = await B.createWalletAddress(`spike-issuer-${run}`, ASSET, 'Spike Issuer');
const issuerDoc = await op.getWalletAddress(issuer.address);
show('issuer wallet', issuerDoc);

step(2, "Interactive grant on Node B's auth server");
const finishUri = 'http://localhost:3040/grants/finish';
const clientNonce = randomBytes(16).toString('hex');
const limit = amt(500); // 5.00 per interval
const grant = await op.requestGrant(issuerDoc.authServer, {
  access: [
    { type: 'quote', actions: ['create', 'read'] },
    { type: 'outgoing-payment', actions: ['create', 'read', 'list'], identifier: issuerDoc.id,
      limits: { debitAmount: limit, interval: `R/${new Date().toISOString()}/PT1H` } }
  ],
  interact: { start: ['redirect'], finish: { method: 'redirect', uri: finishUri, nonce: clientNonce } }
});
show('response', grant);
if (!grant.interact?.redirect) throw new Error('No interact.redirect');

step(3, 'Interaction (browser + IdP)');
const start = await browserStep('GET', grant.interact.redirect);
show('start', { status: start.status, location: start.location, cookie: !!start.cookie });
const idpRedirect = new URL(start.location);
const interactId = idpRedirect.searchParams.get('interactId');
show('IdP receives', Object.fromEntries(idpRedirect.searchParams));
const idp = createIdpClient(nodes.b.idpUrl);
show('IdP getGrant', await idp.getGrant(interactId));
await idp.accept(interactId);
show('IdP accept', 'ok');
const finishUrl = new URL(`/interaction/${encodeURIComponent(interactId)}/finish`, issuerDoc.authServer).href;
const finish = await browserStep('POST', finishUrl, { cookie: start.cookie });
show('finish', { status: finish.status, location: finish.location, body: finish.data });
let interactRef;
if (finish.location) {
  const back = new URL(finish.location);
  interactRef = back.searchParams.get('interact_ref');
  show('back at client', Object.fromEntries(back.searchParams));
} else {
  // Rhyza bug at the pin: GetGrant never returns interactionNonce, so finish always answers 401. Diagnostic
  // only: read the interact_ref from the Admin API and try to continue anyway.
  const g = await B.getGrant(interactId);
  show('FAIL finish; Admin API grant', { state: g.state, interaction: g.interaction });
  interactRef = g.interaction?.interactRef;
  process.exitCode = 1;
}

step(4, 'Continue for an access token');
let token;
for (let i = 0; i < 10 && !token; i++) {
  try { token = (await op.continueGrant(grant.continue.uri, grant.continue.access_token.value, interactRef)).access_token; }
  catch (e) {
    if (e.body?.error?.code === 'too_fast' && i < 9) { await new Promise((r) => setTimeout(r, 1000)); continue; }
    show('FAIL continue', e.message);
    break;
  }
}
show('access_token', token ?? 'none');
if (!token) {
  console.log('\n   No token, so the payment steps cannot run. Probe: an outgoing payment with no grant at all.');
  token = { value: 'no-grant-token' };
}

step(5, 'Coupon: intent on Node A, quote and outgoing payment on Node B under the token');
async function payUnderToken(value, tokenValue, label) {
  const intent = await A.createPaymentIntent(wallets.investor.address, undefined, { type: 'coupon', run });
  const quote = await op.createQuote(issuerDoc.resourceServer, tokenValue, {
    walletAddress: issuerDoc.id, receiver: intent.openPaymentsUrl, method: 'ilp', receiveAmount: amt(value)
  });
  const payment = await op.createOutgoingPayment(issuerDoc.resourceServer, tokenValue, {
    walletAddress: issuerDoc.id, quoteId: quote.id, metadata: { type: 'coupon', run, label }
  });
  return { intent, quote, payment };
}
let passed = false;
try {
  const coupon = await payUnderToken(125, token.value, 'coupon');
  show('quote', { id: coupon.quote.id, debit: coupon.quote.debitAmount, receive: coupon.quote.receiveAmount });
  let final = null;
  for (let i = 0; i < 30; i++) {
    const p = await op.getOutgoingPayment(coupon.payment.id, token.value);
    if (p.failed || BigInt(p.sentAmount?.value ?? 0) >= BigInt(p.debitAmount?.value ?? 1)) { final = p; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await A.completePaymentIntent(coupon.intent.id).catch(() => {});
  const received = await A.getPaymentIntent(coupon.intent.id);
  passed = !!final && !final.failed && Number(received.receivedAmount?.value) === 125;
  console.log(`   ${passed ? 'PASS' : 'FAIL'}: sent ${final?.sentAmount?.value ?? '?'}, received ${received.receivedAmount?.value ?? '?'} of 125`);
} catch (e) {
  show('FAIL', e.message);
}

step(6, 'Probes (report only)');
for (const [label, value, tok] of [['over the 5.00 limit (6.00)', 600, token.value], ['made-up token', 150, 'not-a-real-token']]) {
  try {
    const r = await payUnderToken(value, tok, label);
    show(label, `ACCEPTED (outgoing payment ${r.payment.id})`);
  } catch (e) {
    show(label, `refused: ${e.message}`);
  }
}
if (!passed) process.exitCode = 1;
console.log(process.exitCode ? '\nGrant spike FAILED (see rhyza/README.md, Phase 4).' : '\nGrant spike passed.');
