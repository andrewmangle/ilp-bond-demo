# Inventory: every place the bond demo touches Rafiki

Branch `rhyza-port`. Written in Phase 0 against Rhyza commit `259a9b9` (Admin API spec 0.0.21).
The Rhyza column uses the mapping in `RHYZA_PORT.md` and was checked against
`rhyza/.rhyza-src/docs/openapi/admin/admin-api.yaml`. "No equivalent yet" means the
pinned spec has nothing that does the job.

Paths are relative to the repo root. `app/` means `localenv/university-payments/`.

## The biggest gap: Rhyza holds no customer balances

Rafiki's localenv ships a mock bank (`localenv/mock-account-servicing-entity`) that holds
customer accounts and balances, moves them on webhooks, serves `/rates`, and runs the
mock IdP consent screen. The demo app reads balances, creates accounts, mints into the
treasury and sets rates through it.

Rhyza's playground equivalent, `ase-mock-service`, does three things only: it approves
each payment on the `paymentCreated` webhook, logs the other webhooks, and serves a fixed
`GET /rates?base=X` table. It has **no accounts, no balances, no add-liquidity action,
no consent screen**. Rhyza's own ledger holds liquidity on peers only.

So in Phase 2 the Rhyza rail must keep customer balances itself (for example a
`rhyza_balances` table in the app's SQLite, debited when a payment it sent completes and
credited when a payment intent it created receives). Minting becomes a book entry in that
table plus a peer liquidity deposit. This is the largest design decision in the port.

## 1. Admin API client

| File / function | Rafiki call | Rhyza equivalent |
|---|---|---|
| `app/lib/admin-api.js` `adminApi(nodeKey, query, vars)` | POST GraphQL to `localhost:x001/graphql` with HMAC `signature` and `tenant-id` headers | `rhyza/lib/rhyza-admin.mjs` `createRhyzaAdmin(baseUrl)`: plain REST on `localhost:3001` (A) and `localhost:4001` (B). The pinned spec has no auth on the Admin API (`security: []`) and no tenants |
| `app/lib/admin-api.js` `signature(body)` | HMAC-SHA256 over canonical JSON | Not needed for Rhyza Admin API. Still used by the Rafiki mock bank `POST /rates` |
| `app/lib/admin-api.js` `AMOUNT` fragment | `value assetCode assetScale` | Rhyza `Amount` has the same three fields (`value` is a string) |

## 2. Node topology and configuration

| File / function | Rafiki | Rhyza equivalent |
|---|---|---|
| `app/lib/nodes.js` `NODES` (hbcu, hague, capetown) | GraphQL URL, tenant id, backend and auth Docker hosts, mock bank URL, mock bank container name, OP and auth ports | `rhyza/config.mjs` `nodes` (a, b). Admin URL, ILP address, connector host, peer ids. Two nodes only; Cape Town is Phase 5. Tenant id: no equivalent (single tenant per instance) |
| `app/lib/nodes.js` `ADMIN_API_SECRET` | HMAC secret | No equivalent (Admin API is unauthenticated in the playground) |
| `app/lib/nodes.js` `TREASURY_PATH` `accounts/treasury` | Mock bank account path | Wallet address `pathName` (single segment, so `treasury`, not `accounts/treasury`) |
| `app/lib/nodes.js` `nodeOfUrl(url)` | Parses the Docker hostname out of a wallet URL | Must not parse Rhyza URLs (ids are opaque). Keep a lookup table from the `address` Rhyza returns to the node |
| `localenv/cloud-nine-wallet/docker-compose.yml`, `localenv/happy-life-bank/docker-compose.yml`, `localenv/cape-town-node/docker-compose.yml`, `localenv/merged/docker-compose.yml`, `localenv/tigerbeetle/docker-compose.yml` | Rafiki stack (Postgres, Redis, TigerBeetle) | `rhyza/.rhyza-src/docker/docker-compose.yaml` + `docker-compose.node-b.yaml`, run by `rhyza/setup.sh` (MongoDB, Kafka, Redis per node) |
| `localenv/*/seed.yml` | Assets, peers, liquidity, accounts, rates per node | `rhyza/seed.mjs` + `rhyza/config.mjs` |
| `package.json` `localenv:compose`, `localenv:university-payments` | pnpm scripts | `rhyza/setup.sh up|down|reset|status|logs`. App start stays the same, selected by `PAYMENT_RAIL` (Phase 2) |

