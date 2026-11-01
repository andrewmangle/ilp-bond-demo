// University payments demo for the local Rafiki environment (see CLAUDE.md at the repo root).
// Pages: / (students: send money), /bonds (issue, buy and hold bonds) and /central-bank (treasury, funding,
// exchange rate, activity).
// There are no logins: the page sends the role it is acting as in the x-acting-as header,
// "bank:<node>" or "student:<node>:<account id>", and the server only allows that role's actions.
// Start the localenv first (`pnpm localenv:compose up -d`), then `pnpm localenv:university-payments`.

const http = require('http')
const { readFile } = require('fs/promises')
const path = require('path')
const { NODES } = require('./lib/nodes')
const { UserError, ForbiddenError, toMinorUnits } = require('./lib/money')
const mockBank = require('./lib/mock-bank')
const payments = require('./lib/payments')
const centralBank = require('./lib/central-bank')
const bonds = require('./lib/bonds')
const coupons = require('./lib/coupons')
const plans = require('./lib/plans')
const live = require('./lib/live')
const demo = require('./lib/demo')
const maintenance = require('./lib/maintenance')
const { db } = require('./lib/db')
const clock = require('./lib/clock')
const openPayments = require('./lib/open-payments')
const { DB_FILE } = require('./lib/db')

const PORT = Number(process.env.PORT || 3040)
const RATE_SYNC_INTERVAL_MS = 30_000
const SETTLE_INTERVAL_MS = 5_000
const COUPON_TICK_MS = 2_000
const APP_URL = `http://localhost:${PORT}`

// --- Roles ---

function actingAs(req) {
  const [kind, node, accountId] = String(req.headers['x-acting-as'] ?? '').split(':')
  if (kind === 'bank' && NODES[node]) return { kind, node }
  if (kind === 'student' && NODES[node] && accountId) return { kind, node, accountId }
  return { kind: 'none' }
}

function requireBank(role, node) {
  if (role.kind !== 'bank') throw new ForbiddenError('Central-bank actions are only available when acting as a central bank')
  if (node && role.node !== node) {
    throw new ForbiddenError(`You are acting as the ${NODES[role.node].bankName}; switch role to act for the ${NODES[node].label}`)
  }
}

function requireStudent(role) {
  if (role.kind !== 'student') throw new ForbiddenError('Switch to a student role to send money')
}

async function actingStudent(role) {
  requireStudent(role)
  const student = await mockBank.findAccount(role.node, role.accountId)
  if (student.isTreasury) throw new ForbiddenError('A treasury account is not a student')
  return student
}

// --- API ---

const publicAccount = (a) => ({
  node: a.node,
  nodeLabel: a.nodeLabel,
  id: a.id,
  name: a.name,
  walletAddress: a.walletAddress,
  assetCode: a.assetCode,
  assetScale: a.assetScale
})

const withBalance = (a) => ({ ...publicAccount(a), balance: { value: a.balance, assetCode: a.assetCode, assetScale: a.assetScale } })

