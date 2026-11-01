# University Bonds demo on the Rafiki localenv

A demo for the Interledger Foundation built on this repo's local Rafiki environment. Three local Rafiki nodes act as university central banks. Students issue bonds, buy them and receive coupons. Interledger is the payment rail; the demo app keeps the bond registry.

The rest of this repo is upstream Rafiki. Change it only when the demo needs it, and note the change in PLAN.md.

## The three nodes

| Node | Compose project (repo name) | Asset | Mock bank UI | Open Payments (backend) | Admin GraphQL | Auth (GNAP) | IdP API | Rafiki admin UI |
|---|---|---|---|---|---|---|---|---|
| HBCU node | `cloud-nine-wallet` | USD | http://localhost:3030 | http://localhost:3000 | http://localhost:3001/graphql | http://localhost:3006 | http://localhost:3009 | http://localhost:3010 |
| Hague node | `happy-life-bank` | EUR | http://localhost:3031 | http://localhost:4000 | http://localhost:4001/graphql | http://localhost:4006 | http://localhost:4009 | http://localhost:4010 |
| Cape Town node | `cape-town-node` | ZAR | http://localhost:3032 | http://localhost:5000 | http://localhost:5001/graphql | http://localhost:5006 | http://localhost:5009 | http://localhost:5010 |

| Node | Docker hostnames (backend / auth) | ILP address | Tenant id |
|---|---|---|---|
| HBCU | `cloud-nine-wallet-backend` / `cloud-nine-wallet-auth` | `test.cloud-nine-wallet` | `438fa74a-fa7d-4317-9ced-dde32ece1787` |
| Hague | `happy-life-bank-backend` / `happy-life-bank-auth` | `test.happy-life-bank` | `cf5fd7d3-1eb1-4041-8e43-ba45747e9e5d` |
| Cape Town | `cape-town-node-backend` / `cape-town-node-auth` | `test.cape-town-node` | `f2279e57-1b7d-4634-9e25-97ac825cc942` |

- **Exchange rates:** USD 1, EUR 0.92, ZAR 18.2. They're set in each node's `seed.yml` under `rates`, keyed `rates[source][destination]`, and served by each mock bank at `/rates`. All three nodes peer with each other in **USD at scale 9** (`peeringAsset: 'USD:9'`); customer accounts stay at scale 2. Sending fees are **0** on every asset.
- **Secrets (localenv only):**
  - Admin API signature secret: `iyIgCprjb9uL8wFckR+pLEkJWMB7FJhgkvqhTQR/964=`. Same for all nodes; it also signs webhooks.
  - IdP secret: `2pEcn2kkCclbOHQiGNEwhJ0rucATZhrA807HTm2rNXE=`. Same for all nodes; send it as the `x-idp-secret` header.
- **Files:** each node's config is under `localenv/<node>/`: `docker-compose.yml`, `seed.yml` and `private-key.pem`. Display names are only cosmetic (`DISPLAY_NAME` in compose). Repo and hostnames keep the upstream names.

## Start commands

For the demo, use the scripts (see `DEMO_RUNBOOK.md`):
- `scripts/demo-start.sh` starts the containers, waits until they're healthy, starts the app in the background (pid and log in `localenv/university-payments/data/`) and prints the URLs.
- `scripts/demo-stop.sh` stops it all.
- `scripts/demo-reset.sh [--seed] [-y]` resets, optionally seeding.
- `scripts/demo-status.sh` shows what's up.

The underlying commands:

```sh
git submodule update --init           # first time only: the backend needs open-payments-specifications
pnpm localenv:compose up -d           # all three nodes plus Postgres, Redis and TigerBeetle
pnpm localenv:compose down            # stop (add -v to wipe the databases)
pnpm localenv:university-payments     # demo app at http://localhost:3040 (PORT=... to change)

# After changing mock bank code (rates endpoint, seed.ts): rebuild the shared image, then recreate the three
# mock banks. Recreating resets their in-memory accounts to seed.yml.
pnpm localenv:compose build cloud-nine-mock-ase
pnpm localenv:compose up -d cloud-nine-mock-ase happy-life-mock-ase cape-town-mock-ase
```

The demo app needs the nodes running and seeded first. Seeding is finished when http://localhost:3030, :3031 and :3032 list their accounts.

## Demo app: `localenv/university-payments/`

