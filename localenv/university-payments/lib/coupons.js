// Coupons and maturity, paid by the demo app under Open Payments grants from the issuer.
//
// When a bond's first slice sells it waits for the issuer to approve two outgoing-payment grants on their bank's
// consent screen, one after the other: a coupons grant and a principal grant. Approving both starts the term on
// the demo clock. On each coupon date the app adds the period's interest to what the issuer owes each holder,
// then pays each holder under the coupons grant: an incoming payment on the holder's wallet address, a quote
// fixing what the holder receives in whole units of their own currency, and an outgoing payment from the
// issuer. What doesn't make a whole cent in the holder's currency is carried to the next date. At maturity the
// principal is paid the same way under the principal grant.
//
// A payment the issuer's bank refuses for lack of funds marks that coupon Missed; what was owed stays owed and
// is tried again next period. After 3 missed coupons in a row the bond is In Default and payments stop.
//
// Grant limits: Rafiki applies a grant's debitAmount limit per interval when it has an interval, and over the
// grant's life when it doesn't. So:
// - Coupons grant: limit per coupon period of about 4 coupons on the whole bond (its own plus 3 missed ones it
//   may have to catch up), with an interval repeating every coupon period in real time, at the clock speed when
//   it is approved. The repetitions are open-ended so pausing the demo clock can't use them up; the app revokes
//   the grant when the bond matures or defaults.
// - Principal grant: no interval, a one-off limit of the bond's size (plus 1%), so it can be spent only once.

const { randomUUID, createHash } = require('crypto')
const clock = require('./clock')
const mockBank = require('./mock-bank')
const payments = require('./payments')
const openPayments = require('./open-payments')
const { db, now } = require('./db')
const maintenance = require('./maintenance')
const { UserError } = require('./money')

const SCALE = 2
const MICRO = BigInt(1_000_000) // owed amounts are kept in millionths of a minor unit
const MISSED_FOR_DEFAULT = 3
const RETRY_PERIODS = MISSED_FOR_DEFAULT // after maturity, periods to keep trying to repay the principal
const CATCH_UP_COUPONS = MISSED_FOR_DEFAULT + 1 // coupons one date may have to pay (missed ones plus its own)
const ROUNDING_HEADROOM = BigInt(20) // minor units: quotes can cost a cent or so more than the exact conversion
const TOKEN_REFRESH_MS = 2 * 60 * 1000
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30, quarterly: 91, semiannual: 182, annual: 365 }

const amount = (value, assetCode) => ({ value: String(value), assetCode, assetScale: SCALE })
const parse = (json) => (json ? JSON.parse(json) : null)
const ceilDiv = (a, b) => (a + b - BigInt(1)) / b
const withHeadroom = (value) => value + value / BigInt(100) + ROUNDING_HEADROOM

// Interest on a face amount over some days, in millionths of a minor unit: face × rate × days / 365
function interestMicro(face, annualRate, days) {
  return (BigInt(face) * BigInt(Math.round(annualRate * 10000)) * BigInt(days) * MICRO) / BigInt(365 * 100 * 10000)
}

// --- Schedule on the demo clock ---

function schedule(bond) {
  const period = PERIOD_DAYS[bond.coupon_frequency]
  const term = bond.term_days
  const events = Math.ceil(term / period) // coupon dates, the last one being maturity
  const dayAt = (k) => (k <= events ? Math.min(k * period, term) : term + (k - events) * period)
  return {
    period,
    events,
    kind: (k) => (k < events ? 'coupon' : k === events ? 'maturity' : 'retry'),
    days: (k) => (k <= events ? dayAt(k) - dayAt(k - 1) : 0),
    due: (k) => bond.term_start_demo + dayAt(k) * clock.DAY_MS
  }
}

// --- Grants ---