## 3. Assets and liquidity

| File / function | Rafiki call | Rhyza equivalent |
|---|---|---|
| `app/lib/central-bank.js` `getAsset(nodeKey)` | `assetByCodeAndScale(code, scale) { id code scale liquidity }` | `GET /assets` (`listAssets`), find by `code`. Assets are unique by code; there is no asset id and no asset liquidity |
| `app/lib/central-bank.js` `overview(nodeKey)` | `peers { id name staticIlpAddress liquidity asset }` plus mock bank accounts | No list-peers or peer-liquidity read in the spec: no equivalent yet. Balances: from the app's own Rhyza balance table (see gap above) |
| `app/lib/central-bank.js` `mint(nodeKey, amount)` | `depositAssetLiquidity` plus mock bank `intent=add-liquidity` on the treasury | `POST /liquidity/deposit` (`depositLiquidity(peerId, assetCode, amount, amountScale)`) is peer-only. Treasury credit: no equivalent in Rhyza; book it in the app's balance table |
| `app/lib/open-payments.js` `ensureClient()` | `assetByCodeAndScale` to find the asset id for the client wallet | Not needed: wallet addresses take `assetCode` directly |
| `packages/mock-account-service-lib/src/seed.ts` peers | `createPeer`, `depositPeerLiquidity`, `peeringAsset: 'USD:9'` | `POST /peers` (`PeerCreate`: id, name, assetCode, assetScale, ilpStaticAddress, http.outgoing{endpoint, callbackEndpoint, authToken}, http.incoming{authToken}) then `POST /liquidity/deposit` |

## 4. Accounts and wallet addresses

| File / function | Rafiki call | Rhyza equivalent |
|---|---|---|
| `app/lib/mock-bank.js` `listNodeAccounts`, `listAccounts`, `findAccount`, `findTreasury` | Mock bank `GET /?_data=routes%2F_index` (accounts with balances) | No equivalent in Rhyza (no list-wallet-addresses endpoint in the spec, no balances). The app keeps its own account list (address and id returned by Rhyza) and balances |
| `app/lib/mock-bank.js` `createAccount(nodeKey, assetId, name)` | Mock bank `POST /accounts/create`, which calls Rafiki `createWalletAddress` | `POST /wallet-addresses` (`createWalletAddress(pathName, assetCode, publicName)`), returns `{ id, address }` |
| `app/lib/mock-bank.js` `deposit(...)` | Mock bank `intent=add-liquidity` | No equivalent (book entry in the app) |
| `app/lib/open-payments.js` `ensureClient()` | `walletAddressByUrl`, `createWalletAddress`, `createWalletAddressKey` | `POST /wallet-addresses`, `POST /wallet-addresses/{id}/keys`. No get-wallet-by-url; store the id at creation |
| `app/lib/demo.js` `waitForSeeded`, `seed` | Polls mock bank accounts for `accounts/treasury` | Seed creates wallets directly; ready when `rhyza/seed.mjs` (or the app seed) has run |

## 5. Payments

