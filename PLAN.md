# University Bonds demo: plan

Project context and rules are in CLAUDE.md. Tick an item (`[x]`) as soon as it's done and verified. Add a short note under the phase if something changed on the way.

## Done before this plan

- [x] Third node `cape-town-node` (ZAR) added; display names set to HBCU node (USD) and Hague node (EUR)
- [x] All three nodes peered, with rates USD 1, EUR 0.92, ZAR 18.2
- [x] `pnpm localenv:compose up` starts all three nodes
- [x] Demo app at :3040: create account (wallet address and starting balance), quote-and-send across currencies through Open Payments, accounts table
- [x] Re-seed fix in `packages/mock-account-service-lib/src/seed.ts`

## Phase 1: central banks

- [x] SQLite (`node:sqlite`) in the demo app: `data/demo.db`, migrations at startup, `data/` ignored in git
- [x] Split `server.js` into modules under `lib/` and pages under `public/` (served fresh, no restart for page edits)
- [x] Treasury account per node, seeded at `accounts/treasury` with a zero balance (plus student Jordan Ellis on HBCU)
- [x] Role switch in the UI ("acting as" a central bank or a student), sent as `x-acting-as` and enforced by the server
- [x] Central Bank page with a node picker; other nodes are view-only, students get no central-bank actions
- [x] Treasury: money supply of the node and Rafiki liquidity; mint into the treasury (admin API `depositAssetLiquidity` plus the mock bank deposit), recorded in `mints`
- [x] Fund a student: treasury → student payment through Open Payments, student receives the exact amount; open a student account with optional initial funding
- [x] Payments pay the quote the user saw, then `completeReceiver` closes the incoming payment (receiver credited within about a second, not 15 s)
- [x] Exchange rate: signed `POST /rates` on the mock bank; the app sets a node's rate against USD, publishes it to all three mock banks, records it in SQLite and restores it after a mock bank restart
- [x] Activity: every payment into or out of a node from Rafiki (`outgoingPayments`, `incomingPayments`), with names and types from SQLite and payment metadata, plus mints
- [x] Test: mint on each node, fund one student per node, ZAR rate to 19, USD→ZAR quote uses it, an already-quoted payment, back to 18.2, role checks

Notes from Phase 1:

- Students no longer get a 1,000 starting balance from the mock bank. A central bank funds them from its treasury, so minting is the only place a balance is credited without a payment.
- **An already-quoted payment fixes the sender's side, not the receiver's.** The sender is charged the quoted amount. The receiving node converts the incoming USD at its rate when the money arrives, so after ZAR went 18.2 → 19 a 10 USD quote for 158.38 ZAR delivered 165.49 ZAR. Capping the incoming payment at the quoted amount didn't help: Rafiki accepted more.
- If the rate moves more than 1% against a quote (slippage), Rafiki retries `InsufficientExchangeRate` for about 2.5 minutes, then marks the payment FAILED with nothing charged. The page says so while it waits.
- `localenv/mock-account-servicing-entity/app/routes/rates.ts` gained a signed `POST /rates`, which means rebuilding the `rafiki-mock-ase` image. Restarting the mock banks resets their accounts, minted treasuries included.
- Test: `node localenv/university-payments/test/central-bank.e2e.mjs` (API, about 3 minutes, changes rates and moves money). A jsdom click-through of both pages also passed, but it isn't in the repo because it needs `jsdom`.

Moved to Phase 3 (needed first for grants), all done there:

- [x] Register the demo app as an Open Payments client: "University Bond Desk" wallet address `https://cloud-nine-wallet-backend/accounts/bond-desk` on HBCU, its own Ed25519 key (`data/client-key.json`), registered with `createWalletAddressKey`
- [x] Signed Open Payments client (`lib/open-payments.js`): RFC 9421 signatures as `@interledger/http-signature-utils` makes them, Docker hostnames mapped to localhost ports with the original Host header
- [x] Interactive outgoing-payment grant: request → the bank's consent screen → back to the app → continue → payments under the grant; tokens rotated before they expire

