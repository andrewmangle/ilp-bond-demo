# Rhyza two-node playground for the bond demo

Branch: `rhyza-port`. `main` stays on Rafiki as the fallback demo.

This folder stands up two peered Rhyza nodes and proves the two money movements a
bond needs: a purchase (US investor pays NL issuer) and a coupon (NL issuer pays
US investor). Nothing here touches the existing Rafiki code.

| | Node A | Node B |
|---|---|---|
| Role | US, HBCU central bank | Netherlands, The Hague central bank |
| Admin API | http://localhost:3001 | http://localhost:4001 |
| Open Payments | http://localhost:3002 | http://localhost:4002 |
| Kafka console | http://localhost:8080 | http://localhost:8081 |
| Wallet | `us-investor` | `nl-bond-issuer` |

## Run it (inside WSL2, from the repo root)

```bash
git checkout -b rhyza-port

# 1. Stop Rafiki first. Both stacks use ports 3001, 3002, 4000 and 4001.
#    (from wherever you start the Rafiki localenv) ... down

# 2. Start both Rhyza nodes. First run builds about 40 images: expect 15 to 30 minutes.
./rhyza/setup.sh up
./rhyza/setup.sh status        # everything should be "running" or "healthy"

# 3. Seed assets, wallets, peering and liquidity. Safe to re-run.
node rhyza/seed.mjs

# 4. Prove a bond purchase and a coupon settle between the nodes.
node rhyza/bond-smoke-test.mjs

git add rhyza && git commit -m "Add two-node Rhyza playground for bonds"
```

Other commands: `./rhyza/setup.sh down` (stop, keep data), `./rhyza/setup.sh reset`
(wipe all data and state), `./rhyza/setup.sh logs admin-api-service`.

Requirements: Docker Desktop with the WSL2 backend, git, Node 18 or newer. pnpm and
Node 24 are NOT needed on your machine; the images build inside Docker.

## Files

- `setup.sh`: clones Rhyza at a pinned commit into `rhyza/.rhyza-src` (git-ignored) and runs its two-node compose files.
- `config.mjs`: node URLs, ILP addresses, peer ids, wallet names.
- `lib/rhyza-admin.mjs`: the only code that talks to Rhyza. Port the app against this.
- `seed.mjs`: idempotent setup of both nodes.
- `bond-smoke-test.mjs`: purchase A to B, coupon B to A. Exits non-zero on failure.

## Rafiki to Rhyza cheat sheet

| Rafiki | Rhyza |
|---|---|
| Incoming payment | Payment intent (`POST /payment-intents` on the receiver) |
| Quote | `POST /quotes` on the sender, pointing at the intent's `openPaymentsUrl` |
| Outgoing payment | Payment (`POST /payments` on the sender) |
| Liquidity on assets, wallets, payments | Liquidity on the peer only (`POST /liquidity/deposit`) |
| Wallet address URL | `pathName` only; Rhyza builds the URL |
| Outgoing payment needs funding via webhook | Payment needs approval; the playground's mock FSP service auto-approves on the payment-created webhook |

## Troubleshooting

- **Port already allocated**: Rafiki or another stack is still up. Stop it, then `./rhyza/setup.sh up`.
- **Build or containers killed, WSL freezes**: memory. Two nodes are heavy. In `%UserProfile%\.wslconfig` set `[wsl2]` `memory=20GB`, run `wsl --shutdown`, retry. Observability is already off; do not set `RHYZA_OBSERVABILITY=1` on this machine.
- **`Cannot reach http://localhost:3001`**: services are still starting. Wait a minute and check `./rhyza/setup.sh status`.
- **Wallet exists but no state file**: `./rhyza/setup.sh reset`, then `up`, then seed again.
- **400 on a seed step**: the alpha API changed shape. The error prints Rhyza's message. Compare against `rhyza/.rhyza-src/docs/openapi/admin/admin-api.yaml` and fix `lib/rhyza-admin.mjs`.
- **Payment FAILED, "Insufficient funds"**: liquidity deposit did not land. `reset`, `up`, seed again.
- **Payment stuck in CREATED**: the mock service did not approve it. Check `./rhyza/setup.sh logs ase-mock-service ase-mock-service-b`.

## The bond app on Rhyza (Phase 2)

The demo app (`localenv/university-payments`) runs on either rail, chosen with `PAYMENT_RAIL`:

