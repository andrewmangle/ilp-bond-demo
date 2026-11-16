# Rhyza issues found while porting the bond demo

Found against commit `259a9b94fb8feb14882997ed69cc188f905ad68b` (also `main` on Nov 15, 2026), running
`docker/docker-compose.yaml` + `docker/docker-compose.node-b.yaml`.

| # | Status on GitHub (Nov 15, 2026) |
|---|---|
| 1 | Already filed as [#425](https://github.com/interledger/rhyza/issues/425); we added a [repro comment](https://github.com/interledger/rhyza/issues/425#issuecomment-6905654249) |
| 2 | Already filed as [#424](https://github.com/interledger/rhyza/issues/424); we added a [repro comment](https://github.com/interledger/rhyza/issues/424#issuecomment-6905653965) with the workaround |
| 3 | Filed as [#465](https://github.com/interledger/rhyza/issues/465) |
| 4 | Filed as [#466](https://github.com/interledger/rhyza/issues/466) |
| 5 | Phase 4, **not filed yet** (needs Andrew's OK) |
| 6 | Phase 4, **not filed yet** |
| 7 | Phase 4, **not filed yet** |
| 4b | Phase 4, comment for #466, **not posted yet** |

The texts below are the drafts they came from.

---

## 1. Payments between peers in different assets fail: peer ledger accounts exist only in the peer's asset

**What happens.** Node B has assets USD and EUR, and one peer (Node A) whose asset is USD. A wallet on
Node B holds EUR.

- Incoming: A (USD wallet) pays an EUR payment intent on B. The quote completes (rate 0.92, see issue 2),
  but the payment fails. B logs `handleFailInboundPaymentCommand ... reason: Account(s) not found for
  ReserveTransferCmd`, and A sees `REJECTED` (T00).
- Outgoing: B's EUR wallet pays a USD intent on A. The quote completes (rate 1.0869...), but the payment
  fails with `failReason: "Account(s) not found for CheckBalanceAndReserveTransferCmd"`.

**Why.** `pal-event-handler-service` `_handlePeerCreatedEvent` sends `CreateLedgerAccountsForPeerCmd(evt.payload.assetCode, ...)`,
so a peer's clearing, liquidity and suspense accounts are created only in the ledger for the peer's asset
(USD). `_handleInboundPaymentValidated` reserves in the **receive** asset's ledger
(`new ReserveTransferCmd(evt.payload.receiveAssetCode, { peerId, ... })`), and the outgoing reservation
uses the sender's asset ledger. In the EUR ledger the peer has no accounts.

Creating the EUR asset before the peer makes no difference, because peer accounts are only ever created
in the peer's asset.

**Expected.** A node whose customers hold a currency other than the peering asset can send and receive
across the peer, converting at its pushed rates (the quotes already do this).

**Repro.** Two nodes peered in USD; on B `POST /assets {code:"EUR",scale:2}`, an EUR wallet address, rates via
`POST /rates`; A quotes and pays an amountless intent on the EUR wallet.

---

## 2. Inbound FX lookup asks for PEER_ASSET -> PEER_ASSET instead of PEER_ASSET -> intent asset

**What happens.** With peer rates pushed on B (`USD->EUR` and `EUR->USD`, `peerId` = A), A's quote for an EUR
intent on B fails with `500 {"error":"13 INTERNAL: "}`. B logs `Could not get FX rate from PAL for peer ... source
asset USD`, and `pal-api-service-b` logs `Getting Peer fx rate from ASE endpoint for USD -> USD`, then
`fetch failed` (the pull fallback, `http://localhost:7000/rates` by default).

**Why.** `payments-domain-lib` `_collectInboundFxLookup` requests `{ peerId, sourceAssetCode: peerAssetCode }`.
`pal-api-service` `handleGetFxRateRequest` fills in the destination for a "from source" request as
`peer.assetCode`, so the stored rate id it looks for is `USD/USD/PeerRate/<peer>`, never `USD/EUR`.

**Expected.** The inbound conversion uses the rate from the peer asset to the intent's asset (for example a
"to destination" request with `destinationAssetCode: intent.assetCode`, which resolves to `USD -> EUR`).

**Workaround seen to work.** Pushing a peer rate `USD -> USD = 0.92` on B makes the quotes complete at 0.92
(the payments then hit issue 1).

**Side note.** `payments-api-service` logs `Unknown response event: msgName: RemoteQuoteRequestedEvent` and returns
`13 INTERNAL` with an empty message when a remote quote fails, which hides the cause from the caller.

---

## 3. Ledger command handler crashes on amounts with fewer digits than the scale (1 to 9 cents)

**What happens.** A payment of 0.04 USD (value `"4"`, scale 2) is approved and then stays `PROCESSING` for good.
`pal-ledger-command-handler-service` logs `LedgerPrecisionLossError: Amount input error: sourceAmount (4) is
smaller than sourceScale (2).` then `UncaughtException - EXITING...`, and restarts. Afterwards that node's
ledger stopped settling other payments (a 100.00 USD payment then hung in `SENDING`) until the stack was
wiped (`down --volumes`).

**Why.** `pal-domain-lib/src/liquidity/utils.ts` `amountToBigIntOfSize` throws when
`absoluteAmount.length < sourceScale`. The length of an integer amount string says nothing about precision:
`"4"` at scale 2 is 0.04 and is valid. The error is not caught in `_processCheckBalanceAndReserveCmd`, so the
process exits.

**Expected.** Any non-negative integer amount is accepted (only `sourceScale > targetScale` loses precision).
A bad command should fail that transfer, not crash the handler.

---

## 4. Node B's Open Payments auth server never starts in the two-node compose

**What happens.** `open-payments-auth-service-b` exits with `REDIS_URL is not set; refusing to start without
a shared session store` and restarts forever.

**Why.** `docker/docker-compose.node-b.yaml` leaves out `REDIS_URL` and `SESSION_SECRET`, which
`docker-compose.yaml` sets for Node A's `open-payments-auth-service`.

**Fix.** Add `REDIS_URL: redis-b:6379`, `SESSION_SECRET: ...` and `depends_on: redis-b (service_healthy)`.

---

## 5. Interactive grants can never finish: GetGrant drops interactionNonce, so /interaction/{id}/finish always answers 401

**Found at:** `main` [`259a9b94`](https://github.com/interledger/rhyza/tree/259a9b94fb8feb14882997ed69cc188f905ad68b), two-node compose.

## What happens

An interactive outgoing-payment grant can't be finished. After the client's grant request, `GET /interaction/{id}/start` (session cookie set, redirect to `IDP_URL`) and the IdP's `POST /interaction/{id}/accept` (202), the browser's `POST /interaction/{id}/finish` with the session cookie always answers **401**. The client never gets `interact_ref`, so it can't continue the grant and never gets a token.

The session is fine: Redis holds `op-auth:session:<id>` with `interactionSessionId` set to the grant's nonce, and the same cookie is accepted and refreshed by the finish request.

## Why

The finish route [compares the session's nonce with `grant.interactionNonce`](https://github.com/interledger/rhyza/blob/259a9b94fb8feb14882997ed69cc188f905ad68b/packages/open-payments-auth-service/src/routes/interaction.ts#L44), and `grant` comes from `authClient.getGrant()`. But `auth-api-service` [`_toPbGrant`](https://github.com/interledger/rhyza/blob/259a9b94fb8feb14882997ed69cc188f905ad68b/packages/auth-api-service/src/grpc/grpc-service.ts#L542-L585) never calls `setInteractionNonce`, so `fromPbGrant` in `auth-client-lib` reads `""`, and the comparison can never match.

After the IdP accepts, the Admin API's `GET /grants/{id}` shows `state: "PENDING"`, `interaction.state: "APPROVED"`. Continuing with that `interactRef` anyway answers `500 Unhandled error` (the grant isn't `APPROVED`, since finish never ran).

## Expected

`_toPbGrant` sets `interactionNonce`, so finish moves the grant to `APPROVED` and redirects to the client's finish URI with `hash` and `interact_ref`.

## Repro

1. Register an Ed25519 key for a client wallet address (`POST /wallet-addresses/{id}/keys`).
2. Signed `POST` to the auth server: `outgoing-payment` access for another wallet, `interact: { start: ["redirect"], finish: { method: "redirect", uri, nonce } }`.
3. `GET interact.redirect`, keep the cookie (over plain http the cookie is only set with `X-Forwarded-Proto: https`; see #466).
4. `POST {idp}/interaction/{id}/accept` with `x-idp-secret`.
5. `POST {auth}/interaction/{id}/finish` with the cookie: 401.

Also seen: the `clientName` passed to the IdP is empty although the client wallet address has a `publicName`.

---

## 6. Open Payments POST /quotes answers 404 for a receiver on another node

**Found at:** `main` [`259a9b94`](https://github.com/interledger/rhyza/tree/259a9b94fb8feb14882997ed69cc188f905ad68b), two-node compose.

## What happens

On Node B's Open Payments resource server, `POST /quotes` with `receiver` set to a payment intent on Node A (its `openPaymentsUrl`) always answers:

```
404 {"error":{"code":"NOT_FOUND","description":"Payment intent '<id>' not found"}}
```

The same request with a receiver on Node B succeeds, and the Admin API's `POST /quotes` with the same remote `paymentIntentUrl` succeeds too. So an Open Payments client can't pay anyone on another node.

## Why (likely)

The route creates the quote, then [looks up `result.paymentIntentId`](https://github.com/interledger/rhyza/blob/259a9b94fb8feb14882997ed69cc188f905ad68b/packages/open-payments-resource-service/src/routes/quotes.ts#L169-L171) to fill in `receiveAmount` and `receiver`. For a remote receiver that id doesn't resolve on the sender's node: the quote's intent is the imported copy, and the lookup fails. I haven't checked whether the id is the remote one or the copy's not yet readable, but retrying doesn't help.

## Repro

1. Two nodes peered in USD.
2. On A: `POST /payment-intents` for a wallet on A (Admin API).
3. On B: `POST /quotes` on the Open Payments resource server with `walletAddress` a wallet on B, `receiver` the intent's `openPaymentsUrl`, `method: "ilp"`, a `receiveAmount`: 404.

---

## 7. Open Payments resource server does not check the GNAP access token

**Found at:** `main` [`259a9b94`](https://github.com/interledger/rhyza/tree/259a9b94fb8feb14882997ed69cc188f905ad68b), two-node compose.

## What happens

The Open Payments resource server doesn't check the GNAP access token. On Node B, `POST /quotes` and `POST /outgoing-payments` succeed with `Authorization: GNAP <any string>`, and `POST /quotes` succeeds with no `Authorization` header at all. The outgoing payment was created and sent.

## Why

`getGnapToken` ([auth.ts](https://github.com/interledger/rhyza/blob/259a9b94fb8feb14882997ed69cc188f905ad68b/packages/open-payments-resource-service/src/auth.ts#L3)) only copies the header onto the request. Nothing introspects it or checks its access against the request (incoming payments carry a `TODO: implement token introspection` at [incoming-payments.ts#L194](https://github.com/interledger/rhyza/blob/259a9b94fb8feb14882997ed69cc188f905ad68b/packages/open-payments-resource-service/src/routes/incoming-payments.ts#L194)). Outgoing payments are also created with `grantId: undefined` ([outgoing-payments.ts#L156](https://github.com/interledger/rhyza/blob/259a9b94fb8feb14882997ed69cc188f905ad68b/packages/open-payments-resource-service/src/routes/outgoing-payments.ts#L156)), so no grant is charged; limits are tracked in #278.

## Expected

Each resource server request is checked against the token's grant (introspection, which the Auth BC already has from #193): the action, the `identifier` (wallet address) and, from #278, the limits. A missing or unknown token answers 401.

Filing in case it's not tracked elsewhere; if token checking is meant to happen in a gateway in front of the service, a note in the compose file would help.

---

## 4b. Comment for #466: more two-node compose problems

Three more two-node compose problems at [`259a9b94`](https://github.com/interledger/rhyza/tree/259a9b94fb8feb14882997ed69cc188f905ad68b), all on Node B, found while trying interactive grants:

1. **Wrong auth server URLs.** `open-payments-auth-service` reads `OPEN_PAYMENTS_AUTH_SERVER_URL` ([service.ts#L29](https://github.com/interledger/rhyza/blob/259a9b94fb8feb14882997ed69cc188f905ad68b/packages/open-payments-auth-service/src/service.ts#L29)), but both compose files set `OPEN_PAYMENTS_AUTH_SERVICE_URL`. Node A gets the right value by luck (the default is `http://localhost:3003`); Node B's auth server hands out `interact.redirect` and `continue.uri` on `localhost:3003`, Node A's auth server. Same default in `idp-interaction-service`.
2. **No auth server in Node B's wallet addresses.** `open-payments-resource-service-b` has no `OPEN_PAYMENTS_AUTH_SERVICE_URL`, so its wallet address documents say `"authServer": "localhost:3002"` (the code default: no scheme, and Node A's resource server port).
3. **No `IDP_URL`** on either auth server, so `GET /interaction/{id}/start` throws (`new URL(undefined)`) and answers 500.

And one that affects both nodes: the interaction session cookie is `Secure` by default (`@fastify/session`, [service.ts#L118](https://github.com/interledger/rhyza/blob/259a9b94fb8feb14882997ed69cc188f905ad68b/packages/open-payments-auth-service/src/service.ts#L118)), so over the playground's plain http the start route never sets it and finish answers 401. Sending `X-Forwarded-Proto: https` works around it (`TRUST_PROXY` defaults to true), but a browser won't. `cookie: { secure: 'auto' }` would fit local dev.

What we use meanwhile:

```yaml
  open-payments-auth-service:
    environment:
      IDP_URL: <your consent screen>
  open-payments-auth-service-b:
    environment:
      OPEN_PAYMENTS_AUTH_SERVER_URL: http://localhost:4003
      IDP_URL: <your consent screen>
  open-payments-resource-service-b:
    environment:
      OPEN_PAYMENTS_AUTH_SERVICE_URL: http://localhost:4003
  idp-interaction-service-b:
    environment:
      OPEN_PAYMENTS_AUTH_SERVER_URL: http://localhost:4003
```

---

## Smaller notes

- The OpenAPI `Payment` and `PaymentIntent` schemas have no `metadata`, but the API returns it.
- The Admin API has no health endpoint.
- `redpanda-console` (Node A, 8080) is in the `with-observability` profile, so only Node B's console runs by default.
