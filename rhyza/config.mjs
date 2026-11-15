// Demo topology. Node A and Node B are the two instances the Rhyza playground starts.
export const SCALE = 2;
export const ASSET = 'USD'; // stage 1: one shared currency. EUR on Node B comes later via setRate().

export const nodes = {
  a: {
    label: 'Node A (US, HBCU central bank)',
    adminUrl: process.env.RHYZA_ADMIN_A ?? 'http://localhost:3001',
    ilpAddress: 'private.rhyza.a',
    connector: 'http://ilp-connector-service:4000',     // docker-network name, not localhost
    peerIdForOther: '04978037-26b8-4b4d-854a-278ed7548959',
    wallets: { investor: ['us-investor', 'US Student Investor'] }
  },
  b: {
    label: 'Node B (Netherlands, The Hague central bank)',
    adminUrl: process.env.RHYZA_ADMIN_B ?? 'http://localhost:4001',
    ilpAddress: 'private.rhyza.b',
    connector: 'http://ilp-connector-service-b:4000',
    peerIdForOther: '9f3c1e2a-4b5d-4c6e-8a7f-1b2c3d4e5f60',
    wallets: { issuer: ['nl-bond-issuer', 'NL Student Bond Issuer'] }
  }
};

export const PEER_TOKEN = 'local-peer-token';
export const PEER_LIQUIDITY = 1_000_000; // 10,000.00 at scale 2, each direction
