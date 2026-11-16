# Porting the ILP bond demo to Rhyza: findings for the Interledger team

Status as of Nov 15, 2026. Branch `rhyza-port` of this repo.

## What this is

A demo for the Interledger Foundation: university central banks on Interledger, where students issue bonds,
buy them and receive coupons. The first version runs on three local Rafiki nodes (branch `main`) and keeps
working. This branch builds a second version on Rhyza, behind a switch in the demo app
(`PAYMENT_RAIL=rafiki|rhyza`), to see how far the alpha gets with a real app on top.

All testing was against Rhyza commit
[`259a9b94`](https://github.com/interledger/rhyza/tree/259a9b94fb8feb14882997ed69cc188f905ad68b), which was
also `main` on Nov 15, 2026, using Rhyza's own `docker/docker-compose.yaml` and
`docker/docker-compose.node-b.yaml`, plus a third node made from Node B's file.

## Issues found

| Issue | Area | Effect on the demo | Status |
|---|---|---|---|
| [#425](https://github.com/interledger/rhyza/issues/425) | PAL ledger, payments | Payments between wallets in different assets fail both ways (`Account(s) not found for ReserveTransferCmd` / `CheckBalanceAndReserveTransferCmd`): peer ledger accounts exist only in the peer's asset | Already open; we [confirmed it at 259a9b9](https://github.com/interledger/rhyza/issues/425#issuecomment-6905654249) |
| [#424](https://github.com/interledger/rhyza/issues/424) | Payments FX | Quotes for an intent in another asset fail with `13 INTERNAL`: the inbound rate lookup asks for USD to USD | Already open; we [confirmed it and a workaround](https://github.com/interledger/rhyza/issues/424#issuecomment-6905653965) |
| [#465](https://github.com/interledger/rhyza/issues/465) | PAL ledger | A payment of 0.01 to 0.09 at scale 2 crashes `pal-ledger-command-handler-service`; afterwards the node's ledger stopped settling payments until wiped | Filed |
| [#466](https://github.com/interledger/rhyza/issues/466) | Compose | Node B's Open Payments auth server never starts (`REDIS_URL` missing); [follow-up comment](https://github.com/interledger/rhyza/issues/466#issuecomment-6906352226): Node B's auth URLs point at Node A (env name mismatch), no `IDP_URL`, interaction cookie is `Secure` over plain http | Filed |
| [#467](https://github.com/interledger/rhyza/issues/467) | Auth | Interactive grants never finish: GetGrant drops `interactionNonce`, so `/interaction/{id}/finish` always answers 401 and no token is issued | Filed |
| [#468](https://github.com/interledger/rhyza/issues/468) | Open Payments RS | `POST /quotes` answers 404 when the receiver is on another node, so an Open Payments client can't pay across nodes | Filed |
| [#469](https://github.com/interledger/rhyza/issues/469) | Open Payments RS | The resource server doesn't check the GNAP token: quotes and outgoing payments go through with a made-up token (and quotes with none) | Filed |

Also seen, not filed:

- **Peer tokens must differ per pair.** A connector identifies the sending peer by the incoming token alone
  (`ilp-connector-service` `peer-directory.ts`). With one token shared by all peers, packets from a third node
  were taken as another peer's and the reply went to the wrong connector (`no fulfill/reject callback received
  before expiry`). Probably expected, but worth a line in the peering docs. Peers can't be changed or deleted
  through the Admin API, so fixing it needed a wipe.
- **Kafka group coordinator stuck after a fresh start.** Once, right after `down --volumes` and `up` of three
  nodes, Node B's broker kept rebalancing `notifications-event-handler` every 5 s (`COORDINATOR_NOT_AVAILABLE
  when storing group assignment during SyncGroup`, `__consumer_offsets` partition 38). Payment-created webhooks
  stopped, so payments stayed `CREATED`. Restarting `kafka-b` and the notification services stopped the
  coordinator errors; the two payments created during the outage stayed `CREATED`. Not reproduced yet.
- Grant spend limits are not enforced yet (known: #278).
- The OpenAPI `Payment` and `PaymentIntent` schemas have no `metadata`, but the API returns it. The Admin API
  has no health endpoint. When a remote quote fails, `payments-api-service` logs `Unknown response event:
  RemoteQuoteRequestedEvent` and returns `13 INTERNAL` with an empty message.

## Progress by phase

| Phase | Result |
|---|---|
| 0. Inventory of Rafiki call sites | Done (`rhyza/INVENTORY.md`) |
| 1. Two-node playground | Done. Needed the #466 fix and building images one at a time (parallel builds hit a BuildKit timeout) |
| 2. Bond app on Rhyza | Done. Issue, buy, daily coupons B to A, activity, live feed. The app keeps customer balances (Rhyza has none). Amounts under 0.10 are refused because of #465 |
| 3. Second currency (EUR) in Rhyza | Blocked by #424 and #425. Meanwhile the app converts: Rhyza moves USD and the app books the other currency at the ECB reference rate |
| 4. Recurring coupons under Open Payments grants | Blocked by #467, #468 and #469. Works up to the grant request, the redirect to the IdP and the IdP's accept. The app pays through the Admin API meanwhile |
| 5. Third node | Done at the Rhyza level: three nodes peered pairwise, all smoke test legs pass. About 2.1 GiB per extra node (Rhyza total 6.7 GiB for 69 containers) |

## Direction

Because every currency blocker is cross-asset, the Rhyza version is pivoting to a US network of HBCU central
banks, all in USD: **BSU** (Node A), **HBCU South East** (Node B) and **HBCU South West** (Node C). The Rafiki
version stays the global one (USD, EUR, ZAR). Grants on Rhyza wait on #467 and #468.

## Reproducing

```bash
git checkout rhyza-port
./rhyza/setup.sh up                 # RHYZA_NODES=3 for the third node
node rhyza/seed.mjs                 # assets, wallets, peers, liquidity
node rhyza/bond-smoke-test.mjs      # purchase and coupon across nodes
node rhyza/grant-spike.mjs          # Phase 4: grant flow, reports where it stops
```

The only files that call Rhyza are `rhyza/lib/rhyza-admin.mjs` (Admin API) and
`rhyza/lib/rhyza-open-payments.mjs` (Open Payments, GNAP, IdP API). Compose fixes we apply on top of Rhyza's
files are in `rhyza/docker-compose.override.yaml`, each with the reason. More detail: `rhyza/README.md`.
