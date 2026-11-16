# Rhyza issues found while porting the bond demo

Found against commit `259a9b94fb8feb14882997ed69cc188f905ad68b` (also `main` on Nov 15, 2026), running
`docker/docker-compose.yaml` + `docker/docker-compose.node-b.yaml`.

| # | Status on GitHub (Nov 15, 2026) |
|---|---|
| 1 | Already filed as [#425](https://github.com/interledger/rhyza/issues/425); we added a [repro comment](https://github.com/interledger/rhyza/issues/425#issuecomment-6905654249) |
| 2 | Already filed as [#424](https://github.com/interledger/rhyza/issues/424); we added a [repro comment](https://github.com/interledger/rhyza/issues/424#issuecomment-6905653965) with the workaround |
| 3 | Filed as [#465](https://github.com/interledger/rhyza/issues/465) |
| 4 | Filed as [#466](https://github.com/interledger/rhyza/issues/466) |

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

## Smaller notes

- The OpenAPI `Payment` and `PaymentIntent` schemas have no `metadata`, but the API returns it.
- The Admin API has no health endpoint.
- `redpanda-console` (Node A, 8080) is in the `with-observability` profile, so only Node B's console runs by default.