function grantTerms(bond) {
  const { period } = schedule({ ...bond, term_start_demo: 0 })
  const size = BigInt(bond.size)
  const couponOnSize = ceilDiv(interestMicro(size, bond.annual_rate, period), MICRO)
  const allCoupons = ceilDiv(interestMicro(size, bond.annual_rate, bond.term_days), MICRO)
  const secondsPerDay = clock.secondsPerDay()
  const couponLimit = amount(withHeadroom(couponOnSize * BigInt(CATCH_UP_COUPONS)), bond.currency)
  return {
    secondsPerDay,
    planned: amount(size + allCoupons, bond.currency),
    coupons: {
      limits: { debitAmount: couponLimit, interval: `R/${new Date().toISOString()}/PT${period * secondsPerDay}S` },
      limit: couponLimit,
      planned: amount(allCoupons, bond.currency)
    },
    principal: {
      limits: { debitAmount: amount(withHeadroom(size), bond.currency) },
      limit: amount(withHeadroom(size), bond.currency),
      planned: amount(size, bond.currency)
    }
  }
}

// The grant for each purpose: an approved one first, else the latest. Grants approved before there were two
// are 'both' and cover coupons and principal.
function grantsOf(bondId) {
  const latest = (purpose, approvedOnly) =>
    db.prepare(`SELECT * FROM grants WHERE bond_id = ? AND purpose = ? ${approvedOnly ? `AND state = 'approved'` : ''} ORDER BY created_at DESC LIMIT 1`)
      .get(bondId, purpose)
  const pick = (purpose) => latest(purpose, true) ?? latest('both', true) ?? latest(purpose) ?? latest('both') ?? null
  return { coupons: pick('coupons'), principal: pick('principal') }
}

// An active bond still on a single grant from before there were two can move to the two grants
const onLegacyGrant = (bondId) => Object.values(grantsOf(bondId)).some((g) => g?.purpose === 'both')

const approved = (grant) => grant?.state === 'approved'

