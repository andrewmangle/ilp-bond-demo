#!/usr/bin/env node
// End-to-end check of the two money movements a bond needs:
//   1. Purchase: US investor (Node A) pays the NL issuer (Node B) the face value.
//   2. Coupon:   NL issuer (Node B) pays the US investor (Node A) one coupon.
// Exits non-zero if either leg fails, so it can gate later phases.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRhyzaAdmin, sendAcrossNodes } from './lib/rhyza-admin.mjs';
import { nodes, SCALE, ASSET } from './config.mjs';

const STATE = fileURLToPath(new URL('./.state.json', import.meta.url));
if (!existsSync(STATE)) { console.error('No rhyza/.state.json. Run: node rhyza/seed.mjs'); process.exit(1); }
const { wallets } = JSON.parse(readFileSync(STATE, 'utf8'));
const A = createRhyzaAdmin(nodes.a.adminUrl);
const B = createRhyzaAdmin(nodes.b.adminUrl);

const bond = { id: 'NL-STUDENT-001', faceValue: 10000, couponRatePct: 5, couponsPerYear: 4 }; // 100.00 face
const coupon = Math.round((bond.faceValue * bond.couponRatePct) / 100 / bond.couponsPerYear); // 1.25
const money = (n) => `${(Number(n) / 10 ** SCALE).toFixed(SCALE)} ${ASSET}`;

async function leg(name, args, expected) {
  process.stdout.write(`${name} ... `);
  const { payment, received } = await sendAcrossNodes(args);
  const got = Number(received.receivedAmount?.value ?? NaN);
  const ok = payment.state === 'COMPLETED' && got === expected;
  console.log(ok ? `PASS  (${money(got)} received)` : `FAIL  state=${payment.state} received=${received.receivedAmount?.value} expected=${expected} ${payment.failReason ?? ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

console.log(`Bond ${bond.id}: face ${money(bond.faceValue)}, ${bond.couponRatePct}% paid ${bond.couponsPerYear}x per year\n`);
const bought = await leg('1. Purchase  A -> B', {
  from: A, to: B, senderWallet: wallets.investor.address, receiverWallet: wallets.issuer.address,
  amount: bond.faceValue, metadata: { bondId: bond.id, type: 'purchase' }
}, bond.faceValue);
if (bought) await leg('2. Coupon    B -> A', {
  from: B, to: A, senderWallet: wallets.issuer.address, receiverWallet: wallets.investor.address,
  amount: coupon, metadata: { bondId: bond.id, type: 'coupon', period: 1 }
}, coupon);
console.log(process.exitCode ? '\nSmoke test FAILED. See rhyza/README.md troubleshooting.' : '\nSmoke test passed: bond purchase and coupon both settled over ILP between two Rhyza nodes.');
