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
- A short wait after `up` is needed before seeding; 45 seconds was enough here. A seed run
  too early fails with `Cannot reach http://localhost:3001`; just run it again.

## Known limits of this stage

- Written against Rhyza commit `259a9b9` (Nov 13, 2026), Admin API spec 0.0.21, and checked against the spec and Rhyza's own end-to-end test. Verified against a live two-node stack on Nov 15, 2026 (see "Changes from first run").
- Rhyza's own Bruno collection is already out of date against its spec (wallet `address` vs `pathName`, missing `callbackEndpoint` and `amountScale`). Trust the OpenAPI file, not Bruno.
- Both nodes use USD. EUR on Node B is the next step, using `setRate()` in the client.
- Coupons here are direct admin payments. Grant-based recurring coupons (Open Payments plus the identity provider service) come after the app is ported.
- No third node yet (Cape Town).