// The issuer asks for the next grant the bond still needs; returns the URL of their bank's consent screen
async function requestGrant(issuer, bondId, appUrl) {
  const bond = db.prepare('SELECT * FROM bonds WHERE id = ?').get(bondId)
  if (!bond) throw new UserError('Bond not found')
  if (bond.issuer_node !== issuer.node || bond.issuer_account !== issuer.id) throw new UserError('Only the issuer can approve this bond’s grants')
  const upgrading = bond.lifecycle === 'active' && onLegacyGrant(bondId)
  if (bond.lifecycle !== 'awaiting_grant' && !upgrading) {
    throw new UserError(bond.lifecycle ? 'This bond already has its grants' : 'The grants are approved once the first slice has sold')
  }
  const current = grantsOf(bondId)
  const purpose = current.coupons?.purpose === 'coupons' && approved(current.coupons) ? 'principal' : 'coupons'
  await openPayments.ensureClient()
  const terms = grantTerms(bond)
  const id = randomUUID()
  const clientNonce = randomUUID()
  const requested = await openPayments.requestOutgoingPaymentGrant({
    walletAddress: issuer.walletAddress,
    limits: terms[purpose].limits,
    finishUri: `${appUrl}/grants/finish?grant=${id}`,
    nonce: clientNonce
  })
  db.prepare(
    `INSERT INTO grants (id, bond_id, purpose, wallet_address, resource_server, state, client_nonce, finish_nonce, auth_server,
      continue_uri, continue_token, redirect, interval, interval_limit, planned_total, seconds_per_day, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, bond.id, purpose, issuer.walletAddress, requested.walletAddress.resourceServer, clientNonce, requested.finishNonce,
    requested.walletAddress.authServer, requested.continueUri, requested.continueToken, requested.redirect,
    terms[purpose].limits.interval ?? '', JSON.stringify(terms[purpose].limit), JSON.stringify(terms[purpose].planned),
    terms.secondsPerDay, now()
  )
  return { grantId: id, purpose, redirect: requested.redirect, limits: terms[purpose].limits }
}

// After the consent screen: continue the grant to get its access token. Returns 'approved', 'rejected' or
// 'failed'. Used for bond grants here and for recurring-purchase grants (lib/plans.js).
async function completeGrant(grant, { interact_ref: interactRef, hash, result }) {
  if (!interactRef || result === 'grant_rejected') {
    db.prepare(`UPDATE grants SET state = 'rejected', error = 'The grant was not approved' WHERE id = ?`).run(grant.id)
    return 'rejected'
  }
  // GNAP interaction hash: sha-256 of client nonce, server nonce, interact_ref and the grant endpoint
  const hashFor = (endpoint) => createHash('sha256').update(`${grant.client_nonce}\n${grant.finish_nonce}\n${interactRef}\n${endpoint}`).digest('base64')
  if (hash && ![grant.auth_server, `${grant.auth_server}/`].map(hashFor).includes(hash)) {
    console.warn(`Grant ${grant.id}: interaction hash did not match; continuing, since the continue request is signed`)
  }
  try {
    const token = await openPayments.continueGrant({ continueUri: grant.continue_uri, continueToken: grant.continue_token, interactRef })
    db.prepare(
      `UPDATE grants SET state = 'approved', access_token = ?, manage_uri = ?, token_expires_at = ?, approved_at = ?, error = NULL WHERE id = ?`
    ).run(token.value, token.manage, Date.now() + Number(token.expires_in ?? 600) * 1000, now(), grant.id)
    return 'approved'
  } catch (err) {
    db.prepare(`UPDATE grants SET state = 'failed', error = ? WHERE id = ?`).run(err.message, grant.id)
    return 'failed'
  }
}

// The browser comes back from a bond's consent screen: continue the grant, then either send the browser on to
// approve the principal grant, or start the bond's term. Returns where to send the browser next.
async function finishGrant(grant, query, appUrl) {
  const outcome = await completeGrant(grant, query)
  if (outcome !== 'approved') return `/bonds?grant=${outcome}&bond=${grant.bond_id}`

  const bond = db.prepare('SELECT * FROM bonds WHERE id = ?').get(grant.bond_id)
  const upgrading = bond.lifecycle === 'active'
  const principal = grantsOf(bond.id).principal
  if (!approved(principal) || principal.purpose !== 'principal') {
    // Straight on to the second consent screen
    try {
      const issuer = await mockBank.findAccount(bond.issuer_node, bond.issuer_account)
      return (await requestGrant(issuer, bond.id, appUrl)).redirect
    } catch (err) {
      console.error(`${bond.name}: requesting the principal grant failed: ${err.message}`)
      return `/bonds?grant=principal&bond=${bond.id}`
    }
  }
  if (upgrading) {
    // Both new grants are in place: retire the old single grant; the term carries on
    await revokeGrants(bond.id, 'both')
    return `/bonds?grant=upgraded&bond=${bond.id}`
  }
  db.prepare(`UPDATE bonds SET lifecycle = 'active', term_start_demo = ?, events_done = 0 WHERE id = ?`).run(Math.floor(clock.now()), bond.id)
  return `/bonds?grant=approved&bond=${bond.id}`
}

// Access tokens last 10 minutes; rotate before they expire (an expired token can still be rotated)
async function freshToken(stale) {
  // Read it again: an earlier payment may have rotated the token, which revokes the one in `stale`
  const grant = db.prepare('SELECT * FROM grants WHERE id = ?').get(stale.id)
  if (grant.token_expires_at - Date.now() > TOKEN_REFRESH_MS) return grant
  const token = await openPayments.rotateToken({ manage: grant.manage_uri, value: grant.access_token })
  db.prepare(`UPDATE grants SET access_token = ?, manage_uri = ?, token_expires_at = ? WHERE id = ?`).run(
    token.value, token.manage, Date.now() + Number(token.expires_in ?? 600) * 1000, grant.id
  )
  return db.prepare('SELECT * FROM grants WHERE id = ?').get(grant.id)
}

async function revokeGrants(bondId, purpose) {
  const grants = purpose
    ? db.prepare(`SELECT * FROM grants WHERE bond_id = ? AND state = 'approved' AND purpose = ?`).all(bondId, purpose)
    : db.prepare(`SELECT * FROM grants WHERE bond_id = ? AND state = 'approved' AND purpose != 'plan'`).all(bondId)
  for (const grant of grants) {
    try {
      await openPayments.revokeToken({ manage: grant.manage_uri, value: grant.access_token })
    } catch (err) {
      console.warn(`Revoking grant ${grant.id}: ${err.message}`)
    }
    db.prepare(`UPDATE grants SET state = 'revoked' WHERE id = ?`).run(grant.id)
  }
}

// --- Coupon run ---

async function rateBetween(from, to) {
  if (from === to) return 1
  const perUsd = { USD: 1, ...(await mockBank.getUsdRates('hbcu')) }
  return perUsd[to] / perUsd[from]
}

function holdersOf(bondId) {
  return db
    .prepare(`SELECT holder_node, holder_account, holder_name, holder_wallet, SUM(CAST(amount AS INTEGER)) AS face
      FROM holdings WHERE bond_id = ? GROUP BY holder_node, holder_account`)
    .all(bondId)
}

function accrual(bondId, h) {
  db.prepare(
    `INSERT INTO accruals (bond_id, holder_node, holder_account, holder_name, holder_wallet, owed_micro) VALUES (?, ?, ?, ?, ?, '0')
     ON CONFLICT DO NOTHING`
  ).run(bondId, h.holder_node, h.holder_account, h.holder_name, h.holder_wallet)
  return db.prepare('SELECT * FROM accruals WHERE bond_id = ? AND holder_node = ? AND holder_account = ?').get(bondId, h.holder_node, h.holder_account)
}

// Coupons owed are in owed_micro; principal owed in principal_micro, with principal_due set until it is repaid
function updateAccrual(bondId, a, { coupons, principal }) {
  if (coupons !== undefined) {
    db.prepare('UPDATE accruals SET owed_micro = ? WHERE bond_id = ? AND holder_node = ? AND holder_account = ?')
      .run((coupons > BigInt(0) ? coupons : BigInt(0)).toString(), bondId, a.holder_node, a.holder_account)
  }
  if (principal !== undefined) {
    const left = principal >= MICRO ? principal : BigInt(0) // less than a cent left over is dropped
    db.prepare('UPDATE accruals SET principal_micro = ?, principal_due = ? WHERE bond_id = ? AND holder_node = ? AND holder_account = ?')
      .run(left.toString(), left > BigInt(0) ? 1 : 0, bondId, a.holder_node, a.holder_account)
  }
}

const isLackOfFunds = (result) => result.state === 'CANCELLED' || /balance|insufficient funds/i.test(result.error ?? '')
const owedFor = (a, part) => BigInt(part === 'principal' ? a.principal_micro : a.owed_micro)
const reduce = (bondId, a, part, sent) =>
  updateAccrual(bondId, a, { [part === 'principal' ? 'principal' : 'coupons']: owedFor(a, part) - BigInt(sent.value) * MICRO })

// Pays one holder one part (coupons or principal) of what the issuer owes them; returns the line's outcome.
// What's owed is changed by recordOutcome, together with the line, so an interrupted run can be resumed.
async function payHolder(bond, grant, issuer, a, part, lineId, holderCount = 1) {
  let owed = owedFor(a, part)
  // A coupons grant allows only a few coupons per period: after a long gap (grant expired, payments failing)
  // pay this holder's share of 80% of that limit now and carry the rest to later dates
  if (part === 'coupon' && grant?.purpose === 'coupons') {
    const cap = (BigInt(parse(grant.interval_limit).value) * MICRO * BigInt(8)) / BigInt(10) / BigInt(holderCount)
    if (owed > cap) owed = cap
  }
  if (!approved(grant)) return { status: 'failed', error: `No approved ${part === 'principal' ? 'principal' : 'coupons'} grant` }
  const holder = await mockBank.findAccount(a.holder_node, a.holder_account).catch(() => null)
  if (!holder) return { status: 'failed', error: 'Holder account not found (was its mock bank restarted?)' }

  // Whole minor units of the holder's currency that what's owed is worth; anything less carries forward
  const rate = await rateBetween(bond.currency, holder.assetCode)
  const holderUnits = BigInt(Math.floor((Number(owed) / Number(MICRO)) * rate))
  if (holderUnits < BigInt(1)) return { status: 'carried' }

  const fresh = await freshToken(grant)
  const result = await payments.payUnderGrant({
    type: part,
    grant: { id: fresh.id, resourceServer: fresh.resource_server, accessToken: fresh.access_token },
    sender: issuer,
    receiver: holder,
    receiveAmount: amount(holderUnits, holder.assetCode),
    details: { bondId: bond.id, bondName: bond.name, part, lineId }
  })
  const line = { paymentId: result.id ?? null, debit: result.debit ?? null, sent: result.sent ?? null, received: result.received ?? null, error: result.error ?? null }
  if (result.state === 'COMPLETED') return { ...line, status: 'paid' }
  if (result.state === 'SENDING') return { ...line, status: 'sending' }
  return { ...line, status: isLackOfFunds(result) ? 'missed' : 'failed' }
}

// Records a line's outcome and what's then owed, in one transaction. A paid coupon reduces the coupons owed by
// what the issuer sent; a paid principal leaves less than one unit of the holder's currency, so it's repaid; a
// principal worth less than a cent to the holder (carried) is dropped.
function recordOutcome(bondId, lineId, line) {
  const row = db.prepare('SELECT * FROM coupon_lines WHERE id = ?').get(lineId)
  db.exec('BEGIN')
  try {
    const a = db.prepare('SELECT * FROM accruals WHERE bond_id = ? AND holder_node = ? AND holder_account = ?').get(bondId, row.holder_node, row.holder_account)
    if (row.part === 'principal' && (line.status === 'paid' || line.status === 'carried')) updateAccrual(bondId, a, { principal: BigInt(0) })
    else if (line.status === 'paid') reduce(bondId, a, row.part, line.sent)
    db.prepare('UPDATE coupon_lines SET payment_id = ?, debit = ?, sent = ?, received = ?, status = ?, error = ? WHERE id = ?').run(
      line.paymentId ?? null, line.debit ? JSON.stringify(line.debit) : null, line.sent ? JSON.stringify(line.sent) : null,
      line.received ? JSON.stringify(line.received) : null, line.status, line.error ?? null, lineId
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function eventStatus(statuses) {
  if (statuses.includes('missed')) return 'missed'
  if (statuses.includes('sending')) return 'sending'
  if (statuses.includes('failed')) return 'failed'
  return 'paid'
}

// Coupon dates processed so far: paid, missed in a row at the end, and whether the bond defaults
function refreshCounters(bondId) {
  const events = db.prepare(`SELECT status FROM coupon_events WHERE bond_id = ? ORDER BY idx`).all(bondId).map((e) => e.status)
  let inRow = 0
  for (let i = events.length - 1; i >= 0 && events[i] === 'missed'; i--) inRow++
  db.prepare('UPDATE bonds SET coupons_paid = ?, coupons_missed = ?, missed_in_row = ? WHERE id = ?').run(
    events.filter((s) => s === 'paid').length, events.filter((s) => s === 'missed').length, inRow, bondId
  )
  return inRow
}

async function close(bond, lifecycle, demoMs) {
  db.prepare(`UPDATE bonds SET lifecycle = ?, status = 'closed', closed_demo = ? WHERE id = ?`).run(lifecycle, Math.floor(demoMs), bond.id)
  await revokeGrants(bond.id)
  console.log(`${bond.name}: ${lifecycle === 'matured' ? 'matured' : 'in default'}`)
}

// Runs coupon date k. Resumable: for each holder the interest added and the lines to pay are recorded in one
// transaction before any payment, each payment carries its line's id, and an outcome is recorded with the change
// to what's owed. A run interrupted part-way (the app stopped) picks up where it left off.
async function runEvent(bond, k) {
  const s = schedule(bond)
  const kind = s.kind(k)
  const days = s.days(k)
  const issuer = await mockBank.findAccount(bond.issuer_node, bond.issuer_account)
  const grants = grantsOf(bond.id)
  let event = db.prepare('SELECT * FROM coupon_events WHERE bond_id = ? AND idx = ?').get(bond.id, k)
  if (!event) {
    db.prepare(`INSERT INTO coupon_events (id, bond_id, idx, kind, due_demo, status, ran_at) VALUES (?, ?, ?, ?, ?, 'sending', ?)`)
      .run(randomUUID(), bond.id, k, kind, s.due(k), now())
    event = db.prepare('SELECT * FROM coupon_events WHERE bond_id = ? AND idx = ?').get(bond.id, k)
  } else {
    console.log(`${bond.name}: resuming ${kind} ${k}`)
  }

  const holders = holdersOf(bond.id)
  for (const h of holders) {
    const linesOf = () => db.prepare('SELECT * FROM coupon_lines WHERE event_id = ? AND holder_node = ? AND holder_account = ?').all(event.id, h.holder_node, h.holder_account)
    if (!linesOf().length) {
      db.exec('BEGIN')
      try {
        let a = accrual(bond.id, h)
        const added = interestMicro(h.face, bond.annual_rate, days)
        updateAccrual(bond.id, a, {
          coupons: BigInt(a.owed_micro) + added,
          ...(kind === 'maturity' ? { principal: BigInt(a.principal_micro) + BigInt(h.face) * MICRO } : {})
        })
        a = accrual(bond.id, h)
        const parts = [...(BigInt(a.owed_micro) > BigInt(0) ? ['coupon'] : []), ...(a.principal_due ? ['principal'] : [])]
        for (const part of parts) {
          db.prepare(
            `INSERT INTO coupon_lines (id, event_id, bond_id, holder_node, holder_account, holder_name, part, accrued_micro, owed_micro,
              status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          ).run(randomUUID(), event.id, bond.id, h.holder_node, h.holder_account, h.holder_name, part,
            (part === 'coupon' ? added : BigInt(0)).toString(), owedFor(a, part).toString(), now())
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }

    for (const line of linesOf().filter((l) => l.status === 'pending')) {
      // A payment made for this line before an interruption: settle from it instead of paying again
      const made = db.prepare(`SELECT id FROM payments WHERE details LIKE ?`).get(`%"lineId":"${line.id}"%`)
      if (made) {
        db.prepare(`UPDATE coupon_lines SET status = 'sending', payment_id = ? WHERE id = ?`).run(made.id, line.id)
        continue
      }
      const a = accrual(bond.id, h)
      const outcome = await payHolder(bond, line.part === 'principal' ? grants.principal : grants.coupons, issuer, a, line.part, line.id, holders.length)
        .catch((err) => ({ status: 'failed', error: err.message }))
      recordOutcome(bond.id, line.id, outcome)
    }
  }

  reconcileSending(bond.id)
  const statuses = db.prepare('SELECT status FROM coupon_lines WHERE event_id = ?').all(event.id).map((l) => l.status)
  db.prepare('UPDATE coupon_events SET status = ? WHERE id = ?').run(eventStatus(statuses), event.id)
  db.prepare('UPDATE bonds SET events_done = ? WHERE id = ?').run(k, bond.id)
  console.log(`${bond.name}: ${kind} ${k}/${s.events} (day ${clock.dayOf(s.due(k))}): ${statuses.join(', ') || 'nothing owed'}`)
  return afterEvent(bond.id, k, s.due(k))
}

