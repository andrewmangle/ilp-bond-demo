// Minimal client for the Rhyza Admin REST API (spec version 0.0.21).
// No dependencies: needs Node 18+ for built-in fetch.
// This file is the only place the bond demo talks to Rhyza, so when the
// alpha API changes, this is the only file to fix.

export class RhyzaError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} -> ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export function createRhyzaAdmin(baseUrl) {
  const call = async (method, path, body) => {
    const url = baseUrl + path;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new Error(`Cannot reach ${url}. Is the playground up? (./rhyza/setup.sh status) [${e.cause?.code ?? e.message}]`);
    }
    const text = await res.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) throw new RhyzaError(method, url, res.status, data);
    return data;
  };

  return {
    baseUrl,
    createAsset: (code, scale) => call('POST', '/assets', { code, scale }),
    listAssets: () => call('GET', '/assets'),
    createWalletAddress: (pathName, assetCode, publicName) =>
      call('POST', '/wallet-addresses', { pathName, assetCode, publicName }),
    createPeer: (peer) => call('POST', '/peers', peer),
    depositLiquidity: (peerId, assetCode, amount, amountScale) =>
      call('POST', '/liquidity/deposit', { peerId, assetCode, amount, amountScale }),
    setRate: (sourceAssetCode, destinationAssetCode, rate, { peerId = null, rateTtlSecs = 3600 } = {}) =>
      call('POST', '/rates', { sourceAssetCode, destinationAssetCode, rate, peerId, rateTtlSecs }),

    // Rafiki "incoming payment" == Rhyza "payment intent".
    // incomingAmount may be undefined for an amountless intent (spec: PaymentIntentCreate).
    createPaymentIntent: (walletAddress, incomingAmount, metadata, { expiresAt } = {}) =>
      call('POST', '/payment-intents', {
        walletAddress,
        ...(incomingAmount !== undefined ? { incomingAmount } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(metadata ? { metadata } : {})
      }),
    getPaymentIntent: (id) => call('GET', `/payment-intents/${encodeURIComponent(id)}`),
    // POST /payment-intents/{id}/complete. 409 if it cannot be completed in its current state.
    completePaymentIntent: (id) => call('POST', `/payment-intents/${encodeURIComponent(id)}/complete`),
    // GET /payment-intents: cursor paging, newest first by default, first <= 100
    listPaymentIntents: (query = {}) => call('GET', `/payment-intents${qs(query)}`),

    // Quote a payment intent named by its Open Payments URL (imported if another node holds it).
    // debitAmount or receiveAmount fixes one side, as a string of minor units (spec: QuoteCreateBase).
    createQuote: (walletAddress, paymentIntentUrl, { debitAmount, receiveAmount } = {}) =>
      call('POST', '/quotes', {
        walletAddress,
        paymentIntentUrl,
        ...(debitAmount !== undefined ? { debitAmount: String(debitAmount) } : {}),
        ...(receiveAmount !== undefined ? { receiveAmount: String(receiveAmount) } : {})
      }),

    // Rafiki "outgoing payment" == Rhyza "payment"
    createPayment: (walletAddress, paymentIntentId, quoteId, metadata) =>
      call('POST', '/payments', { walletAddress, paymentIntentId, quoteId, ...(metadata ? { metadata } : {}) }),
    getPayment: (intentId, id) =>
      call('GET', `/payment-intents/${encodeURIComponent(intentId)}/payments/${encodeURIComponent(id)}`),
    approvePayment: (intentId, id) =>
      call('POST', `/payment-intents/${encodeURIComponent(intentId)}/payments/${encodeURIComponent(id)}/approve`),
    // POST .../cancel with PaymentCancel { reason }
    cancelPayment: (intentId, id, reason) =>
      call('POST', `/payment-intents/${encodeURIComponent(intentId)}/payments/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {}),
    // GET /payments: optional walletAddressId, paymentIntentId, cursor, first, last, sortOrder
    listPayments: (query = {}) => call('GET', `/payments${qs(query)}`),

    // There is no health endpoint in the Admin API spec; listing assets is the cheapest read
    ping: () => call('GET', '/assets')
  };
}

function qs(query) {
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null);
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : '';
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED']);

// Payments are asynchronous. The playground's mock FSP service approves each
// payment when it receives the payment-created webhook; we just poll.
export async function waitForPayment(admin, intentId, paymentId, { timeoutMs = 30000, everyMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await admin.getPayment(intentId, paymentId);
    if (TERMINAL.has(last.state)) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`Payment ${paymentId} still ${last?.state ?? 'unknown'} after ${timeoutMs / 1000}s`);
}

// One cross-node transfer: receiver node creates the intent, sender node quotes and pays.
export async function sendAcrossNodes({ from, to, senderWallet, receiverWallet, amount, metadata }) {
  const intent = await to.createPaymentIntent(receiverWallet, amount, metadata);
  if (!intent.openPaymentsUrl) throw new Error('Payment intent came back without openPaymentsUrl');
  const quote = await from.createQuote(senderWallet, intent.openPaymentsUrl);
  if (quote.state && quote.state !== 'COMPLETED') throw new Error(`Quote is ${quote.state}`);
  const payment = await from.createPayment(senderWallet, quote.paymentIntentId, quote.id, metadata);
  const done = await waitForPayment(from, payment.paymentIntentId ?? quote.paymentIntentId, payment.id);
  const received = await to.getPaymentIntent(intent.id);
  return { intent, quote, payment: done, received };
}
