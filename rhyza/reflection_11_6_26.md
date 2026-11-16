# Reflection: is Rhyza ready for the bond demo?

After porting the ILP bond demo from Rafiki to Rhyza (branch `rhyza-port`, Rhyza commit `259a9b94`, also
`main` in mid-November 2026), our conclusion is that **Rhyza is not production ready yet**. It calls itself
alpha, and what we saw matches that. Details and issue links: [RHYZA_FINDINGS.md](RHYZA_FINDINGS.md).

## What isn't ready

**Core money movement has gaps**
- Payments between different currencies don't work
  ([#424](https://github.com/interledger/rhyza/issues/424), [#425](https://github.com/interledger/rhyza/issues/425)).
- An amount of 0.01 to 0.09 crashes a node's ledger, which then stopped settling other payments until wiped
  ([#465](https://github.com/interledger/rhyza/issues/465)).
- Interactive grants can never finish, so there are no consent-based recurring payments
  ([#467](https://github.com/interledger/rhyza/issues/467)).
- Open Payments quotes to another node fail, so an Open Payments client can't pay across nodes
  ([#468](https://github.com/interledger/rhyza/issues/468)).

**Security isn't wired up yet**
- The Open Payments resource server accepts any access token, or none
  ([#469](https://github.com/interledger/rhyza/issues/469)).
- Grant spending limits aren't enforced yet (#278), and several open upstream issues carry the Security Concern
  label.

**Operations are missing or fragile**
- Peers can't be edited or deleted, so fixing one meant wiping the whole stack.
- There is no health endpoint.
- The second node's compose file shipped with four configuration mistakes
  ([#466](https://github.com/interledger/rhyza/issues/466)).

**It's heavy**
- Each node runs its own Kafka, MongoDB and Redis plus about 19 services: about 2.3 GiB and 23 containers per
  node.
- Three nodes overloaded a 16-core, 24 GB laptop. The load average passed 180, Kafka's consumer groups broke,
  and only a wipe brought the stack back. Rhyza was the only heavy workload running.

## What's good

- **Single-currency payments worked reliably** whenever the machine had headroom: bond purchases, coupons and
  transfers settled across three nodes.
- **The design is sound:** event-sourced, with separate parts for payments, ledger, auth and ILP, built to run
  on servers.
- **The team moves fast:** issues are filed and fixed weekly. These are normal alpha bugs, not signs of a
  broken design.

## What we're doing

1. **Rafiki stays the demo for funders and partners.** It handles currencies, grants and three nodes on a
   laptop.
2. **The Rhyza version is a developer preview** for the Interledger team and technical audiences: two nodes,
   all USD, as a US HBCU network (BSU and HBCU South East, plus HBCU South West when there is room), presented
   as "what the next generation looks like, and what we found."
3. **Revisit when the blockers are fixed:** #467 and #468 for grants, #424 and #425 for currencies, #465 to drop
   the 0.10 minimum. Then it's a pin bump and rerunning `rhyza/bond-smoke-test.mjs`, `rhyza/grant-spike.mjs`
   and the app tests already in this branch.
4. **A three-node Rhyza demo needs a bigger machine or a cloud VM,** not a laptop.
