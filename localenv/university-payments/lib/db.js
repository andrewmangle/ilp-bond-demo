// The demo app's own records in a local SQLite file (Node's built-in node:sqlite). Rafiki and the mock banks
// stay the source of truth for money; this keeps what they don't: payment types, names and central-bank actions.

const { DatabaseSync } = require('node:sqlite')
const { mkdirSync } = require('fs')
const path = require('path')

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'demo.db')

// Applied in order; PRAGMA user_version records how many have run
const MIGRATIONS = [
  `CREATE TABLE payments (
    id TEXT PRIMARY KEY,               -- Rafiki outgoing payment id
    type TEXT NOT NULL,                -- funding | payment | bond | coupon
    quote_id TEXT NOT NULL,
    incoming_payment_url TEXT NOT NULL,
    sender_node TEXT NOT NULL,
    sender_account TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sender_wallet TEXT NOT NULL,
    receiver_node TEXT NOT NULL,
    receiver_account TEXT NOT NULL,
    receiver_name TEXT NOT NULL,
    receiver_wallet TEXT NOT NULL,
    quoted_debit TEXT NOT NULL,        -- amounts are JSON { value, assetCode, assetScale }
    quoted_receive TEXT NOT NULL,
    sent TEXT,
    received TEXT,
    state TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX payments_incoming ON payments (incoming_payment_url);
  CREATE TABLE mints (
    id TEXT PRIMARY KEY,               -- Rafiki liquidity transfer id
    node TEXT NOT NULL,
    treasury_account TEXT NOT NULL,
    treasury_name TEXT NOT NULL,
    amount TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE rates (
    currency TEXT PRIMARY KEY,         -- the rate each central bank has set for its currency
    node TEXT NOT NULL,
    per_usd REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE rate_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node TEXT NOT NULL,
    currency TEXT NOT NULL,
    old_per_usd REAL,
    new_per_usd REAL NOT NULL,
    created_at TEXT NOT NULL
  );`,

  // Phase 2: the bond registry. Amounts are minor units of the bond's currency.
  `ALTER TABLE payments ADD COLUMN details TEXT; -- JSON, e.g. { bondId, holder } for a bond purchase
  CREATE TABLE bonds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    issuer_node TEXT NOT NULL,
    issuer_account TEXT NOT NULL,
    issuer_name TEXT NOT NULL,
    issuer_wallet TEXT NOT NULL,
    currency TEXT NOT NULL,
    scale INTEGER NOT NULL,
    size TEXT NOT NULL,
    min_slice TEXT NOT NULL,
    annual_rate REAL NOT NULL,         -- percent, e.g. 9 for 9%
    term_days INTEGER NOT NULL,
    coupon_frequency TEXT NOT NULL,    -- daily | weekly | monthly | quarterly | semiannual | annual
    status TEXT NOT NULL,              -- open | sold_out
    issued_at TEXT NOT NULL,
    matures_at TEXT NOT NULL
  );
  CREATE TABLE holdings (
    id TEXT PRIMARY KEY,
    bond_id TEXT NOT NULL REFERENCES bonds (id),
    amount TEXT NOT NULL,              -- face amount of the slice
    holder_node TEXT NOT NULL,
    holder_account TEXT NOT NULL,
    holder_name TEXT NOT NULL,
    holder_wallet TEXT NOT NULL,
    buyer_node TEXT NOT NULL,
    buyer_account TEXT NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_wallet TEXT NOT NULL,
    payment_id TEXT NOT NULL UNIQUE REFERENCES payments (id),
    paid TEXT NOT NULL,                -- JSON amount the buyer was charged, buyer's currency
    received TEXT NOT NULL,            -- JSON amount the issuer received, bond currency
    created_at TEXT NOT NULL
  );
  CREATE INDEX holdings_bond ON holdings (bond_id);`,

  // Phase 3: demo clock, coupon grants, coupons and maturity
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  ALTER TABLE bonds ADD COLUMN lifecycle TEXT;          -- null (no slice sold) | awaiting_grant | active | matured | in_default
  ALTER TABLE bonds ADD COLUMN term_start_demo INTEGER; -- demo-clock ms when the grant was approved
  ALTER TABLE bonds ADD COLUMN events_done INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bonds ADD COLUMN coupons_paid INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bonds ADD COLUMN coupons_missed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bonds ADD COLUMN missed_in_row INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bonds ADD COLUMN closed_demo INTEGER;     -- demo-clock ms when it matured or defaulted
  UPDATE bonds SET lifecycle = 'awaiting_grant' WHERE id IN (SELECT bond_id FROM holdings);
  CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    bond_id TEXT NOT NULL REFERENCES bonds (id),
    wallet_address TEXT NOT NULL,
    resource_server TEXT,
    state TEXT NOT NULL,               -- pending | approved | rejected | revoked | failed
    client_nonce TEXT NOT NULL,
    finish_nonce TEXT,                 -- from the auth server, to check the hash on the way back
    auth_server TEXT,
    continue_uri TEXT,
    continue_token TEXT,
    redirect TEXT,
    access_token TEXT,
    manage_uri TEXT,
    token_expires_at INTEGER,          -- real ms
    interval TEXT NOT NULL,            -- ISO 8601 repeating interval, in real time
    interval_limit TEXT NOT NULL,      -- JSON amount Rafiki allows per interval
    planned_total TEXT NOT NULL,       -- JSON amount: all coupons plus principal for the term
    seconds_per_day INTEGER NOT NULL,  -- demo clock speed the interval was set for
    error TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT
  );
  CREATE TABLE accruals (              -- what the issuer owes each holder, in millionths of a bond minor unit
    bond_id TEXT NOT NULL REFERENCES bonds (id),
    holder_node TEXT NOT NULL,
    holder_account TEXT NOT NULL,
    holder_name TEXT NOT NULL,
    holder_wallet TEXT NOT NULL,
    owed_micro TEXT NOT NULL,
    principal_due INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bond_id, holder_node, holder_account)
  );
  CREATE TABLE coupon_events (
    id TEXT PRIMARY KEY,
    bond_id TEXT NOT NULL REFERENCES bonds (id),
    idx INTEGER NOT NULL,
    kind TEXT NOT NULL,                -- coupon | maturity | retry
    due_demo INTEGER NOT NULL,
    status TEXT NOT NULL,              -- paid | missed | failed
    ran_at TEXT NOT NULL,
    UNIQUE (bond_id, idx)
  );
  CREATE TABLE coupon_lines (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES coupon_events (id),
    bond_id TEXT NOT NULL,
    holder_node TEXT NOT NULL,
    holder_account TEXT NOT NULL,
    holder_name TEXT NOT NULL,
    accrued_micro TEXT NOT NULL,       -- added this period
    owed_micro TEXT NOT NULL,          -- owed before paying, principal included
    payment_id TEXT,
    debit TEXT,                        -- JSON, bond currency (what the grant is charged)
    sent TEXT,                         -- JSON, bond currency
    received TEXT,                     -- JSON, holder currency
    status TEXT NOT NULL,              -- paid | carried | missed | failed
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX coupon_lines_bond ON coupon_lines (bond_id);`,

  // Two grants per bond: coupons (small limit per period) and principal (one-off limit). Grants approved before
  // this are 'both'. The principal owed is kept apart from the coupons owed, and paid as its own payment.
  `ALTER TABLE grants ADD COLUMN purpose TEXT NOT NULL DEFAULT 'both'; -- coupons | principal | both
  ALTER TABLE accruals ADD COLUMN principal_micro TEXT NOT NULL DEFAULT '0';
  ALTER TABLE coupon_lines ADD COLUMN part TEXT NOT NULL DEFAULT 'coupon'; -- coupon | principal`,

  // Phase 4: recurring purchases under a grant from the buyer
  `ALTER TABLE grants ADD COLUMN plan_id TEXT; -- purpose 'plan': the buyer's grant for a recurring purchase
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    bond_id TEXT NOT NULL REFERENCES bonds (id),
    buyer_node TEXT NOT NULL,
    buyer_account TEXT NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_wallet TEXT NOT NULL,
    holder_node TEXT NOT NULL,
    holder_account TEXT NOT NULL,
    holder_name TEXT NOT NULL,
    holder_wallet TEXT NOT NULL,
    amount TEXT NOT NULL,              -- face amount per purchase, bond currency minor units
    frequency TEXT NOT NULL,           -- weekly | monthly
    max_purchases INTEGER,             -- number of purchase dates, or
    end_demo INTEGER,                  -- last demo time a purchase may be made
    state TEXT NOT NULL,               -- awaiting_grant | active | paused | completed | cancelled
    start_demo INTEGER,                -- demo-clock ms of the first purchase date (when the grant was approved)
    runs_done INTEGER NOT NULL DEFAULT 0,
    estimate TEXT NOT NULL,            -- JSON: cost of one purchase in the buyer's currency when set up
    limit_amount TEXT NOT NULL,        -- JSON: the grant's limit per period (estimate plus buffer)
    flag TEXT,                         -- e.g. a purchase skipped because the quote was over the grant limit
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE TABLE plan_runs (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans (id),
    idx INTEGER NOT NULL,
    due_demo INTEGER NOT NULL,
    status TEXT NOT NULL,              -- pending | sending | bought | skipped
    reason TEXT,
    payment_id TEXT,
    debit TEXT,                        -- JSON, buyer's currency: what the quote said (counted against the grant)
    sent TEXT,
    received TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (plan_id, idx)
  );`
]

mkdirSync(path.dirname(DB_FILE), { recursive: true })
const db = new DatabaseSync(DB_FILE)
db.exec('PRAGMA journal_mode = WAL')

const { user_version: applied } = db.prepare('PRAGMA user_version').get()
for (let i = applied; i < MIGRATIONS.length; i++) {
  db.exec('BEGIN')
  db.exec(MIGRATIONS[i])
  db.exec(`PRAGMA user_version = ${i + 1}`)
  db.exec('COMMIT')
}

const now = () => new Date().toISOString()

module.exports = { db, now, DB_FILE }