| File / function | Rafiki call | Rhyza equivalent |
|---|---|---|
| `app/lib/payments.js` `quote(...)` step 1 | `createReceiver` (amountless incoming payment, 10 min expiry, metadata) on the sender's node | `POST /payment-intents` on the **receiver's** node (`walletAddress`, optional `incomingAmount`, `expiresAt`, `metadata`). Returns `id` and `openPaymentsUrl` |
| `app/lib/payments.js` `quote(...)` step 2 | `createQuote` with `debitAmount` or `receiveAmount` | `POST /quotes` on the sender's node with `walletAddress`, `paymentIntentUrl`, and `debitAmount` or `receiveAmount` (strings). Returns `id`, local `paymentIntentId`, `debitAmount`, `receiveAmount`, `exchangeRate`, `expiresAt` |
| `app/lib/payments.js` `pay(quoteId)` | `createOutgoingPayment(walletAddressId, quoteId, metadata)` | `POST /payments` with `walletAddress`, `paymentIntentId`, `quoteId`, `metadata`. Needs approval: `ase-mock-service` auto-approves on `paymentCreated` |
| `app/lib/payments.js` `getOutgoingPayment(nodeKey, id)` | `outgoingPayment(id) { state error stateAttempts sentAmount }` | `GET /payment-intents/{intentId}/payments/{id}` (`getPayment`). States CREATED, PROCESSING, SENDING, CONFIRMED, REJECTED, COMPLETED, CANCELLED, FAILED; `failReason` |
| `app/lib/payments.js` `settle(...)` | `receiver(id) { completed receivedAmount }` then `completeReceiver` | `GET /payment-intents/{id}` on the receiver node (`receivedAmount`) and `POST /payment-intents/{id}/complete` |
| `app/lib/payments.js` `settleSending()`, `settledElsewhere()` | Re-reads `outgoingPayment` state | Same with `getPayment` |
| `app/lib/payments.js` `cancelQuote`, `clearPendingQuotes` | App-side only | App-side only. Rhyza also has `POST /payment-intents/{intentId}/payments/{id}/cancel` for created payments |
| `app/lib/payments.js` `payUnderGrant(...)` | `createReceiver`, then Open Payments `POST /quotes` and `POST /outgoing-payments` with a GNAP token | Payment intent as above, then Open Payments on Rhyza's `open-payments-resource-service` (port 3002 / 4002) with a token from `open-payments-auth-service` (3003 / 4003). Phase 4 |
| `app/lib/payments.js` `quoteAndPay` | Wrapper | Same wrapper over the Rhyza rail |

## 6. Grants and Open Payments client (Phase 4)

| File / function | Rafiki call | Rhyza equivalent |
|---|---|---|
| `app/lib/open-payments.js` `signedRequest`, `signatureHeaders`, `route` | HTTP message signatures, Docker-hostname routing to `localhost:x000` / `x006` | Same Open Payments protocol against Rhyza's resource server (3002 / 4002) and auth server (3003 / 4003). Rhyza also runs `http-signature-service` (3010) |
| `app/lib/open-payments.js` `requestOutgoingPaymentGrant`, `continueGrant`, `rotateToken`, `revokeToken` | GNAP against Rafiki auth (x006) | GNAP against `open-payments-auth-service`. Admin `GET /grants`, `GET /grants/{id}`, `POST /grants/{id}/revoke` |
| `app/lib/coupons.js` `requestGrant`, `finishGrant`, `completeGrant`, `freshToken`, revoke on default | Uses the above | Same, once Phase 4 lands |
| `app/lib/plans.js` grant set-up, `finishGrant`, revoke | Uses the above | Same, once Phase 4 lands |
| Consent screen: mock bank `/mock-idp/`, IdP API `localhost:x009/grant/<id>/<nonce>/accept` with `x-idp-secret` | Rafiki auth plus mock bank | `idp-interaction-service` (3004 / 4004), `docs/openapi/idp-service-api.yaml`. Least documented; spike first |

## 7. Activity, live feed, webhooks

| File / function | Rafiki call | Rhyza equivalent |
|---|---|---|
| `app/lib/central-bank.js` `activity(nodeKey)` | `outgoingPayments(first, sortOrder: DESC)` and `incomingPayments(first, sortOrder: DESC)` | `GET /payments?first=&sortOrder=desc` and `GET /payment-intents?first=&sortOrder=desc` (max 100 per page, cursor paging) |
| `app/lib/live.js` `collect()` | `outgoingPayments(first: 40)` with debit, sent and receive amounts | `GET /payments?first=40` (`debitAmount`, `receiveAmount`, `sentAmount`). Payment metadata is not in the `Payment` schema, so types and names must come from SQLite |
| `localenv/mock-account-servicing-entity/app/lib/webhooks.server.ts` | `outgoing_payment.created/completed/failed`, `incoming_payment.completed/expired` move mock bank balances | Rhyza events `paymentIntentCreated`, `paymentIntentCompleted`, `paymentCreated`, `paymentCompleted`, `paymentFailed`, `grantRevoked`. `WEBHOOK_URL` points at `ase-mock-service`, which only approves. Phase 2 plan: keep that and poll |

## 8. Exchange rates