const routes = [
  ['GET', /^\/api\/nodes$/, () =>
    Object.entries(NODES).map(([key, n]) => ({ key, label: n.label, bankName: n.bankName, currency: n.currency }))],

  // Names and wallet addresses of every student with a wallet address (no balances), for pickers
  ['GET', /^\/api\/directory$/, async () =>
    (await mockBank.listAccounts()).filter((a) => !a.isTreasury && a.walletAddressId).map(publicAccount)],

  // --- Student role ---
  ['GET', /^\/api\/me$/, async (role) => withBalance(await actingStudent(role))],

  ['POST', /^\/api\/quote$/, async (role, body) => {
    const sender = await actingStudent(role)
    const receiver = await mockBank.findAccount(body.receiverNode, body.receiverId)
    if (receiver.isTreasury) throw new UserError('Students can only send money to other students')
    return payments.quote({
      type: 'payment',
      sender,
      receiver,
      debitAmount: { value: toMinorUnits(body.amount, sender.assetScale), assetCode: sender.assetCode, assetScale: sender.assetScale }
    })
  }],

  ['POST', /^\/api\/pay$/, async (role, body) => {
    const pending = payments.getPendingQuote(body.quoteId)
    requireStudent(role)
    if (pending.type !== 'payment') throw new UserError('Use the Bond Market to confirm a bond purchase')
    if (pending.sender.node !== role.node || pending.sender.id !== role.accountId) {
      throw new ForbiddenError('This quote belongs to another account')
    }
    return payments.pay(body.quoteId)
  }],

  // --- Demo clock ---
  ['GET', /^\/api\/clock$/, () => clock.state()],

  // { secondsPerDay } sets the speed; { paused: true | false } pauses or resumes demo time (and so all payments)
  ['POST', /^\/api\/clock$/, (role, body) => {
    requireBank(role) // a demo setting; any central bank may change it
    if (body.paused === true) return clock.pause()
    if (body.paused === false) return clock.resume()
    if (body.jumpDays !== undefined) return clock.jump(body.jumpDays)
    return clock.setSecondsPerDay(body.secondsPerDay)
  }],

  // --- Demo control (health is open, for scripts) ---
  ['GET', /^\/api\/demo\/health$/, () => demo.health()],

  ['POST', /^\/api\/demo\/reset$/, (role, body) => {
    requireBank(role)
    return demo.reset(body)
  }],

  ['POST', /^\/api\/demo\/seed$/, (role, body) => {
    requireBank(role)
    return demo.seed(body)
  }],

  // --- Bond market ---
  ['GET', /^\/api\/bonds$/, () => ({
    frequencies: Object.entries(bonds.FREQUENCIES).map(([key, f]) => ({ key, label: f.label, days: f.days })),
    bonds: bonds.listBonds()
  })],

  ['POST', /^\/api\/bonds$/, async (role, body) => bonds.issue(await actingStudent(role), body)],

  ['POST', /^\/api\/bonds\/([\w-]+)\/quote$/, async (role, body, [bondId]) =>
    bonds.quotePurchase(await actingStudent(role), { ...body, bondId })],

  ['POST', /^\/api\/bonds\/buy$/, async (role, body) => bonds.buy(await actingStudent(role), body.quoteId)],

  // The issuer approves the coupon grant on their bank's consent screen: the page sends the browser to `redirect`
  ['POST', /^\/api\/bonds\/([\w-]+)\/grant$/, async (role, _, [bondId]) =>
    coupons.requestGrant(await actingStudent(role), bondId, APP_URL)],

  // --- Recurring purchases ---
  ['GET', /^\/api\/plans$/, async (role) => plans.plansOf(await actingStudent(role))],

  ['POST', /^\/api\/plans$/, async (role, body) => plans.createPlan(await actingStudent(role), body)],

  ['POST', /^\/api\/plans\/([\w-]+)\/grant$/, async (role, _, [planId]) =>
    plans.requestGrant(await actingStudent(role), planId, APP_URL)],

  ['POST', /^\/api\/plans\/([\w-]+)\/(pause|resume|cancel)$/, async (role, _, [planId, action]) =>
    plans.setState(await actingStudent(role), planId, action)],

  ['GET', /^\/api\/holdings$/, async (role) => bonds.holdingsOf(await actingStudent(role))],

  // --- Central-bank role ---
  ['GET', /^\/api\/bank\/(\w+)\/overview$/, async (role, _, [node]) => {
    requireBank(role) // any central bank can look at another node's public figures
    if (!NODES[node]) throw new UserError('Unknown node')
    return centralBank.overview(node)
  }],

  ['GET', /^\/api\/bank\/(\w+)\/accounts$/, async (role, _, [node]) => {
    requireBank(role, node)
    return (await centralBank.listStudents(node)).map(withBalance)
  }],

  ['GET', /^\/api\/bank\/(\w+)\/activity$/, async (role, _, [node]) => {
    requireBank(role, node)
    return centralBank.activity(node)
  }],

  ['GET', /^\/api\/bank\/(\w+)\/rate$/, async (role, _, [node]) => {
    requireBank(role)
    return { ...(await centralBank.getRate(node)), history: centralBank.rateHistory(node) }
  }],

  ['POST', /^\/api\/bank\/(\w+)\/mint$/, async (role, body, [node]) => {
    requireBank(role, node)
    return centralBank.mint(node, body.amount)
  }],

  ['POST', /^\/api\/bank\/(\w+)\/fund$/, async (role, body, [node]) => {
    requireBank(role, node)
    return centralBank.fundStudent(node, body.accountId, body.amount)
  }],

  ['POST', /^\/api\/bank\/(\w+)\/accounts$/, async (role, body, [node]) => {
    requireBank(role, node)
    const { account, funding } = await centralBank.openStudentAccount(node, body.name, body.initialFunding)
    return { account: withBalance(account), funding }
  }],

  ['POST', /^\/api\/bank\/(\w+)\/rate$/, async (role, body, [node]) => {
    requireBank(role, node)
    return centralBank.setRate(node, body.perUsd)
  }]
]