## Phase 2: bond lifecycle

- [x] Bond registry in SQLite (migration 2): `bonds` (name, issuer, currency, size, minimum slice, annual rate, term in days, coupon frequency, status, maturity) and `holdings` (slice, holder, buyer, payment, paid, received)
- [x] Seeded students for the story: Amara Dube and Ellis Family Savings (Cape Town, ZAR), Sophie Janssen (Hague, EUR), all starting at 0
- [x] Bond Market page (`/bonds`) and nav link; central banks can browse but not issue or buy
- [x] Issue: name, total size, annual rate, term in days, minimum slice, coupon frequency (daily by default); in the issuer's home currency, paid into the issuer's account
- [x] Browse: open bonds with issuer, node, currency, rate, term, coupons, size, sold, remaining (and the amount being bought)
- [x] Buy: amount in the bond's currency; the Open Payments quote fixes what the issuer receives (`receiveAmount`) and shows the cost in the buyer's currency; confirm runs incoming payment → quote → outgoing payment, buyer to issuer
- [x] Buy for someone else: optional holder on any node (e.g. a family savings account); the buyer pays, the holder owns the slice and will get the coupons
- [x] Delivery versus payment: the holding is recorded only when the outgoing payment completes, from a settled-payment hook; failed or cancelled payments record nothing and show the reason
- [x] Payments still retrying when the request stops waiting are settled by a background check every 5 s, so a late completion still gets its holding and a late failure still records nothing
- [x] No overselling: open quotes and payments still sending count against what's left; the minimum slice applies unless buying the rest
- [x] Holdings: slices you hold, bonds you issued and slices you bought for others, in the bond currency and your own (at current rates)
- [x] Test: Amara issues 10,000 ZAR at 9% for 365 days; Jordan buys 728 ZAR for Ellis Family Savings; Sophie buys 910 ZAR; a buy without enough money fails cleanly and records nothing

Notes from Phase 2:

- The issuer receives at least the slice's face amount, sometimes a few cents more, because Rafiki over-delivers slightly on a fixed receive amount. Example: 150.15 ZAR for a 150.00 ZAR slice; 728 and 910 were exact. The holding is recorded at face value and the received amount is stored next to it. The fixed-receive quote means the "credited 1 cent short" case hasn't happened.
- The buyer is charged less than the quote's "at most" amount, because the mock banks don't charge fees (e.g. quoted 42.22 USD, charged 40.00 USD for 728 ZAR at 18.2).
- A bond quote reserves its amount until it is confirmed or expires (10 minutes), so an abandoned quote holds that amount back for a while.
- Test: `node localenv/university-payments/test/bonds.e2e.mjs` (about 20 seconds). It also passed a forced Rafiki-side failure (ZAR rate held at 17 until Rafiki gave up) and a late completion after retries, plus a jsdom click-through of the page; those two aren't in the repo.
- **For Phase 3:** small daily coupons round down a lot. A 150 ZAR slice at 9% earns 0.037 ZAR a day, paid as 0.03, so about 19% of the interest is lost. Decide whether to carry the remainder forward or pay accrued interest when it reaches a cent.

## Phase 3: coupons and maturity under grants

- [x] Demo clock (`lib/clock.js`): 1 bond day = 1 real minute by default; speed setting on the Central Bank page (5 s to real time); the demo day is shown on every page
- [x] Bond lifecycle: Selling → Awaiting grant (first slice sold) → Active (grant approved; the term starts on the demo clock) → Matured or In Default
- [x] Grants: the issuer clicks **Approve grants** and approves two in a row on their bank's real consent screen (`/mock-idp/`). The app sends the browser from the first straight to the second, then back to the Bond Market. Each grant has quote plus outgoing-payment access on the issuer's wallet:
  - **Coupons grant:** `debitAmount` per coupon period of about 4 full-bond coupons (catch-up for missed ones) plus 1% and 0.20, with an open-ended `interval` (`R/<approval>/PT<period>S`).
  - **Principal grant:** no interval, a one-off `debitAmount` of the bond's size plus 1% and 0.20, so it can only ever be spent once.