// Coupon lines whose payment was still sending: settle them from the payment record
function reconcileSending(bondId) {
  const lines = db.prepare(`SELECT * FROM coupon_lines WHERE bond_id = ? AND status = 'sending'`).all(bondId)
  for (const line of lines) {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(line.payment_id)
    if (!p || ['SENDING', 'SETTLING'].includes(p.state)) continue
    const status = p.state === 'COMPLETED' ? 'paid' : isLackOfFunds({ state: p.state, error: p.error }) ? 'missed' : 'failed'
    recordOutcome(bondId, line.id, { status, paymentId: p.id, debit: parse(p.quoted_debit), sent: parse(p.sent), received: parse(p.received), error: p.error })
    const statuses = db.prepare('SELECT status FROM coupon_lines WHERE event_id = ?').all(line.event_id).map((l) => l.status)
    db.prepare('UPDATE coupon_events SET status = ? WHERE id = ?').run(eventStatus(statuses), line.event_id)
  }
  return lines.length
}

async function afterEvent(bondId, k, dueDemo) {
  const bond = db.prepare('SELECT * FROM bonds WHERE id = ?').get(bondId)
  const inRow = refreshCounters(bondId)
  const s = schedule(bond)
  if (inRow >= MISSED_FOR_DEFAULT) return close(bond, 'in_default', dueDemo)
  if (k >= s.events) {
    const owing = db.prepare(`SELECT COUNT(*) AS n FROM accruals WHERE bond_id = ? AND principal_due = 1`).get(bondId).n
    if (owing === 0) return close(bond, 'matured', dueDemo)
    if (k >= s.events + RETRY_PERIODS) return close(bond, 'in_default', dueDemo) // principal still unpaid after the retry periods
  }
}