- **Code layout:**
  - `server.js`: Node `http` server, routes and role checks. No dependencies.
  - `lib/`: `nodes`, `admin-api`, `mock-bank`, `payments`, `central-bank`, `db`, `money`.
  - `public/`: plain HTML/JS/CSS, read on every request, so page edits need no restart. Code changes do.
- **Pages:**
  - http://localhost:3040/bonds: bond market; issue, browse, buy (for yourself or another holder), holdings.
  - http://localhost:3040: students; your account, send money, directory.
  - http://localhost:3040/central-bank: treasury, mint, fund, open account, exchange rate, activity.
- **Roles, not logins:** the "Acting as" switch sends `x-acting-as: bank:<node>` or `student:<node>:<account id>`. The server enforces it, returning 403 otherwise.
  - A central bank acts only on its own node and can view other nodes' public figures.
  - A student sends only from their own account.
- **SQLite** (`data/demo.db`, git-ignored; `DB_FILE` overrides) holds payments with their type and both parties, mints, and the rates set with their history. Migrations live in `lib/db.js` (`PRAGMA user_version`).
- **Treasury:** each node has a treasury at `accounts/treasury`, seeded with balance 0. Seeded student Jordan Ellis is on HBCU.
  - **Mint:** `depositAssetLiquidity` in Rafiki, plus `intent=add-liquidity` on the treasury at the mock bank. This is the only balance credit without a payment.
  - **Funding:** a treasury → student Open Payments payment with a fixed `receiveAmount`.
  - New accounts start at 0.
- **Payments** (`lib/payments.js`) go through the sender node's admin API:
  1. `createReceiver`: an amountless incoming payment with a 10 min expiry, plus metadata (type, names, wallets).
  2. `createQuote` with `debitAmount` or `receiveAmount`.
  3. `createOutgoingPayment` on that same quote.
  4. Poll until COMPLETED or FAILED.
  5. `completeReceiver`, so the receiving mock bank credits what arrived (within about a second).
- **Balances** are read from each mock bank at `GET /?_data=routes%2F_index` (`accountsWithBalance`, minor units, scale 2).
- **Activity** combines Rafiki's `outgoingPayments` and `incomingPayments` (first 100, newest first) with the SQLite rows and mints. A same-node payment shows as one row.
- **Admin API auth:**
  - `signature: t=<ms>, v1=<hex hmac-sha256(secret, "<t>.<canonical JSON body>")>`, where the body keys are sorted (RFC 8785).
  - `tenant-id: <tenant id>`.
  - See `lib/admin-api.js`.