```bash
PAYMENT_RAIL=rhyza scripts/demo-start.sh    # = rhyza/demo-start.sh: playground up, peers, app on :3040
scripts/demo-reset.sh --seed -y             # same script on both rails
scripts/demo-status.sh                      # follows the running app's rail
scripts/demo-stop.sh                        # likewise
```

Without `PAYMENT_RAIL` (or with `PAYMENT_RAIL=rafiki`) everything is the Rafiki demo, as on `main`.

How the switch works (`localenv/university-payments/lib/rail.js`): the rest of the app reaches money
movement only through eight modules (`nodes`, `mock-bank`, `admin-api`, `payments`, `open-payments`,
`central-bank`, `live`, `demo`). On `PAYMENT_RAIL=rhyza`, requests for those resolve to
`lib/rails/rhyza/<module>.js` instead, with the same exports. `bonds.js`, `coupons.js`, `plans.js`,
`clock.js`, `db.js`, `server.js` and the pages are the same code on both rails. On the Rafiki rail
`rail.js` does nothing. Changes to existing files: one `require` and one log line in `server.js`, one
delegation line in each of `scripts/demo-start.sh`, `demo-stop.sh`, `demo-status.sh`.

What the Rhyza rail does:

| Concern | Rhyza rail |
|---|---|
| Accounts and balances | Kept by the app in SQLite (`rhyza_accounts`). Rhyza holds no customer balances; the app plays the FSP ledger the Rafiki mock bank used to be. Each account has a Rhyza wallet address |
| Payment | Intent on the receiver's node, quote and payment on the sender's node, poll, complete the intent, then book both sides. The debit is held while sending |
| Mint | Treasury credit in the app ledger plus `POST /liquidity/deposit` on the node's peer |
| Activity, live feed | `GET /payments` and `GET /payment-intents`, joined to the app's records |
| Grants (coupons, recurring buys) | Phase 4. Until then a stand-in approves at once (no consent screen) and the payments go through the Admin API; limits are recorded, not enforced by Rhyza |
| Database | `data/demo-rhyza.db`, separate from the Rafiki rail's `data/demo.db` |
| Reset Demo | Wipes the app data and ledger and opens fresh wallet addresses (a new pathName suffix). Peers and liquidity from `rhyza/seed.mjs` stay |
| Seed Demo | Treasuries on both nodes, Jordan (HBCU, A), Sophie and Ellis Family Savings (Hague, B), Sophie's Hague Housing Bond |

Phase 2 acceptance, run on Nov 16, 2026 through the app's HTTP API with the same `x-acting-as`
roles the pages send: Sophie (Hague, Node B) issued a bond; Jordan (HBCU, Node A) bought 500.00 USD
of it; Sophie approved both grants; daily coupons of 0.10 USD were paid B to A. Both nodes' activity
and the live feed showed the purchase and the coupons with matching sent and received amounts, and the
balances reconciled (Sophie 1499.90, Jordan 500.10 after one coupon).

### Rhyza bug: payments under 0.10 take down the node's ledger

At the pinned commit, `pal-domain-lib` `liquidity/utils.ts` `amountToBigIntOfSize` rejects any amount
whose digit count is below its scale, so 1 to 9 cents at scale 2 throw `LedgerPrecisionLossError:
Amount input error: sourceAmount (4) is smaller than sourceScale (2).` The exception is uncaught: the
`pal-ledger-command-handler-service` exits, the payment stays `PROCESSING`, and after the restart the
node's ledger stopped settling other payments (the Phase 1 smoke test then hung in `SENDING` until a
`setup.sh reset`). It surfaced on a 0.04 USD daily coupon.

The Rhyza rail therefore never sends less than 0.10: a student payment below that is refused with a
message, and a smaller coupon is carried to the next date (its line shows as failed with the reason;
what is owed is kept). The Rafiki rail still goes down to 0.01. Worth reporting upstream.

## Phase 3 (second currency): blocked by Rhyza

Tried on Nov 15, 2026: EUR asset and an EUR issuer wallet on Node B, peering kept in USD, rates pushed
with `setRate()` on both nodes. Rhyza at the pinned commit (which is also upstream `main`) cannot pay
across a peer in a different currency, in either direction:

- Peer ledger accounts are created only in the peer's asset ledger, but a payment reserves in the
  wallet's asset ledger, so both legs fail with `Account(s) not found for ...ReserveTransferCmd`.
- The inbound rate lookup asks for USD -> USD instead of USD -> EUR (quotes then fail with `13 INTERNAL`).
  A USD -> USD peer rate works around this one; the quotes then complete at 0.92.

Reported upstream as #424 and #425 (already open; we added repro comments), plus #465 and #466; see `UPSTREAM_ISSUES.md`. The Phase 3 code (config with per-node
currency and `RATES_PER_USD`, seed with assets and rates, smoke test asserting the quote's converted
amount) is kept in the git stash "Phase 3 WIP"; `git stash pop` restores it. Both nodes stay in USD.
The playground still holds the EUR asset, the `nl-bond-issuer-eur` wallet and the pushed EUR rates
(they expire in a week); they don't affect USD payments.

### Phase 3 in the app instead (Nov 15, 2026)

Andrew's call: convert in the app until Rhyza can. Every Rhyza wallet stays USD and every payment moves USD
between the nodes; the app's ledger books the Hague node's accounts in EUR (`lib/rails/rhyza/fx.js`):

- A quote fixes one side in that side's currency, converts it to the USD Rhyza moves, and converts again for
  the other side. Rounding never charges the sender less, or credits the receiver more, than the USD moved is
  worth. Same currency on both sides books the same amount on both.
- Rates: a central bank's own setting wins, else the ECB reference rate from `https://api.frankfurter.dev`
  (no key; fetched at start and every 6 hours, stored in `market_rates`), else the old 0.92 baseline. The
  central bank page says which one is in use. Nothing is pushed to Rhyza's `POST /rates` any more.
- `RHYZA_HAGUE_CURRENCY=USD` keeps the Hague node in USD. Changing it needs Reset Demo (accounts keep the
  currency they were opened in).
- Test: `node localenv/university-payments/test/rhyza-fx.e2e.mjs` (USD to EUR, EUR to USD, an EUR bond
  bought in USD). Checked by hand: a 0.41 EUR coupon arrives as 0.45 USD.

