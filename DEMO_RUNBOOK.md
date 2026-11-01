# University Bonds demo: runbook

Three local Rafiki nodes act as university central banks: HBCU (USD), Hague (EUR) and Cape Town (ZAR). Students buy and hold each other's bonds across currencies; Interledger moves the money. Details are in `CLAUDE.md`.

## One-time setup

You need Docker, Node 24 and pnpm. In WSL, keep the repo in the Linux filesystem (e.g. `~/rafiki`).

```sh
pnpm install
git submodule update --init
pnpm localenv:compose build      # first time only, takes a while
```

## Start

```sh
scripts/demo-start.sh
```

This starts the Docker containers, waits until every node is up and seeded, starts the demo app, and prints the URLs. It's safe to run again; whatever is already running is left alone.

| Page | URL |
|---|---|
| Students | http://localhost:3040/ |
| Bond Market | http://localhost:3040/bonds |
| Central Bank | http://localhost:3040/central-bank |
| Live feed | http://localhost:3040/live |
| Control | http://localhost:3040/control |

Pick who you are with **Acting as** at the top of each page. Central-bank tools need a central-bank role.

## Before the audience

1. Open **Control** as any central bank and click **Seed Demo** (or run `scripts/demo-reset.sh --seed`). This wipes everything and sets up the starting point:
   - Funded treasuries on all three nodes.
   - Jordan (HBCU, 1,000 USD), Sophie (Hague, 1,000 EUR) and Amara (Cape Town, 5,000 ZAR).
   - The Ellis Family Savings account on Cape Town.
   - Amara's Cape Solar Bond: 10,000 ZAR at 9% for 365 days, no holdings yet.
2. Leave the clock at **1 day = 1 min**. Set any other speed now, before grants are approved.
3. Open **Live** on a second screen.

## Demo script

1. **Central banks.** Act as the Cape Town central bank on **Central Bank**. Show the treasury, the money supply and the rate (1 USD = 18.2 ZAR).
2. **Buy across currencies.** Act as **student Jordan Ellis** on **Bond Market**. Click **Buy** on the Cape Solar Bond, enter **728**, set the holder to **Ellis Family Savings**, then **Get quote** and **Confirm and pay**. The quote is in USD and Amara receives ZAR. **Live** shows the money moving from HBCU to Cape Town.
3. **Another buyer.** Act as **Sophie Janssen** and buy **910** for herself (paid in EUR).
4. **Grants.** Act as **Amara Dube**. The banner says the bond has sold its first slice. Click **Approve grants**, then **Yes** on both of her bank's consent screens: coupons, then principal. The bond is now **Active**.
5. **Coupons.** A coupon is paid every demo day (1 minute), or click **Jump ahead 1 day** on **Control**. **Live** shows coupons arriving: Sophie gets EUR, and the family account gets ZAR. On the Bond Market, Amara's row shows coupons paid and grant used.
6. **Recurring purchase.** Act as Jordan. In **Recurring purchases**, pick the bond, enter **182**, choose every week, set the holder to Ellis Family Savings and enter 4 purchases. Click **Set up plan**, then **Approve at my bank**, then **Yes**. The first purchase happens straight away, then one every 7 demo days.
7. **Optional, rate shock.** Act as the Cape Town central bank and set the rate to **16**. The next weekly purchase is skipped as "over the grant limit" and nothing is spent. Set it back to **18.2**.
8. **Optional, default.** Act as Amara and send her whole balance to someone. After 3 missed coupons the bond turns **In Default** for its holders.

## Pause, stop, restart

- **Pause for a break:** click **Pause** on **Control**. No coupons or purchases are paid until you click **Resume**.
- **Stop:** `scripts/demo-stop.sh`. Nothing is lost:
  - The app's data, the mock banks' balances and Rafiki's databases are kept.
  - Demo time doesn't move while everything is stopped.
- **Restart or resume,** including after `wsl --shutdown` or a reboot: run `scripts/demo-start.sh`, then **Resume** on **Control** if the clock was paused.
  - Everything carries on from the same demo day.
  - Missed periods aren't paid in a burst.
- **Reset:** **Reset Demo** on **Control**, or `scripts/demo-reset.sh`. Add `--seed` to seed straight after.

## If something's wrong

- `scripts/demo-status.sh` shows the containers, the app, the health of each node and the scheduler, and the demo clock. **Control** shows the same health check in the browser.
- The app's log is `localenv/university-payments/data/app.log`.
- **Coupons or purchases show "over the grant's limit for this period":** the clock speed was changed after the grant was approved. Set the speed before approving.
- **A page says a node isn't reachable:** run `scripts/demo-start.sh` again. It waits for every node.