let running = false
let lastTickAt = 0
async function tick() {
  lastTickAt = Date.now()
  if (running || clock.isPaused() || maintenance.state.active) return // paused: no coupon dates arrive, so nothing is paid
  running = true
  try {
    for (const bond of db.prepare(`SELECT * FROM bonds WHERE lifecycle = 'active'`).all()) {
      if (reconcileSending(bond.id)) await afterEvent(bond.id, bond.events_done, clock.now())
      const fresh = db.prepare('SELECT * FROM bonds WHERE id = ?').get(bond.id)
      if (fresh.lifecycle !== 'active') continue
      // Wait for a payment still sending before moving on, so nothing is paid twice
      if (db.prepare(`SELECT COUNT(*) AS n FROM coupon_lines WHERE bond_id = ? AND status = 'sending'`).get(bond.id).n) continue
      const k = fresh.events_done + 1
      if (clock.now() >= schedule(fresh).due(k)) {
        await runEvent(fresh, k).catch((err) => console.error(`${fresh.name}: coupon ${k} failed to run: ${err.message}`))
      }
    }
  } finally {
    running = false
  }
}

// --- What the pages show ---

const LIFECYCLE_LABELS = { awaiting_grant: 'Awaiting grant', active: 'Active', matured: 'Matured', in_default: 'In Default' }