- [x] Pause: a Pause/Resume button for central banks on the Central Bank page. While paused no coupon dates arrive and nothing is paid, and the role bar shows "paused". Demo time also only runs while the app runs: a heartbeat saves it every 5 s and a restart carries on from there. It never restarts before a coupon date already processed.
- [x] Grant stored in SQLite (`grants`: token, manage URL, limits, interval, clock speed); used and remaining shown against the planned total (all coupons plus principal)
- [x] Coupon run every 2 s. On each coupon date, each holder accrues interest, and the app pays them under the grant: incoming payment on the holder's wallet, then quote and outgoing payment on the issuer's resource server with the grant's token
- [x] Holders get coupons in their own currency: the quote fixes whole cents of the holder's currency. Anything under a cent carries forward in the bond's currency (kept in millionths of a cent) until it's worth a cent
- [x] Maturity: the principal is paid on the last date as its own payment under the principal grant, then the bond is marked Matured and both grants revoked
- [x] Default: a payment the issuer's bank cancels for lack of funds marks that coupon Missed, and the amount stays owed for next period. After 3 missed in a row the bond is In Default, payments stop, the grant is revoked, and holders see a red banner
- [x] Shown on each bond: next coupon date (demo day), coupons paid and missed, grant used and remaining, status
- [x] Test (`test/coupons.e2e.mjs`, clock at 1 day = 10 s, about 2 minutes):
  - The Phase 2 bond's grant approved; Sophie receives EUR and Ellis Family Savings ZAR over 5+ demo days.
  - A drained issuer reaches In Default after 3 bank-cancelled coupons.
  - A 10-day bond reaches Matured with principal repaid in each holder's currency.

Changes to the localenv this needed:

- **Peering in USD at scale 9.** Previously USD at scale 2: a 0.22 ZAR coupon to EUR rounded to 0 at the USD hop. The seed files now list a USD scale-9 asset and `peeringAsset: 'USD:9'`. `seed.ts` accepts `code:scale`. The old scale-2 peers were deleted on all nodes, and Hague's `maxPacketAmount` for HBCU was raised to 100 USD at scale 9 (it was 10000, i.e. 100 USD at scale 2, so 0.00001 USD at scale 9).
- **Fees set to 0** on every asset (`setFee` and the seeds). The mock banks never charged them, and a 1.00 fixed fee made coupon payments impossible.
- **Coupons are quoted with a fixed receive amount** in whole holder cents. Fixed-send quotes for a few cents fail: Rafiki rounds the minimum delivery up and the delivery down.

Notes from Phase 3:

