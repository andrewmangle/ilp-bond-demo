// Demo topology. Node A and Node B are the two instances the Rhyza playground starts; Node C (Phase 5) is
// added with RHYZA_NODES=3 (docker-compose.node-c.yaml). Every node peers with every other node.
export const SCALE = 2;
export const ASSET = 'USD'; // stage 1: one shared currency. EUR on Node B comes later via setRate().

export const nodes = {
  a: {
    label: 'Node A (BSU central bank)',
    adminUrl: process.env.RHYZA_ADMIN_A ?? 'http://localhost:3001',
    ilpAddress: 'private.rhyza.a',
    connector: 'http://ilp-connector-service:4000',     // docker-network name, not localhost
    peerIdForOther: '04978037-26b8-4b4d-854a-278ed7548959', // = peers.b
    peers: { b: '04978037-26b8-4b4d-854a-278ed7548959', c: 'a7442b8a-69e7-43a5-80e5-d4f226fece03' }, // this node's id for each peer
    // Open Payments (Phase 4): wallet address URLs use the Docker host; from the host it is the local port
    openPayments: { dockerHost: 'open-payments-resource-service:3002', localPort: 3002 },
    authUrl: 'http://localhost:3003',
    idpUrl: 'http://localhost:3004',
    wallets: { investor: ['us-investor', 'BSU Student Investor'] }
  },
  b: {
    label: 'Node B (HBCU South East central bank)',
    adminUrl: process.env.RHYZA_ADMIN_B ?? 'http://localhost:4001',
    ilpAddress: 'private.rhyza.b',
    connector: 'http://ilp-connector-service-b:4000',
    peerIdForOther: '9f3c1e2a-4b5d-4c6e-8a7f-1b2c3d4e5f60', // = peers.a
    peers: { a: '9f3c1e2a-4b5d-4c6e-8a7f-1b2c3d4e5f60', c: '888de7ff-8d78-4b26-adb4-aebc8985abb4' },
    openPayments: { dockerHost: 'open-payments-resource-service-b:3002', localPort: 4002 },
    authUrl: 'http://localhost:4003',
    idpUrl: 'http://localhost:4004',
    wallets: { issuer: ['nl-bond-issuer', 'HBCU South East Bond Issuer'] } // pathName kept from the first version
  },
  ...(process.env.RHYZA_NODES === '3' ? {
    c: {
      label: 'Node C (HBCU South West central bank)',
      adminUrl: process.env.RHYZA_ADMIN_C ?? 'http://localhost:5001',
      ilpAddress: 'private.rhyza.c',
      connector: 'http://ilp-connector-service-c:4000',
      peers: { a: '9bacb069-f742-4257-961b-373ab21f920b', b: 'dd457663-f9d3-49fa-9bc1-8b19a72754be' },
      openPayments: { dockerHost: 'open-payments-resource-service-c:3002', localPort: 5002 },
      authUrl: 'http://localhost:5003',
      idpUrl: 'http://localhost:5004',
      wallets: { holder: ['c-bond-holder', 'HBCU South West Student Investor'] }
    }
  } : {})
};

export const PEER_TOKEN = 'local-peer-token';
// The token one pair of peers authenticates with, the same in both directions. Each pair needs its own: a
// node's connector tells its peers apart by the incoming token alone (ilp-connector-service
// peer-directory.ts), so with one token for all, packets from Node C were taken as Node A's and the
// callback went to Node A. A and B keep the original token.
export const peerToken = (x, y) => {
  const pair = [x, y].sort().join('');
  return pair === 'ab' ? PEER_TOKEN : `${PEER_TOKEN}-${pair}`;
};
export const IDP_SECRET = 'idp-secret'; // IDP_SECRET of idp-interaction-service(-b) in Rhyza's compose files
export const PEER_LIQUIDITY = 1_000_000; // 10,000.00 at scale 2, on each peer of each node
