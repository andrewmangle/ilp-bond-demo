#!/usr/bin/env node
// Seeds every node (two, or three with RHYZA_NODES=3): asset, wallet addresses, a peer for every other node,
// and liquidity on each peer (purchases flow A -> B, coupons flow B -> A, and so on).
// Safe to re-run. Writes wallet addresses to rhyza/.state.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRhyzaAdmin, RhyzaError } from './lib/rhyza-admin.mjs';
import { nodes, ASSET, SCALE, peerToken, PEER_LIQUIDITY } from './config.mjs';

const STATE = fileURLToPath(new URL('./.state.json', import.meta.url));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { wallets: {}, funded: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

const exists = (e) => e instanceof RhyzaError && e.status === 409;
const step = async (label, fn) => {
  try { const r = await fn(); console.log(`  ok       ${label}`); return r; }
  catch (e) { if (exists(e)) { console.log(`  exists   ${label}`); return null; } throw e; }
};

for (const [key, node] of Object.entries(nodes)) {
  const admin = createRhyzaAdmin(node.adminUrl);
  console.log(`\n${node.label}  ${node.adminUrl}`);

  await step(`asset ${ASSET}`, () => admin.createAsset(ASSET, SCALE));

  for (const [role, [pathName, publicName]] of Object.entries(node.wallets)) {
    const created = await step(`wallet address ${pathName}`, () => admin.createWalletAddress(pathName, ASSET, publicName));
    if (created) { state.wallets[role] = { node: key, id: created.id, address: created.address }; save(); }
    else if (!state.wallets[role]) {
      throw new Error(`Wallet "${pathName}" already exists but rhyza/.state.json has no record of it. Run ./rhyza/setup.sh reset, then up, then seed again.`);
    }
  }

  for (const [otherKey, other] of Object.entries(nodes)) {
    if (otherKey === key) continue;
    const peerId = node.peers[otherKey];
    await step(`peer -> ${other.ilpAddress}`, () => admin.createPeer({
      id: peerId,
      name: other.label,
      assetCode: ASSET,
      assetScale: SCALE,
      ilpStaticAddress: other.ilpAddress,
      http: {
        outgoing: {
          endpoint: `${other.connector}/ilp`,
          callbackEndpoint: `${other.connector}/ilp/callback`,
          authToken: peerToken(key, otherKey)
        },
        incoming: { authToken: peerToken(key, otherKey) }
      }
    }));

    // state.funded[key] was a boolean when each node had one peer (that peer was funded)
    if (state.funded[key] === true) state.funded[key] = { [key === 'a' ? 'b' : 'a']: true };
    state.funded[key] ??= {};
    if (!state.funded[key][otherKey]) {
      await step(`liquidity ${(PEER_LIQUIDITY / 10 ** SCALE).toFixed(2)} ${ASSET} on peer ${other.ilpAddress}`, () =>
        admin.depositLiquidity(peerId, ASSET, PEER_LIQUIDITY, SCALE));
      state.funded[key][otherKey] = true; save();
    } else console.log(`  exists   liquidity on peer ${other.ilpAddress}`);
  }
}

console.log('\nWallet addresses:');
for (const [role, w] of Object.entries(state.wallets)) console.log(`  ${role.padEnd(9)} ${w.address}`);
console.log('\nSeed complete. Next: node rhyza/bond-smoke-test.mjs');