- **Rafiki applies a grant's `debitAmount` per interval** when it has one, and over the grant's life when it doesn't. Hence the two grants. The first version used one grant whose per-interval limit had to cover the principal (about the bond size plus 1%, e.g. "ZAR 10,110.01" on the consent screen). Bonds approved then keep that single grant (`purpose = 'both'`) and still work.
- **The coupons grant's period is fixed in real time** at approval, from the clock speed then. Its repetitions are open-ended, so pausing can't use them up. Speeding the clock up afterwards can put several coupon dates in one period, beyond the catch-up allowance, and those payments fail ("failed", retried next date). Set the speed before approving. Single grants approved before the change had a fixed number of repetitions: the test bonds approved at 10 s/day stop working about an hour after approval.
- **Fixed while adding the pause:** the first restart after adding heartbeats put the clock back about 20 demo days, because the old clock state had none, so coupon dates stopped arriving. Startup now never puts demo time before the latest processed coupon date or term start.
- **The clock was found paused mid-test** with no code path that pauses it except the API: probably the new Pause button in an open page. Clock changes are now logged by the server.
- **"Andrew Mangle 10 28 Bond"** (created and approved from the page, not by a test) is running on a single grant from before the change.
- **Coupon runs are resumable.** Stopping the app mid-run (my restart at 02:40:50 UTC) left a coupon date recorded with no lines: "Andrew Mangle 10 28 Bond" was stuck on date 21, and its family payment had gone out unrecorded. Now, for each holder, the interest and the lines to pay are written in one transaction before paying. Each payment carries its line's id, and the outcome and the change to what's owed are written together. A rerun picks up where it stopped. Tested by `kill -9` mid-date: the remaining holder was paid once, the paid one not again. Date 21 on that bond was repaired by hand (database backed up first): the payment was linked and the family's balance owed reduced by it. One gap is left: if the app dies between Rafiki accepting a payment and the app recording it (milliseconds), a rerun pays that line again.
- **Fixed: token rotation within a coupon date.** The second holder's payment rotated with a token the first had already rotated (revoked), "401 invalid access token". The grant is now re-read before rotating.
- **Holders who buy after the term starts** get full coupons from the next date (no pro-rating).
- **Fixed during testing:** a race where the background settler finished a coupon payment first and the coupon run then recorded it as failed, so the next date paid that amount again (Jordan was overpaid one daily coupon, a few cents, in that run).
- Missed coupons count only when the bank refuses for lack of funds. Other failures (a quote error, an expired grant) are marked "failed", retried next date, and don't count towards default.

## Phase 4: recurring purchases under grants

- [x] Plan set-up on the Bond Market (`lib/plans.js`, tables `plans` and `plan_runs`): bond, amount per purchase in the bond's currency, weekly (7 demo days) or monthly (30), holder (yourself or e.g. a family account), and a number of purchase dates or an end day
- [x] Grant: the buyer approves one outgoing-payment grant on their bank's consent screen (`purpose = 'plan'`), with a `debitAmount` limit per period of one purchase's cost in the buyer's currency at set-up plus 5%, and an open-ended `interval` of one purchase period on the demo clock
- [x] Each period: incoming payment on the issuer's wallet, quote (fixed receive amount in the bond currency), then the outgoing payment under the grant. The holding is recorded for the chosen holder by the same hook as a manual buy, only once the payment completes. The first purchase is made on approval
- [x] Skip rules, each recorded with its reason: plan paused, bond sold out / matured / in default / not enough left, buyer lacks funds (checked against the quote), quote over the grant limit. Over-limit skips also flag the plan; no outgoing payment is created, so nothing is spent
- [x] Manage: each plan shows next purchase day, purchases made and skipped, grant limit and what's left this period, total spent, the flag and the purchase history, with Pause, Resume and Cancel. Cancel revokes the grant, and so does the plan completing
- [x] Test (`test/plans.e2e.mjs`, clock at 1 day = 5 s, about 4 minutes):
  - Jordan's weekly 182 ZAR plan for Ellis Family Savings over 4 weeks: 2 bought, paused (date 3 skipped), resumed, cancelled, nothing more a week later.
  - At 1 USD = 16 ZAR the next purchase was skipped as over the limit (11.49 USD > 10.50 USD) and flagged, with nothing spent; back at 18.2 the next one went through.
  - Also checked separately: a buyer with 5 USD is skipped for lack of funds.

Also in Phase 4:

- **Re-approve grants:** an active bond still on the old single grant (approved before Phase 3's two grants) can be moved to the two grants without restarting its term. This matters because those single grants had a fixed number of interval repetitions at the approval-time clock speed, so they run out. Your "Andrew Mangle 10 28 Bond" is one: its grant ran out about 6 hours after approval, so it needs re-approving.
- **Catch-up cap:** after a gap (grant expired, payments failing), one date pays each holder at most their share of 80% of the coupons grant's per-period limit; the rest carries forward.
- **Clearer errors:** Rafiki's 403 on an outgoing payment under a grant now reads "over the grant's limit for this period".

Notes from Phase 4:

- The grant's limit counts the quote's debit amount: 10.11 USD for 182 ZAR, which includes Rafiki's 1% slippage headroom. The buyer is charged what's actually sent, 10.00 USD.
- A purchase count counts purchase dates, skipped ones included, so a 4-week plan always ends after 4 weeks. Paused dates are recorded as skipped ("plan paused").
- As with coupons, the grant's period is fixed in real time when it's approved. Speeding the clock up afterwards puts several purchase dates in one grant period: the second is refused as over the limit and recorded as skipped. Set the speed before approving.

## Phase 5: demo readiness and runbook

- [x] Live feed (`/live`, `lib/live.js`): every payment across the three nodes as it happens, pushed with Server-Sent Events (`/api/live/stream`) and newest first. It covers funding, transfers, bond buys, recurring buys, coupons, principal and mints, with node, names, currencies and amounts. A map header shows the three nodes; the route flashes and a coin travels between them when money moves
- [x] Control panel (`/control`, central-bank role): Pause/Resume, speed, **Jump ahead 1 day**, **Seed Demo**, **Reset Demo** (both ask for confirmation on the page), and a health check per node (mock bank, admin API, Open Payments, auth) plus the demo app and the scheduler. The health check is open to everyone (`GET /api/demo/health`)
- [x] Seed Demo (`lib/demo.js`): reset, then funded treasuries, students Jordan, Sophie and Amara funded, Ellis Family Savings, and Amara's 10,000 ZAR bond at 9% for 365 days with no holdings. Seeding twice gives the same state
- [x] Reset Demo:
  - Revokes live grants, wipes the app's data and sets the clock back to day 1.
  - Returns each mock bank to `seed.yml` by deleting its saved accounts and restarting it.
  - Rafiki keeps its payment history, so Activity and the live feed show only payments since the reset (`settings.demo_epoch`).
- [x] Restart safety:
  - The mock banks now keep their accounts and balances in a file on a Docker volume (`PersistentAccountProvider`, `MOCK_ACCOUNTS_FILE`); previously a restart reset every balance.
  - The seed keeps restored accounts.
  - The app stops cleanly, and demo time only runs while the app runs, so nothing is backfilled.
- [x] Scripts: `scripts/demo-start.sh`, `demo-stop.sh`, `demo-reset.sh [--seed] [-y]`, `demo-status.sh`
- [x] `DEMO_RUNBOOK.md`
- [x] Test: `localenv/university-payments/test/demo-cycle.sh` (about 5 minutes) runs:
  1. Start, seed, Phase 2–4 actions, including the live feed pushing a bond buy.
  2. Stop, `docker compose down` (containers removed, volumes kept), 60 s off, start.
  3. Checks: same demo day, no backfill, and holdings, grants, plans and balances all intact; then coupons and the next weekly purchase resume.

  A jsdom run of the live and control pages also passed. The real `wsl --shutdown` wasn't run, because it would end the session running the test; the same test covers what it does to the containers.

Notes from Phase 5:

- **Fixed: a request racing the background settler.** The 5-second settler could finish a payment that a request was still waiting on. The request then reported a bond buy as "no slice recorded" even though the slice was recorded, and waited up to 15 s. Payments a request is waiting on are now left to it.
- **Fixed: the first seed could read a balance before its funding was booked.** Seeding now waits for every seeded account's wallet address and for each funding to be booked.
- **First image build failed:** the TypeScript declaration build rejected `PersistentAccountProvider.set()`'s inferred return type. My build command hid the failure, so I checked the image date afterwards.
- **Demo data before the first Seed Demo** (all earlier test bonds and your "Andrew Mangle 10 28 Bond") was wiped by the test's seed. A copy of the database from just before is in the session scratchpad: `demo-before-phase5-seed.db`.