// --- HTTP server ---

const PAGES = {
  '/': 'index.html',
  '/central-bank': 'central-bank.html',
  '/bonds': 'bonds.html',
  '/live': 'live.html',
  '/control': 'control.html',
  '/common.js': 'common.js',
  '/style.css': 'style.css'
}
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw new UserError('Request body must be JSON')
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost')

    if (req.method === 'GET' && pathname === '/api/live/stream') return live.stream(req, res)

    // The consent screen sends the browser back here (GNAP interaction finish)
    if (req.method === 'GET' && pathname === '/grants/finish') {
      const query = Object.fromEntries(new URL(req.url, APP_URL).searchParams)
      const grant = db.prepare('SELECT * FROM grants WHERE id = ?').get(query.grant)
      const location = !grant || grant.state !== 'pending'
        ? '/bonds?grant=unknown'
        : await (grant.purpose === 'plan' ? plans.finishGrant(grant, query) : coupons.finishGrant(grant, query, APP_URL))
          .catch((err) => { console.error(err); return '/bonds?grant=failed' })
      res.writeHead(302, { location })
      return res.end()
    }

    if (req.method === 'GET' && PAGES[pathname]) {
      // Read on every request, so page edits show up without a restart
      const file = PAGES[pathname]
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)], 'cache-control': 'no-store' })
      return res.end(await readFile(path.join(__dirname, 'public', file)))
    }

    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(pathname))
    if (!route) return send(res, 404, { error: 'Not found' })

    try {
      const params = pathname.match(route[1]).slice(1)
      const body = req.method === 'POST' ? await readJson(req) : undefined
      send(res, 200, await route[2](actingAs(req), body, params))
    } catch (err) {
      if (err instanceof UserError) return send(res, 400, { error: err.message })
      if (err instanceof ForbiddenError) return send(res, 403, { error: err.message })
      console.error(err)
      send(res, 502, {
        error:
          err.cause?.code === 'ECONNREFUSED'
            ? 'A Rafiki node is not reachable. Is the localenv running (pnpm localenv:compose up -d)?'
            : err.message
      })
    }
  })
  .listen(PORT, () => {
    console.log(`University payments: http://localhost:${PORT} (bond market: /bonds, central banks: /central-bank)`)
    console.log(`Demo database: ${DB_FILE}`)
  })

// Put back rates the central banks have set if a mock bank restarted with its seed.yml rates
const syncRates = () => centralBank.syncRates().catch((err) => console.error('Rate sync failed:', err.message))
syncRates()
setInterval(syncRates, RATE_SYNC_INTERVAL_MS).unref()

// Finish payments Rafiki completed or failed after the request stopped waiting (e.g. after retries), so a
// bond purchase that completes late still gets its holding
let settling = false
setInterval(async () => {
  if (settling || maintenance.state.active) return
  settling = true
  await payments.settleSending().catch((err) => console.error('Settling payments failed:', err.message))
  settling = false
}, SETTLE_INTERVAL_MS).unref()

// Coupon dates and maturity, on the demo clock
setInterval(() => coupons.tick().catch((err) => console.error('Coupon run failed:', err.message)), COUPON_TICK_MS).unref()
// Recurring purchases, on the demo clock
setInterval(() => plans.tick().catch((err) => console.error('Recurring purchases failed:', err.message)), COUPON_TICK_MS).unref()

// The app's own Open Payments client wallet address and key, used to request grants
openPayments.ensureClient().then(
  (url) => console.log(`Open Payments client: ${url}`),
  (err) => console.error(`Open Payments client not ready (is the HBCU node up?): ${err.message}`)
)

// Stop cleanly: let a coupon or purchase run in progress finish (runs are resumable anyway), then exit
function shutdown(signal) {
  console.log(`${signal}: stopping`)
  maintenance.state.active = true
  server.close()
  const end = Date.now() + 10_000
  const wait = () => {
    if ((coupons.schedulerState().running || plans.schedulerState().running) && Date.now() < end) return setTimeout(wait, 200)
    process.exit(0)
  }
  wait()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