function sumAmounts(list) {
  const totals = {}
  for (const a of list.filter(Boolean)) {
    totals[a.assetCode] ??= { value: BigInt(0), assetCode: a.assetCode, assetScale: a.assetScale }
    totals[a.assetCode].value += BigInt(a.value)
  }
  return Object.values(totals).map((t) => ({ ...t, value: t.value.toString() }))
}

function grantView(grant, used, currency) {
  if (!grant) return null
  const planned = parse(grant.planned_total)
  return {
    purpose: grant.purpose,
    state: grant.state,
    limit: parse(grant.interval_limit),
    interval: grant.interval || null,
    planned,
    used: amount(used, currency),
    redirect: grant.state === 'pending' ? grant.redirect : null,
    error: grant.state === 'failed' || grant.state === 'rejected' ? grant.error : null
  }
}

function bondStatus(bond) {
  const s = schedule(bond)
  const grants = grantsOf(bond.id)
  const usedBy = (parts) =>
    db.prepare(`SELECT debit FROM coupon_lines WHERE bond_id = ? AND status = 'paid' AND part IN (${parts.map(() => '?').join(', ')})`)
      .all(bond.id, ...parts).reduce((sum, l) => sum + BigInt(parse(l.debit)?.value ?? 0), BigInt(0))
  const legacy = grants.coupons?.purpose === 'both' && grants.principal?.purpose === 'both'
  const coupons = grantView(grants.coupons, usedBy(legacy ? ['coupon', 'principal'] : ['coupon']), bond.currency)
  const principal = legacy ? null : grantView(grants.principal, usedBy(['principal']), bond.currency)
  const plannedTotal = legacy ? BigInt(coupons.planned.value) : BigInt(coupons?.planned.value ?? 0) + BigInt(principal?.planned.value ?? 0)
  const usedTotal = usedBy(['coupon', 'principal'])
  const states = [coupons?.state, legacy ? 'approved' : principal?.state]
  const pending = [coupons, principal].find((g) => g?.state === 'pending')

  const nextK = bond.events_done + 1
  const nextReal = bond.lifecycle === 'active' ? clock.realTimeOf(s.due(nextK)) : null
  const next = bond.lifecycle === 'active'
    ? { day: clock.dayOf(s.due(nextK)), kind: s.kind(nextK), paused: clock.isPaused(), inSeconds: nextReal === null ? null : Math.max(0, Math.ceil((nextReal - Date.now()) / 1000)) }
    : null
  return {
    lifecycle: bond.lifecycle ?? 'selling',
    lifecycleLabel: LIFECYCLE_LABELS[bond.lifecycle] ?? 'Selling',
    termStartDay: bond.term_start_demo ? clock.dayOf(bond.term_start_demo) : null,
    maturityDay: bond.term_start_demo ? clock.dayOf(bond.term_start_demo + bond.term_days * clock.DAY_MS) : null,
    closedDay: bond.closed_demo ? clock.dayOf(bond.closed_demo) : null,
    nextCoupon: next,
    couponDates: s.events,
    couponsDone: bond.events_done,
    couponsPaid: bond.coupons_paid,
    couponsMissed: bond.coupons_missed,
    missedInRow: bond.missed_in_row,
    grant: coupons && {
      // approved | revoked | pending | partial (coupons approved, principal not yet) | rejected | failed
      state: states.every((st) => st === 'approved') ? 'approved'
        : states.every((st) => st === 'revoked' || st === 'approved') && states.includes('revoked') ? 'revoked'
        : pending ? 'pending'
        : coupons.state === 'approved' ? 'partial'
        : coupons.state,
      coupons,
      principal,
      planned: amount(plannedTotal, bond.currency),
      used: amount(usedTotal, bond.currency),
      remaining: amount(plannedTotal - usedTotal > BigInt(0) ? plannedTotal - usedTotal : 0, bond.currency),
      redirect: pending?.redirect ?? null,
      error: [coupons, principal].find((g) => g?.error)?.error ?? null,
      legacy: !!legacy // a single grant from before there were two: the issuer can re-approve as two
    }
  }
}

