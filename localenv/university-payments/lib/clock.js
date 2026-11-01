// The demo clock: bond time runs faster than real time (by default 1 bond day = 1 real minute), so coupons and
// maturity happen during a demo. Demo time is anchored to real time; changing the speed re-anchors it so the
// demo date doesn't jump. Day 1 is the day the clock was first started.
//
// The clock can be paused (no coupon dates arrive, so no payments are made), and it only runs while the app
// runs: a heartbeat saves the demo time every few seconds and a restart carries on from there, so stopping the
// app overnight doesn't bring a night's worth of coupon dates due at once.

const { db } = require('./db')
const { UserError } = require('./money')

const DAY_MS = 86_400_000
const DEFAULT_SECONDS_PER_DAY = 60
const SPEEDS = [5, 10, 30, 60, 300, 3600, 86400] // real seconds per demo day
const HEARTBEAT_MS = 5_000

function save(clock) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('clock', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(clock))
}

function load() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'clock'`).get()
  const t = Date.now()
  if (!row) {
    const clock = { epochDemo: t, anchorReal: t, anchorDemo: t, secondsPerDay: DEFAULT_SECONDS_PER_DAY, paused: false }
    save(clock)
    return clock
  }
  const saved = JSON.parse(row.value)
  // Carry on from the last heartbeat rather than counting the time the app was stopped, but never from before
  // a coupon date already paid or a term already started (a clock saved before heartbeats existed could be)
  const { latest } = db.prepare(
    `SELECT MAX(t) AS latest FROM (SELECT MAX(due_demo) AS t FROM coupon_events UNION ALL SELECT MAX(term_start_demo) FROM bonds)`
  ).get()
  const resumed = { paused: false, ...saved, anchorReal: t, anchorDemo: Math.max(saved.heartbeatDemo ?? saved.anchorDemo, latest ?? 0) }
  save(resumed)
  return resumed
}

let clock = load()

// Current demo time in ms
function now() {
  if (clock.paused) return clock.anchorDemo
  return clock.anchorDemo + ((Date.now() - clock.anchorReal) * 86_400) / clock.secondsPerDay
}

function heartbeat() {
  save({ ...clock, heartbeatDemo: now() })
}
setInterval(heartbeat, HEARTBEAT_MS).unref()

// Demo day number of a demo time (day 1 starts when the clock was first started)
function dayOf(demoMs) {
  return Math.floor((demoMs - clock.epochDemo) / DAY_MS) + 1
}

// Real time at which the demo clock reaches a demo time at the current speed; null while paused
function realTimeOf(demoMs) {
  if (clock.paused) return null
  return clock.anchorReal + ((demoMs - clock.anchorDemo) * clock.secondsPerDay) / 86_400
}

function secondsPerDay() {
  return clock.secondsPerDay
}

function reanchor(changes) {
  clock = { ...clock, anchorDemo: now(), anchorReal: Date.now(), ...changes }
  save({ ...clock, heartbeatDemo: clock.anchorDemo })
  console.log(`Demo clock: ${clock.paused ? 'paused' : 'running'} at ${clock.secondsPerDay} s per day, day ${dayOf(clock.anchorDemo)} (${JSON.stringify(changes)})`)
  return state()
}

function setSecondsPerDay(value) {
  const seconds = Number(value)
  if (!SPEEDS.includes(seconds)) throw new UserError(`Pick one of: ${SPEEDS.join(', ')} seconds per demo day`)
  return reanchor({ secondsPerDay: seconds })
}

// Jump demo time ahead, e.g. to the next coupon date; the schedulers then run what came due
function jump(days) {
  const n = Number(days)
  if (!Number.isInteger(n) || n < 1 || n > 30) throw new UserError('Jump ahead 1 to 30 days')
  clock = { ...clock, anchorDemo: now() + n * DAY_MS, anchorReal: Date.now() }
  save({ ...clock, heartbeatDemo: clock.anchorDemo })
  console.log(`Demo clock: jumped ${n} day${n === 1 ? '' : 's'} to day ${dayOf(clock.anchorDemo)}`)
  return state()
}

// Back to day 1 at the default speed, running (Reset Demo)
function reset() {
  const t = Date.now()
  clock = { epochDemo: t, anchorReal: t, anchorDemo: t, secondsPerDay: DEFAULT_SECONDS_PER_DAY, paused: false }
  save({ ...clock, heartbeatDemo: t })
  console.log('Demo clock: reset to day 1')
  return state()
}

const pause = () => reanchor({ paused: true })
const resume = () => reanchor({ paused: false })
const isPaused = () => clock.paused

function state() {
  const t = now()
  const dayStart = clock.epochDemo + (dayOf(t) - 1) * DAY_MS
  const nextDayReal = realTimeOf(dayStart + DAY_MS)
  return {
    day: dayOf(t),
    demoNow: new Date(t).toISOString(),
    secondsPerDay: clock.secondsPerDay,
    paused: clock.paused,
    speeds: SPEEDS,
    secondsToNextDay: nextDayReal === null ? null : Math.ceil((nextDayReal - Date.now()) / 1000)
  }
}

module.exports = { DAY_MS, now, dayOf, realTimeOf, secondsPerDay, setSecondsPerDay, pause, resume, jump, reset, isPaused, state }