This is not Rhyza doing FX: the Phase 3 acceptance (Rhyza's quote shows the converted amount) still waits on
#424 and #425, and the stash still holds that code.

## Phase 4 (grants): blocked by Rhyza

Spike on Nov 15, 2026: `node rhyza/grant-spike.mjs` runs a coupon under an Open Payments grant with no
browser. The client code is `lib/rhyza-open-payments.mjs` (signed GNAP and resource server requests, the
IdP API); the Admin API gained `createWalletAddressKey` and `getGrant`.

What works:
- A client wallet address on Node A with a registered Ed25519 key, served at `.../jwks.json`.
- A signed interactive grant request to Node B's auth server, with `debitAmount` limits and an interval.
- `GET /interaction/{id}/start` redirects to `IDP_URL` (the consent screen) with `interactId`; the IdP API
  (`GET /grant/{id}`, `POST /interaction/{id}/accept`, header `x-idp-secret: idp-secret`) shows the grant's
  access and limits and records the decision.

What doesn't (each seen at least twice; texts in `UPSTREAM_ISSUES.md` 5 to 7, not filed yet):
- **Finish always answers 401**, because the auth API's GetGrant never returns `interactionNonce`. So no
  `interact_ref`, no continue, no token. (Continuing with the `interactRef` read from the Admin API gives
  500: the grant is still PENDING.)
- **Open Payments `POST /quotes` answers 404 for a receiver on the other node**, so even with a token an
  Open Payments client can't pay across nodes (coupons go B to A).
- **The resource server checks no token at all**: quotes and outgoing payments go through with a made-up
  token, quotes with none. Grant limits aren't enforced either (upstream #278, open).

Compose fixes added to `docker-compose.override.yaml` on the way (texts for a #466 comment, not posted):
Node B's auth server reads `OPEN_PAYMENTS_AUTH_SERVER_URL`, not the `..._SERVICE_URL` the compose sets, so
it handed out Node A's URLs; Node B's resource server had no auth server URL; neither auth server had
`IDP_URL`. Also, the interaction cookie is `Secure`, so over plain http it is only set with
`X-Forwarded-Proto: https`; a browser can't send that, so the FSP (this app) would have to make the start
and finish calls itself.

The app is unchanged: on the Rhyza rail grants are still recorded by the app and payments made through
the Admin API (`lib/rails/rhyza/open-payments.js`). Once 5 and 6 are fixed, the plan is: the app serves the
consent screen at `/rhyza/consent/<node>` (the `IDP_URL`s already point there), and `payUnderGrant` uses
the client in `lib/rhyza-open-payments.mjs`.

## Switching between the Rafiki demo and this playground

The Rafiki demo on `main` keeps working; nothing in this folder changes it. The two stacks
share host ports (3000, 3001, 3010, 4000, 4001), so run one at a time:

```bash
# Rafiki -> Rhyza
scripts/demo-stop.sh            # keeps all Rafiki data
./rhyza/setup.sh up

# Rhyza -> Rafiki
./rhyza/setup.sh down           # keeps Rhyza data (reset wipes it)
scripts/demo-start.sh
```

The stacks use separate compose projects and volumes (`rafiki` vs `rhyza-bonds`), so
resetting one never touches the other. `rhyza/.rhyza-src` and `rhyza/.state.json` are
ignored on this branch; if you check out `main` they show as untracked files and can be left alone.

## Changes from first run

First live run: Nov 15, 2026, WSL2, Docker Desktop. All Phase 1 acceptance checks passed
with **no changes** to `lib/rhyza-admin.mjs` or `config.mjs`: seed ran clean, re-seed
reported "exists" for every step, both smoke test legs passed, and the
`reset && up && seed && smoke` cycle passed from a clean state.

Observations, none needing a code change:

- **First build timed out in BuildKit.** The very first `docker compose build` of all ~40
  images in parallel failed at the export step with
  `target ilp-connector-service: failed to solve: Internal: context deadline exceeded`.
  This was not memory (WSL had headroom). Building the services one at a time once
  (`docker compose -p rhyza-bonds -f ... build <service>` in a loop) filled the cache; after
  that `./rhyza/setup.sh up` (which uses `--build`) finished normally, and so did the later
  `reset && up`. If a fresh machine hits this, build serially once, then use `setup.sh up`.
- **Kafka console for Node A is not started.** In the pinned compose file `redpanda-console`
  (port 8080) is in the `with-observability` profile; only Node B's console (8081) runs by
  default. The `setup.sh up` banner still prints 8080.
- **Wallet addresses use Docker hostnames**, for example
  `http://open-payments-resource-service-b:3002/nl-bond-issuer`. They are reachable between
  the nodes' containers (which is what quoting needs) but not from the host. Treat them as
  opaque ids, as the ground rules say.
- **More ports than listed above.** Besides 3001/3002/4001/4002 the playground binds 3000,
  3003, 3004, 3010, 4000, 4003, 4004, 4100, 4300, 5110, 5111, 6379, 6380, 9092, 9093,
  27017, 27018 and the gRPC ports 4051 to 4054 and 50051 to 50054.
- **Memory:** about 5.0 GiB across 47 containers (`docker stats --no-stream`), observability off.
- **Node B's Open Payments auth server crash-loops** at the pinned commit:
  `docker-compose.node-b.yaml` leaves out `REDIS_URL` and `SESSION_SECRET` (Node A's copy has them), so it
  exits with "REDIS_URL is not set". Found in Phase 2 by the app's health check. Fixed with
  `rhyza/docker-compose.override.yaml`, which `setup.sh` now also loads. Only grants (Phase 4) need it.
- A short wait after `up` is needed before seeding; 45 seconds was enough here. A seed run
  too early fails with `Cannot reach http://localhost:3001`; just run it again.

## Known limits of this stage

- Written against Rhyza commit `259a9b9` (Nov 13, 2026), Admin API spec 0.0.21, and checked against the spec and Rhyza's own end-to-end test. Verified against a live two-node stack on Nov 15, 2026 (see "Changes from first run").
- Rhyza's own Bruno collection is already out of date against its spec (wallet `address` vs `pathName`, missing `callbackEndpoint` and `amountScale`). Trust the OpenAPI file, not Bruno.
- Both nodes use USD. EUR on Node B is the next step, using `setRate()` in the client.
- Coupons here are direct admin payments. Grant-based recurring coupons (Open Payments plus the identity provider service) come after the app is ported.
- No third node yet (Cape Town).