// One holder's coupons and principal on one bond
function holderStatus(bondId, holderNode, holderAccount, bondCurrency) {
  const lines = db.prepare(`SELECT l.*, e.kind FROM coupon_lines l JOIN coupon_events e ON e.id = l.event_id
    WHERE l.bond_id = ? AND l.holder_node = ? AND l.holder_account = ? ORDER BY l.created_at`).all(bondId, holderNode, holderAccount)
  const a = db.prepare('SELECT * FROM accruals WHERE bond_id = ? AND holder_node = ? AND holder_account = ?').get(bondId, holderNode, holderAccount)
  const paid = lines.filter((l) => l.status === 'paid')
  return {
    received: sumAmounts(paid.map((l) => parse(l.received))),
    paymentsReceived: paid.length,
    missed: lines.filter((l) => l.status === 'missed').length,
    carried: amount((a ? BigInt(a.owed_micro) : BigInt(0)) / MICRO, bondCurrency), // coupons owed, not yet paid
    principalOwed: amount((a ? BigInt(a.principal_micro) : BigInt(0)) / MICRO, bondCurrency),
    // principal paid on its own line, or (grants from before there were two) with the maturity coupon
    principalRepaid: paid.some((l) => l.part === 'principal') || paid.some((l) => l.part === 'coupon' && l.kind !== 'coupon' && !a?.principal_due && BigInt(l.owed_micro) >= MICRO * BigInt(100))
  }
}

function couponHistory(bondId) {
  return db.prepare(`SELECT * FROM coupon_events WHERE bond_id = ? ORDER BY idx DESC LIMIT 30`).all(bondId).map((e) => ({
    idx: e.idx,
    kind: e.kind,
    day: clock.dayOf(e.due_demo),
    status: e.status,
    lines: db.prepare('SELECT * FROM coupon_lines WHERE event_id = ?').all(e.id).map((l) => ({
      holder: l.holder_name,
      part: l.part,
      status: l.status,
      sent: parse(l.sent),
      received: parse(l.received),
      error: l.error
    }))
  }))
}

const schedulerState = () => ({ running, lastTickAt })

module.exports = { schedulerState, PERIOD_DAYS, grantTerms, requestGrant, completeGrant, finishGrant, freshToken, tick, bondStatus, holderStatus, couponHistory }