- **Bonds** (`lib/bonds.js`, page `/bonds`), stored in SQLite tables `bonds` and `holdings`:
  - A purchase is a `type: 'bond'` payment from buyer to issuer, quoted with a fixed `receiveAmount` (the slice's face amount in the bond currency). The bond id and holder go in `payments.details`.
  - The holding is written by `payments.onSettled('bond', ...)` only when Rafiki reports COMPLETED. FAILED or CANCELLED writes nothing.
  - `payments.settleSending()` runs every 5 s and settles payments that finished after the request stopped waiting, such as after Rafiki retries.
  - What's left to sell subtracts open quotes and payments still sending.
  - Coupons: interest = face × rate × days / 365, rounded down to a cent. Frequency periods are 1/7/30/91/182/365 days.
- **Recurring purchases** (`lib/plans.js`; page section on `/bonds`; tables `plans` and `plan_runs`):
  - Set-up: `POST /api/plans`. Grant: `POST /api/plans/:id/grant`. Manage: `POST /api/plans/:id/pause|resume|cancel`.
  - The grant has `purpose = 'plan'` and a limit per period of one purchase's estimated cost in the buyer's currency + 5%, over an `R/<approval>/PT{days × secondsPerDay}S` interval. The first purchase is on approval.
  - Each date runs `payments.payUnderGrant` (`type: 'bond'`) with a `check(quote)` that skips over-limit or underfunded purchases before any outgoing payment is created. The `bond` settled hook records the holding.
  - A purchase count counts purchase dates, skipped ones included.
- **`/grants/finish`** routes by the grant's `purpose`: `plan` goes to `plans.finishGrant`, the rest to `coupons.finishGrant`. Both use `coupons.completeGrant`.
- **Re-approve grants:** `coupons.requestGrant` also accepts an active bond on a legacy `both` grant. Once the coupons and principal grants are approved, the legacy grant is revoked and the term isn't reset (`/bonds?grant=upgraded`).
- **Seeded story accounts** (all start at 0; fund them from the treasury):
  - Jordan Ellis: HBCU, `accounts/jordan`
  - Amara Dube: Cape Town, `accounts/amara`
  - Ellis Family Savings: Cape Town, `accounts/ellis-family`
  - Sophie Janssen: Hague, `accounts/sophie`
- **Coupons** (`lib/coupons.js`, `lib/clock.js`):
  - **Demo clock:** demo time = anchor + real elapsed × 86400 / secondsPerDay. The default is 60 s per day, stored in the `settings` table, and set via `POST /api/clock` (central-bank role) with `{ secondsPerDay }` or `{ paused: true|false }`.
    - While paused, nothing runs.
    - Demo time only advances while the app runs: there's a 5 s heartbeat, and on restart the clock never starts before the latest processed coupon date or term start.
  - **Lifecycle:** first slice sold → `awaiting_grant`. The issuer approves the **coupons** grant, then the **principal** grant:
    - `POST /api/bonds/:id/grant` returns the consent-screen URL for whichever grant is still missing.
    - The browser returns to `/grants/finish`, which sends it straight on to the second consent screen.
    - Once both are approved → `active`, and the term starts.
    - Older bonds have a single `purpose = 'both'` grant.
  - **Coupon run** (every 2 s): coupon date k adds face × rate × days / 365 to each holder's `accruals.owed_micro` (millionths of a bond minor unit). Maturity adds the principal.
  - **Paying a holder:** the app pays with `payments.payUnderGrant`, using a fixed `receiveAmount` of whole holder cents. Anything under one cent carries forward.
    - Coupons are paid under the coupons grant.
    - At maturity the principal (`accruals.principal_micro`) is a separate payment under the principal grant. Once it completes, the principal counts as repaid; any remainder is worth less than a holder cent.
  - **Missed and default:** a payment the issuer's bank cancels ("Account does not have enough balance") is Missed and stays owed. 3 Missed in a row → `in_default`, and the grant is revoked.
  - **Grant terms:**
    - Coupons grant: limit 4 full-bond coupons + 1% + 0.20 per interval `R/<approval>/PT{period × secondsPerDay}S` (open-ended).
    - Principal grant: limit size + 1% + 0.20, no interval (a lifetime limit).
- **Live feed** (`lib/live.js`, `/live`): polls each node's `outgoingPayments` every 1.5 s, adds types and names from SQLite and payment metadata, and pushes changes over SSE at `/api/live/stream`.
- **Demo control** (`lib/demo.js`, `/control`):
  - `GET /api/demo/health` (open to everyone).
  - `POST /api/demo/reset` and `/api/demo/seed`, central-bank role, body `{ confirm: true }`.
  - Reset sets `lib/maintenance.js` `state.active`, which stops the schedulers. It then wipes the demo tables, sets `settings.demo_epoch` (activity and the live feed hide older Rafiki payments) and calls `clock.reset()`. Finally it `docker exec rm`s each mock bank's `/workspace/state/accounts.json` and `docker restart`s the container.
- **Mock bank persistence:** with `MOCK_ACCOUNTS_FILE`, the mock bank uses `PersistentAccountProvider` (`packages/mock-account-service-lib`), saving accounts to a JSON file on a named volume (`<node>-mock-bank-state`). The seed keeps restored accounts and adds only missing ones.
- **Tests** need the app running:
  - `node localenv/university-payments/test/central-bank.e2e.mjs` takes about 3 minutes and changes rates, so don't run it during a demo.
  - `node localenv/university-payments/test/bonds.e2e.mjs` takes about 20 s. It mints, funds and issues another "Cape Solar Bond" each run.
  - `localenv/university-payments/test/demo-cycle.sh` takes about 5 min. It wipes and seeds, stops everything and removes the containers, then starts again and checks everything came back.
  - `node localenv/university-payments/test/plans.e2e.mjs` takes about 4 min. It sets the clock to 5 s per day and back, and moves the ZAR rate to 16 and back to 18.2.
  - `node localenv/university-payments/test/coupons.e2e.mjs` takes about 2 min. It sets the clock to 10 s per day, then back. It approves the latest Cape Solar Bond's grant if it's waiting, and creates a drained-issuer bond and a 10-day note.

## Exchange rates

- Each backend reads rates from its own mock bank's `GET /rates?base=X` (`EXCHANGE_RATES_URL`) and caches them for 15 s (`EXCHANGE_RATES_LIFETIME`).
- The mock bank serves the `rates` from its `seed.yml`, loaded at startup. The demo added a signed `POST /rates` with body `{ "currency": "ZAR", "perUsd": 19 }`. It uses the admin API signature scheme and secret, and sets the rate in memory, with the inverse and cross rates derived from it. The code is in `localenv/mock-account-servicing-entity/app/routes/rates.ts`, so the `rafiki-mock-ase` image must be rebuilt after changing it.
- Peering is in USD, so the node that owns a currency does the conversion into and out of it. A USD→ZAR payment is converted by Cape Town at Cape Town's rate.
- The app writes a central bank's rate to all three mock banks so their tables agree. It re-applies stored rates at startup and every 30 s, because a restarted mock bank goes back to `seed.yml`. `seed.yml` keeps the baseline USD 1, EUR 0.92, ZAR 18.2.
- **What a quote fixes:** the outgoing payment pays the quote, so the **sender** is charged the quoted amount. The receiving node converts at its rate when the money arrives, so the **receiver** gets the amount at the current rate.
  - Capping the incoming payment at the quoted amount does not stop Rafiki delivering more.
  - Below the quote's minimum rate (1% slippage, `SLIPPAGE`), packets are rejected with `InsufficientExchangeRate`. Rafiki retries up to `MAX_OUTGOING_PAYMENT_RETRY_ATTEMPTS` (5) times, waiting 10 s × the attempt number between tries, about 2.5 min in all. Then the payment is FAILED and nothing is charged.

## Rules for the demo

- **All money movement goes through Rafiki:** Open Payments (incoming payment → quote → outgoing payment) or the Rafiki admin API for central-bank actions such as liquidity and peers. Never edit balances directly.
  - The one exception is minting. It books the new money to the treasury with the mock bank's "add liquidity" action, alongside `depositAssetLiquidity` in Rafiki. Students are funded from the treasury by payment.
- **Recurring payments use Open Payments grants** with `limits` (`debitAmount` and/or `receiveAmount`) and an `interval` (ISO 8601 repeating interval, e.g. `R12/2026-11-01T00:00:00Z/P1M`). The demo app is the Open Payments client: it gets the grant once, then creates each payment under that grant.
- **Delivery versus payment (simulated):** bond ownership is recorded only after the payment has actually been credited. If the payment fails or under-delivers, nothing changes in the registry.
- **Keep it simple:** one small Node app (grow `localenv/university-payments/`), a local SQLite database through the built-in `node:sqlite` (Node is v24 here, so no dependency), plain HTML pages, no frameworks.

## How the localenv behaves (learned the hard way)

- **Two ledgers.**
  - Customer balances live in each mock bank's in-memory `Map` (`packages/mock-account-service-lib/src/account-provider.ts`). Restarting a mock bank container resets them from `seed.yml` and loses accounts created through the demo. The demo's SQLite registry must cope with that.
  - Rafiki's own ledger is in Postgres (`USE_TIGERBEETLE: false` on every node).
- **Webhooks move customer money.**
  - **Outgoing payment** (sender's bank): `outgoing_payment.created` places a hold. `outgoing_payment.completed`/`failed` debits `sentAmount` only, so fees are never charged.
  - **Incoming payment** (receiver's bank): `incoming_payment.completed`/`expired` credits `receivedAmount`.
  - Handlers are in `localenv/mock-account-servicing-entity/app/lib/webhooks.server.ts`.
- **Use amountless incoming payments, then `completeReceiver`** (admin API, called on the sender's node, works across nodes) once the outgoing payment finishes. The `incoming_payment.completed` webhook then credits the receiver.
  - A fixed-amount incoming payment can end 1 minor unit short on two-hop conversions, because of `packages/backend/src/open_payments/payment/outgoing/lifecycle.ts` around line 160. It then stays PROCESSING for 30 days unless something completes it.
  - An amountless payment never completes by itself; left alone, the receiver is credited only when it expires.
  - An incoming payment that expires with nothing received is deleted silently, with no webhook. That is fine for abandoned quotes.
  - Payment metadata passed to `createReceiver` is stored on the receiving node's incoming payment too.
- **Docker hostnames:** wallet addresses, `authServer` and `resourceServer` URLs use Docker hostnames (`https://cape-town-node-backend/...`, `http://cape-town-node-auth:3006/...`). From the host, map them to the localhost ports above.
  - Backend: plain http on port x000, sending the hostname in the `Host` header.
  - Auth: http on port x006.
  - In dev mode Rafiki fetches in-network wallet addresses over plain http.
- **Grants and identity** (all in `lib/open-payments.js`):
  - The app is the Open Payments client "University Bond Desk" at `https://cloud-nine-wallet-backend/accounts/bond-desk`. It has its own Ed25519 key in `data/client-key.json` (git-ignored), registered at startup with `createWalletAddressKey`.
  - Requests are signed as `@interledger/http-signature-utils` does: label `sig1`, params `keyid` then `created`, covering `@method`, `@target-uri`, `authorization` and the content headers. They're sent with Node `http.request`, because `fetch` can't set `Host`. Sign for the plain-http Docker-hostname URL: the servers rebuild it from the `Host` header.
  - Flow:
    1. Grant request: POST to the wallet address's `authServer`.
    2. The browser goes to `interact.redirect`, a `localhost:x006/interact/...` URL, which redirects to the mock bank's `/mock-idp/` consent screen.
    3. On Yes, the screen calls the IdP API `POST localhost:x009/grant/<id>/<nonce>/accept` (header `x-idp-secret`), then `localhost:x006/interact/<id>/<nonce>/finish`.
    4. The auth server redirects to the app's finish URI with `interact_ref` and `hash`.
    5. The app continues the grant (POST `continue.uri` with `GNAP <continue token>`).
  - Continuing sooner than the auth server's `wait` period after the request fails with `too_fast`; `continueGrant` retries.
  - Access tokens last 600 s; rotate with POST `manage` (`freshToken` in `lib/coupons.js`). Revoke with DELETE `manage`.
  - Resource server calls (`/quotes`, `/outgoing-payments`) go to `https://<node>-backend/<tenant>`. An outgoing payment's id is `.../outgoing-payments/<uuid>`, and the admin API uses that `<uuid>`.
  - **Grant limits apply per interval:** `debitAmount` with an `interval` caps each interval, not the grant's whole life. A payment outside the interval's repetitions isn't covered at all. One grant has one set of limits.
  - Bruno examples: `bruno/collections/Rafiki/Examples/Open Payments/`.
- **Small payments between nodes:**
  - **Precision at the USD hop:** at scale 2, 0.22 ZAR → 1 USD cent → 0 EUR cents, so the payment failed. That's why peering is now USD scale 9.
  - **Use fixed-receive quotes:** a fixed-send quote for a few cents still fails. Rafiki rounds the minimum delivery up (ceil(amount × rate × 0.99)) and delivery down. A fixed-receive quote for whole cents works down to 1 cent: 0.20 ZAR → 0.01 EUR.
  - **Fees:** the old 1.00 fixed fee made any payment under about 1.23 ZAR impossible to quote.
  - **Container names** are `rafiki-cloud-nine-backend-1`, `rafiki-happy-life-backend-1` and `rafiki-cape-town-backend-1` (not `...-wallet-...`). Look in their logs for ILP rejects such as `maxPacketAmount`.
- **Seeded accounts:**
  - Alice Smith (`accounts/asmith`, Hague) is seeded with `skipWalletAddressCreation: true`. Her wallet address appears only when someone first requests it, and her link to it is lost after a mock bank restart.
  - Some Hague seed accounts are USD, not EUR (PlanEx Corp, Alice Smith).
- **Port clashes:** Global Bank uses the same ports as Cape Town, so don't combine Cape Town with the `localenv:compose:psql`, `multihop`, `telemetry` or `adminauth` scripts.
- **`seed.ts` changes:** `packages/mock-account-service-lib/src/seed.ts`:
  - Re-seeding no longer aborts with "duplicate peer found".
  - `peeringAsset` may be `code:scale`.

  Rebuild the mock-ase image after changing that package. The seed only creates missing peers, so changing the peering asset means deleting the old peers first (admin `deletePeer`). The seed doesn't update an existing peer's `maxPacketAmount`; use admin `updatePeer`.
