// Set while the demo is being reset: the schedulers (coupons, recurring purchases, settling) stand still
const state = { active: false }

// Demo app data and payments from before the last reset are left out of activity and the live feed
const { db } = require('./db')
function demoEpoch() {
  return db.prepare(`SELECT value FROM settings WHERE key = 'demo_epoch'`).get()?.value ?? '1970-01-01T00:00:00.000Z'
}

module.exports = { state, demoEpoch }