| File / function | Rafiki call | Rhyza equivalent |
|---|---|---|
| `app/lib/mock-bank.js` `getUsdRates(nodeKey)` | Mock bank `GET /rates?base=USD` | No read endpoint in the Rhyza Admin API. The app keeps the rate it set (it already stores rates in SQLite) |
| `app/lib/mock-bank.js` `setUsdRate(nodeKey, currency, perUsd)` | Signed mock bank `POST /rates` | `POST /rates` (`setRate(source, destination, rate, { peerId, rateTtlSecs })`). Rates expire after `rateTtlSecs` |
| `app/lib/central-bank.js` `getRate`, `setRate`, `syncRates`, `rateHistory` | Uses the above; re-applies every 30 s | Same logic over `setRate`; `syncRates` must re-push before the TTL lapses |
| `app/lib/bonds.js`, `app/lib/coupons.js`, `app/lib/plans.js` `getUsdRates('hbcu')` | Estimates cross-currency cost | Read from the app's stored rates |
| `localenv/mock-account-servicing-entity/app/routes/rates.ts` | Rafiki pulls rates via `EXCHANGE_RATES_URL` | Push with `POST /rates`, or `ase-mock-service` `GET /rates` (fixed table) |

## 9. Reset, seed and start scripts

| File / function | Rafiki | Rhyza equivalent |
|---|---|---|
| `scripts/demo-start.sh` | `pnpm localenv:compose up -d`, waits on `localhost:3001/healthz` and mock banks | `rhyza/setup.sh up`, then `node rhyza/seed.mjs`; app with `PAYMENT_RAIL=rhyza` |
| `scripts/demo-stop.sh` | `pnpm localenv:compose down` | `rhyza/setup.sh down` |
| `scripts/demo-reset.sh`, `app/lib/demo.js` `reset`, `resetMockBank` | Wipes demo tables, `docker exec rm` mock bank state file, `docker restart` mock bank containers | Wipe demo tables and the app's Rhyza balance table. No mock bank state to clear. Full wipe: `rhyza/setup.sh reset` |
| `app/lib/demo.js` `seed` | Mints, funds students, issues Amara's bond | Same steps over the Rhyza rail |
| `app/lib/demo.js` `health` | Probes mock banks and `/healthz` | Probe `localhost:3001` / `4001` (`/healthz` on the Admin API, to be confirmed) |
| `scripts/demo-status.sh` | `docker ps --filter name=rafiki-` | `rhyza/setup.sh status` (compose project `rhyza-bonds`) |
| `scripts/demo-lib.sh` `wait_for_seeded` | Mock bank accounts list contains the treasury | No mock bank accounts; check the app's seed state |

## 10. Environment variables

| Variable | Where | Rhyza |
|---|---|---|
| `PORT` | `app/server.js` | Unchanged |
| `DB_FILE` | `app/lib/db.js` | Unchanged; use a separate file per rail so the registries never mix |
| `CLIENT_KEY_FILE` | `app/lib/open-payments.js` | Unchanged (Phase 4) |
| `PAYMENT_RAIL` | new (Phase 2) | `rafiki` (default) or `rhyza` |
| `RHYZA_ADMIN_A`, `RHYZA_ADMIN_B` | `rhyza/config.mjs` | Override Admin API URLs |
| `RHYZA_REF`, `RHYZA_OBSERVABILITY` | `rhyza/setup.sh` | Pin override, observability profile |
| Rafiki compose: `EXCHANGE_RATES_URL`, `EXCHANGE_RATES_LIFETIME`, `SLIPPAGE`, `MAX_OUTGOING_PAYMENT_RETRY_ATTEMPTS`, `USE_TIGERBEETLE`, `DISPLAY_NAME`, `WEBHOOK_URL` | Node compose files | `WEBHOOK_URL` exists in Rhyza (`notifications-command-handler-service`). Rates are pushed with `POST /rates`. The others: no equivalent yet |

## Port overlap with Rafiki

The Rhyza playground binds 3000, 3001, 3002, 3003, 3004, 3010, 4000, 4001, 4002, 4003,
4004, 4100, 4300, 6379 and more. Rafiki's HBCU and Hague nodes use 3000, 3001, 3010,
4000 and 4001. Never run both stacks at once.
