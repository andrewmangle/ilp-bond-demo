// The three local Rafiki nodes, acting as university central banks. Ports are the localenv's host ports.

// Shared by all nodes in the localenv: signs admin API requests and the mock banks' rate updates
const ADMIN_API_SECRET = 'iyIgCprjb9uL8wFckR+pLEkJWMB7FJhgkvqhTQR/964='

// Every node keeps its central bank's treasury account at this wallet address path (seeded in seed.yml)
const TREASURY_PATH = 'accounts/treasury'

const NODES = {
  hbcu: {
    label: 'HBCU node',
    bankName: 'HBCU central bank',
    currency: 'USD',
    mockBank: 'http://localhost:3030',
    graphql: 'http://localhost:3001/graphql',
    tenantId: '438fa74a-fa7d-4317-9ced-dde32ece1787',
    backendHost: 'cloud-nine-wallet-backend',
    mockBankContainer: 'rafiki-cloud-nine-mock-ase-1', // Docker container, restarted by Reset Demo
    authHost: 'cloud-nine-wallet-auth',
    openPaymentsPort: 3000, // localhost port of the backend's Open Payments server (container port 80)
    authPort: 3006 // localhost port of the auth server's GNAP API (container port 3006)
  },
  hague: {
    label: 'Hague node',
    bankName: 'Hague central bank',
    currency: 'EUR',
    mockBank: 'http://localhost:3031',
    graphql: 'http://localhost:4001/graphql',
    tenantId: 'cf5fd7d3-1eb1-4041-8e43-ba45747e9e5d',
    backendHost: 'happy-life-bank-backend',
    mockBankContainer: 'rafiki-happy-life-mock-ase-1', // Docker container, restarted by Reset Demo
    authHost: 'happy-life-bank-auth',
    openPaymentsPort: 4000, // localhost port of the backend's Open Payments server (container port 80)
    authPort: 4006 // localhost port of the auth server's GNAP API (container port 3006)
  },
  capetown: {
    label: 'Cape Town node',
    bankName: 'Cape Town central bank',
    currency: 'ZAR',
    mockBank: 'http://localhost:3032',
    graphql: 'http://localhost:5001/graphql',
    tenantId: 'f2279e57-1b7d-4634-9e25-97ac825cc942',
    backendHost: 'cape-town-node-backend',
    mockBankContainer: 'rafiki-cape-town-mock-ase-1', // Docker container, restarted by Reset Demo
    authHost: 'cape-town-node-auth',
    openPaymentsPort: 5000, // localhost port of the backend's Open Payments server (container port 80)
    authPort: 5006 // localhost port of the auth server's GNAP API (container port 3006)
  }
}

// Which node hosts a wallet address or incoming payment URL, e.g. https://cape-town-node-backend/...
function nodeOfUrl(url) {
  try {
    const { hostname } = new URL(url)
    return Object.keys(NODES).find((key) => NODES[key].backendHost === hostname) ?? null
  } catch {
    return null
  }
}

module.exports = { ADMIN_API_SECRET, TREASURY_PATH, NODES, nodeOfUrl }
