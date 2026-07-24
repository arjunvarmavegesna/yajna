/* Yajna Pharma Solutions — pharmacy audit console backend
 * Node + Express + SQLite (better-sqlite3). Single-tenant, role-based.
 * Roles: admin (everything) · user (the daily entry screen for their hospitals, nothing else).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const XLSX = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (e) {}

const PORT = process.env.PORT || 3060;
const MARGIN_TOL = parseFloat(process.env.MARGIN_TOLERANCE_PP || '2'); // percentage points
const MARGIN_RATCHET_EPS = 0.01; // percentage points — real improvement, not floating-point noise (see the ratchet in PUT /entries)
const SESSION_DAYS = 30;
const COOKIE = 'yps_session';

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(path.join(__dirname, 'data', 'yajna.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  role_label TEXT NOT NULL, hospital_id TEXT, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hospitals(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, doctor TEXT DEFAULT '', location TEXT DEFAULT '',
  phone TEXT DEFAULT '', start_date TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, base INTEGER NOT NULL DEFAULT 50000);
CREATE TABLE IF NOT EXISTS vendors(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, name TEXT NOT NULL,
  credit_days INTEGER NOT NULL DEFAULT 30, opening_bal REAL NOT NULL DEFAULT 0,
  phone TEXT DEFAULT '', added_on TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_vendors_h ON vendors(hospital_id);
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, vendor_id TEXT NOT NULL, vendor_name TEXT NOT NULL,
  amount REAL NOT NULL, date TEXT NOT NULL, note TEXT DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pay_h ON payments(hospital_id);
CREATE TABLE IF NOT EXISTS entries(
  hospital_id TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, saved_at INTEGER NOT NULL,
  PRIMARY KEY(hospital_id, date));
CREATE TABLE IF NOT EXISTS notifications(
  id TEXT PRIMARY KEY, type TEXT NOT NULL, hospital_id TEXT NOT NULL, date TEXT NOT NULL,
  msg TEXT NOT NULL, ts INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(ts);
CREATE TABLE IF NOT EXISTS report_prefs(
  hospital_id TEXT NOT NULL, type TEXT NOT NULL, prefs TEXT NOT NULL, PRIMARY KEY(hospital_id, type));
CREATE TABLE IF NOT EXISTS hv_tracked(hospital_id TEXT PRIMARY KEY, drugs TEXT NOT NULL DEFAULT '[]');
/* users.hospital_ids: JSON array of hospital ids the user may open; ["*"] = every hospital (incl. future).
   users.active: 0 revokes portal access without deleting the account. */
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
  pack TEXT DEFAULT '', nr REAL NOT NULL DEFAULT 0, mrp REAL NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'manual', updated_at INTEGER NOT NULL,
  UNIQUE(hospital_id, name_key));
CREATE INDEX IF NOT EXISTS idx_items_h ON items(hospital_id);
CREATE TABLE IF NOT EXISTS period_data(
  hospital_id TEXT NOT NULL, ptype TEXT NOT NULL, pkey TEXT NOT NULL,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(hospital_id, ptype, pkey));
/* Stock corrections are recorded as signed movements, never as an overwrite of the
   balance — so the ledger still explains how today's stock was arrived at, and a
   write-off can never be quietly buried inside the computed figure. */
CREATE TABLE IF NOT EXISTS stock_adjustments(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL,
  item_key TEXT NOT NULL, item_name TEXT NOT NULL,
  date TEXT NOT NULL, qty REAL NOT NULL,
  reason TEXT NOT NULL, note TEXT DEFAULT '',
  user_name TEXT DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_adj_h ON stock_adjustments(hospital_id);
/* Receivables. amount_received / amount_due are NEVER stored — they are recomputed
   from the append-only action log, so a correction is always a counter-entry and the
   ledger stays auditable. status_override is flattened onto the row (ov_*). */
CREATE TABLE IF NOT EXISTS receivables(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL,
  bill_no TEXT NOT NULL, bill_date TEXT NOT NULL,
  party TEXT NOT NULL, party_type TEXT NOT NULL,
  amount REAL NOT NULL,
  next_follow_up_date TEXT, assigned_to TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  ov_value TEXT, ov_reason TEXT, ov_by TEXT, ov_at INTEGER, ov_expires TEXT,
  created_by TEXT DEFAULT '', created_at INTEGER NOT NULL,
  UNIQUE(hospital_id, bill_no));
CREATE INDEX IF NOT EXISTS idx_recv_h ON receivables(hospital_id);
CREATE TABLE IF NOT EXISTS receivable_actions(
  id TEXT PRIMARY KEY, receivable_id TEXT NOT NULL, hospital_id TEXT NOT NULL,
  type TEXT NOT NULL, amount REAL, mode TEXT, reason TEXT DEFAULT '',
  approver_id TEXT, approver_name TEXT,
  action_date TEXT NOT NULL, entered_by TEXT DEFAULT '', entered_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ract_r ON receivable_actions(receivable_id);
CREATE INDEX IF NOT EXISTS idx_ract_h ON receivable_actions(hospital_id);
/* Batch-wise stock with expiry, exported from the pharmacy software and uploaded
   here. Kept as its OWN dataset rather than stamped onto our purchase lines:
   their batches and our lots are two different records of the same shelf, and
   forcing one onto the other would have to guess the mapping and would bury the
   disagreement — which is exactly what an audit wants to see. */
CREATE TABLE IF NOT EXISTS expiry_snapshots(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, as_of TEXT NOT NULL,
  file_name TEXT DEFAULT '', rows TEXT NOT NULL,
  uploaded_by TEXT NOT NULL, uploaded_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_snap_h ON expiry_snapshots(hospital_id);
/* Margin offers. A vendor rep proposes a better rate; someone here negotiates it;
   it is chased, then accepted or declined, and only then does it touch the Item
   Master. The point is the FOLLOW-UP — an offer nobody chases is a discount lost,
   so who offered it, who is negotiating, and when it expires all live here. */
/* Items seen on a purchase that the master does not know. They are NOT added —
   they wait here for a manager, because "Rifaximn 550" is usually a typo of an
   item we already have, and an auto-add would mint a phantom. */
/* Documents waiting for the doctor's 24h window to open. A closed window cannot
   block a report forever: the PDF parks here, the doctor gets a template nudge,
   and their reply — any reply — triggers delivery through the webhook. */
/* One link, many price changes: a batch groups proposed offers so the doctor
   rules on the whole day's negotiations in one visit instead of link-per-item. */
CREATE TABLE IF NOT EXISTS approval_batches(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL,
  hash TEXT, offer_ids TEXT NOT NULL,
  sent_at INTEGER NOT NULL, expires INTEGER NOT NULL,
  decided_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_outbox(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL,
  phone TEXT NOT NULL, filename TEXT NOT NULL, caption TEXT DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'application/pdf', payload BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  created_at INTEGER NOT NULL, sent_at INTEGER, last_error TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pending_items(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL,
  name TEXT NOT NULL, name_key TEXT NOT NULL,
  pack TEXT DEFAULT '',
  nr REAL DEFAULT 0, mrp REAL DEFAULT 0,
  source_vendor TEXT DEFAULT '', first_date TEXT NOT NULL, last_date TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','matched','dismissed')),
  matched_item_id TEXT, resolved_by TEXT DEFAULT '', resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(hospital_id, name_key)
);
/* A matched misspelling becomes an ALIAS: every future purchase carrying it
   resolves straight to the real item — the same typo never asks twice. */
CREATE TABLE IF NOT EXISTS item_aliases(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL,
  alias_key TEXT NOT NULL, item_id TEXT NOT NULL,
  created_by TEXT DEFAULT '', created_at INTEGER NOT NULL,
  UNIQUE(hospital_id, alias_key)
);
CREATE TABLE IF NOT EXISTS margin_offers(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL,
  item_id TEXT, item_name TEXT NOT NULL, molecule TEXT DEFAULT '', pack TEXT DEFAULT '',
  vendor TEXT DEFAULT '', offered_by TEXT DEFAULT '', offered_by_phone TEXT DEFAULT '',
  negotiated_by TEXT NOT NULL, offer_date TEXT NOT NULL,
  old_nr REAL DEFAULT 0, old_mrp REAL DEFAULT 0, new_nr REAL DEFAULT 0, new_mrp REAL DEFAULT 0,
  qty_commit REAL DEFAULT 0, valid_till TEXT, next_follow_up TEXT,
  status TEXT NOT NULL DEFAULT 'proposed', notes TEXT DEFAULT '',
  applied_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_off_h ON margin_offers(hospital_id);
/* Append-only, exactly like the receivable log: a correction is a new entry. */
CREATE TABLE IF NOT EXISTS margin_offer_actions(
  id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, hospital_id TEXT NOT NULL,
  type TEXT NOT NULL, note TEXT DEFAULT '', action_date TEXT NOT NULL,
  by_name TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_offact_o ON margin_offer_actions(offer_id);
CREATE INDEX IF NOT EXISTS idx_offact_h ON margin_offer_actions(hospital_id);
CREATE TABLE IF NOT EXISTS price_log(
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL, hospital_id TEXT NOT NULL,
  old_nr REAL, old_mrp REAL, new_nr REAL, new_mrp REAL,
  note TEXT DEFAULT '', user_name TEXT DEFAULT '', ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_plog_item ON price_log(item_id);
/* One row per upload, so a drop is still auditable after the dialog is closed.
   skipped is the row-level detail (JSON [{row,name,reason}]); everything else
   is the reconciliation counters — fileRows === imported + skipped.length. */
CREATE TABLE IF NOT EXISTS import_receipts(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, kind TEXT NOT NULL,
  file_name TEXT DEFAULT '', sheet TEXT, file_rows INTEGER NOT NULL DEFAULT 0,
  parsed INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
  skipped TEXT NOT NULL DEFAULT '[]', ignored INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT '', user_name TEXT DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rcpt_h ON import_receipts(hospital_id, created_at);
CREATE TABLE IF NOT EXISTS sales_removals(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, date TEXT NOT NULL,
  items_count INTEGER NOT NULL DEFAULT 0, strips_count REAL NOT NULL DEFAULT 0,
  mrp_value REAL NOT NULL DEFAULT 0, cost_value REAL NOT NULL DEFAULT 0,
  file_name TEXT DEFAULT '', removed_by TEXT DEFAULT '', removed_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_salesrm_hd ON sales_removals(hospital_id, date);
CREATE TABLE IF NOT EXISTS opening_loads(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, stock_date TEXT NOT NULL,
  items_count INTEGER NOT NULL DEFAULT 0, value_nr REAL NOT NULL DEFAULT 0, value_mrp REAL NOT NULL DEFAULT 0,
  file_name TEXT DEFAULT '', source TEXT DEFAULT '', loaded_by TEXT DEFAULT '', loaded_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_openingloads_h ON opening_loads(hospital_id, loaded_at);
/* opening stock, batch-wise — one row per lot. Replaces the old flattened
   items.opening_qty as the SOURCE of what's on the shelf; opening_qty stays
   as a rolled-up display convenience, kept in sync from these rows. */
CREATE TABLE IF NOT EXISTS opening_batches(
  id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, item_key TEXT NOT NULL,
  name TEXT NOT NULL, pack TEXT DEFAULT '', batch TEXT DEFAULT '', exp TEXT,
  qty REAL NOT NULL DEFAULT 0, nr REAL NOT NULL DEFAULT 0, mrp REAL NOT NULL DEFAULT 0,
  stock_date TEXT NOT NULL, loaded_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_openingbatches_hk ON opening_batches(hospital_id, item_key);
`);

/* migrate: single hospital_id -> hospital_ids list + portal on/off flag */
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('hospital_ids')) {
    db.exec("ALTER TABLE users ADD COLUMN hospital_ids TEXT NOT NULL DEFAULT '[]'");
    const upd = db.prepare('UPDATE users SET hospital_ids=? WHERE id=?');
    for (const u of db.prepare('SELECT id, hospital_id FROM users').all()) {
      upd.run(JSON.stringify(u.hospital_id ? [u.hospital_id] : ['*']), u.id);
    }
  }
  if (!cols.includes('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  /* Two roles, not three (Arjun, Jul 17): admin — everything; user — the daily
     entry screen and nothing else. 'manager' had the same reach as admin bar
     user/hospital management, so it folds into admin; 'staff' becomes 'user'.

     SQLite CANNOT alter a CHECK constraint, so widening the CREATE TABLE above
     only ever helps a fresh database — an existing table keeps the old three-role
     check and rejects the UPDATE. The table has to be rebuilt. */
  if (/CHECK\(role IN \('admin','manager','staff'\)\)/.test(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get().sql || '')) {
    db.exec(`
      CREATE TABLE users_new(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('admin','user')),
        role_label TEXT NOT NULL, hospital_id TEXT, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        hospital_ids TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);
      INSERT INTO users_new(id,name,email,role,role_label,hospital_id,pw_hash,created_at,hospital_ids,active)
        SELECT id, name, email,
          CASE role WHEN 'manager' THEN 'admin' WHEN 'staff' THEN 'user' ELSE role END,
          CASE role WHEN 'manager' THEN 'Yajna Admin' WHEN 'staff' THEN 'Data entry' ELSE role_label END,
          hospital_id, pw_hash, created_at, hospital_ids, active
        FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;`);
    console.log('Migrated users to two roles (admin / user).');
  }
}

/* inventory: per-item opening quantity + the date that count was taken.
   Live stock = opening_qty + invoice qty in - sale qty out - RTV qty, for movements on/after stock_date. */
{
  const icols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
  if (!icols.includes('opening_qty')) db.exec('ALTER TABLE items ADD COLUMN opening_qty REAL NOT NULL DEFAULT 0');
  /* Molecule is what makes two brands comparable across hospitals — "Tab.
     Rifaximin 550" at one and "Rifagut 550" at another are the same purchase
     decision. Optional: an item without one still works everywhere else. */
  if (!icols.includes('molecule')) db.exec("ALTER TABLE items ADD COLUMN molecule TEXT NOT NULL DEFAULT ''");
// who we WANT to buy this from next — overrides "who we last bought it from"
if (!icols.includes('preferred_vendor')) db.exec("ALTER TABLE items ADD COLUMN preferred_vendor TEXT NOT NULL DEFAULT ''");
/* the date nr/mrp were last actually recomputed from live batches — set only
   when there was stock to weight. Lets "last known, as of X" be shown once
   stock runs out, instead of a bare unlabeled number that looks current. */
if (!icols.includes('price_as_of')) db.exec('ALTER TABLE items ADD COLUMN price_as_of TEXT');
{
  const pcols2 = db.prepare('PRAGMA table_info(pending_items)').all().map(c => c.name);
  if (pcols2.length && !pcols2.includes('pack')) db.exec("ALTER TABLE pending_items ADD COLUMN pack TEXT DEFAULT ''");
}
{
  const hcols = db.prepare('PRAGMA table_info(hospitals)').all().map(c => c.name);
  // the doctor's own WhatsApp number — reports and price approvals go THERE, not
  // to the hospital's front desk
  if (!hcols.includes('doctor_phone')) db.exec("ALTER TABLE hospitals ADD COLUMN doctor_phone TEXT DEFAULT ''");
  const pcols = db.prepare('PRAGMA table_info(price_log)').all().map(c => c.name);
  if (!pcols.includes('source')) db.exec("ALTER TABLE price_log ADD COLUMN source TEXT DEFAULT 'manual'");
  if (!pcols.includes('offer_id')) db.exec('ALTER TABLE price_log ADD COLUMN offer_id TEXT');
  if (!pcols.includes('approved_by')) db.exec("ALTER TABLE price_log ADD COLUMN approved_by TEXT DEFAULT ''");
  const ocols = db.prepare('PRAGMA table_info(margin_offers)').all().map(c => c.name);
  // the token is stored HASHED — the database never holds anything that opens the
  // approval page by itself
  if (!ocols.includes('approval_hash')) db.exec('ALTER TABLE margin_offers ADD COLUMN approval_hash TEXT');
  if (!ocols.includes('approval_sent_at')) db.exec('ALTER TABLE margin_offers ADD COLUMN approval_sent_at INTEGER');
  if (!ocols.includes('approval_expires')) db.exec('ALTER TABLE margin_offers ADD COLUMN approval_expires INTEGER');
  if (!ocols.includes('approved_by')) db.exec("ALTER TABLE margin_offers ADD COLUMN approved_by TEXT DEFAULT ''");
  if (!ocols.includes('approved_at')) db.exec('ALTER TABLE margin_offers ADD COLUMN approved_at INTEGER');
  if (!ocols.includes('kind')) db.exec("ALTER TABLE margin_offers ADD COLUMN kind TEXT DEFAULT 'offer'");
}
  const hcols = db.prepare('PRAGMA table_info(hospitals)').all().map(c => c.name);
  if (!hcols.includes('stock_date')) db.exec('ALTER TABLE hospitals ADD COLUMN stock_date TEXT');
  // pharmacies dispense by expiry, not receipt order — FEFO is the shipped default
  if (!hcols.includes('issue_method')) db.exec("ALTER TABLE hospitals ADD COLUMN issue_method TEXT NOT NULL DEFAULT 'fefo'");
}

/* ---------- helpers ---------- */
const todayISO = () => {
  const d = new Date();
  // IST — pharmacy operating timezone
  const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
  return ist.getFullYear() + '-' + String(ist.getMonth() + 1).padStart(2, '0') + '-' + String(ist.getDate()).padStart(2, '0');
};
const uid = (p) => p + '-' + crypto.randomBytes(6).toString('hex');
const msToISO = (ms) => { const d = new Date(ms); const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000); return ist.toISOString().slice(0, 10); };
const addDaysISO = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const N = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const fmtRs = (n) => 'Rs. ' + Math.round(Math.abs(n)).toLocaleString('en-IN');
const S = (v, l = 300) => String(v == null ? '' : v).slice(0, l);
const prim = (v, l = 300) => (typeof v === 'number' && isFinite(v)) ? v : S(v, l);

const nameKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// YYYY-MM, and the month must be a real month — /^\d{4}-\d{2}$/ alone accepts 2027-13
const validExpiry = (v) => { const x = S(v, 7); return /^\d{4}-(0[1-9]|1[0-2])$/.test(x) ? x : ''; };
const marginPct = (nr, mrp) => (N(mrp) > 0 ? (N(mrp) - N(nr)) / N(mrp) * 100 : 0);

/* Purchase-line maths. Vendor discount and GST are ALWAYS percentages.
   Free (offer) stock is not paid for but does enter stock, so it dilutes cost
   across Total Qty — Net Rate, not Rate, is the real cost basis to negotiate on.
     Total Qty  = Purchase Qty + Offer Qty
     Disc Rate  = Rate x (1 - Disc%/100)
     Rate+Tax   = Disc Rate x (1 + GST%/100)
     Purchase Amount = Purchase Qty x Rate+Tax      (you only pay for billed qty)
     Net Rate   = Purchase Amount / Total Qty
     Margin %   = (MRP - Net Rate) / MRP x 100
     Margin Rs  = (MRP - Net Rate) x Total Qty                                   */
function calcLine(l) {
  const pqty = Math.max(0, N(l.pqty));
  const oqty = Math.max(0, N(l.oqty));
  const rate = Math.max(0, N(l.rate));
  const disc = Math.min(100, Math.max(0, N(l.disc)));
  const gst = Math.max(0, N(l.gst));
  const mrp = Math.max(0, N(l.mrp));
  const tqty = pqty + oqty;
  const drate = rate * (1 - disc / 100);
  const prit = drate * (1 + gst / 100);
  const pamt = pqty * prit;
  const nr = tqty > 0 ? pamt / tqty : 0;                 // guard divide-by-zero
  return {
    pqty, oqty, rate, disc, gst, mrp, tqty, drate, prit, pamt, nr,
    marginPct: marginPct(nr, mrp),                        // guards mrp === 0
    marginRs: mrp > 0 ? (mrp - nr) * tqty : 0
  };
}

function cleanEntry(x) {
  if (!x || typeof x !== 'object') throw new Error('Invalid entry payload');
  const arr = (v, cap) => (Array.isArray(v) ? v.slice(0, cap) : []);
  const sales = x.sales || {}, audit = x.audit || {}, cash = x.cash || {};
  return {
    // invId links a purchase-summary row to the invoice it was derived from
    purchases: arr(x.purchases, 100).map(p => ({ vendor: S(p.vendor, 120), items: prim(p.items), value: prim(p.value), invId: S(p.invId, 40) })),
    rtv: arr(x.rtv, 100).map(r => ({ drug: S(r.drug, 120), vendor: S(r.vendor, 120), qty: prim(r.qty), value: prim(r.value), reason: S(r.reason, 40), status: S(r.status, 40) })),
    // fileName is provenance only ("N rows loaded from X") — never itself trusted for numbers
    sales: { mrp: prim(sales.mrp), cogs: prim(sales.cogs), cash: prim(sales.cash), credit: prim(sales.credit), cancels: prim(sales.cancels), fileName: S(sales.fileName, 200) },
    /* Cash drawer. cash_sales is NOT stored here — it IS sales.cash. A second
       field beside a derivable one guarantees two conflicting numbers. */
    cash: {
      opening: prim(cash.opening), receipts: prim(cash.receipts), payments: prim(cash.payments),
      actual: prim(cash.actual), reason: S(cash.reason, 300)
    },
    audit: {
      opening: prim(audit.opening), actual: prim(audit.actual), unbilled: !!audit.unbilled,
      /* est_value_lost is derived (qty × mrp), never stored. Legacy rows
         (drug/qty/doctor/action) map in without inventing a reason. */
      bounces: arr(audit.bounces, 200).map(b => ({
        brand: S(b.brand !== undefined ? b.brand : b.drug, 150),
        molecule: S(b.molecule, 150),
        qty: prim(b.qty),
        mrp: prim(b.mrp),
        reason: BOUNCE_REASONS.some(r => r.v === b.reason) ? b.reason : 'out_of_stock',
        prescriber: S(b.prescriber !== undefined ? b.prescriber : b.doctor, 120),
        department: S(b.department, 120),
        action: BOUNCE_ACTIONS.some(a => a.v === b.action) ? b.action : 'lost_sale',
        remarks: S(b.remarks, 300)
      }))
    },
    hv: arr(x.hv, 60).map(h => ({ drug: S(h.drug, 120), opening: prim(h.opening), received: prim(h.received), dispensed: prim(h.dispensed), closing: prim(h.closing) })),
    /* nr/mrp/pack ride along when the sales template supplied them — that is what
       lets the day's margin be checked per item rather than only in total.
       batch rides along too, so a sale can consume that exact lot instead of
       guessing via FEFO — optional, blank falls back to the usual issue order. */
    itemSales: arr(x.itemSales, 1000).map(r => ({ item: S(r.item, 150), qty: prim(r.qty), amount: prim(r.amount),
      pack: S(r.pack, 30), nr: prim(r.nr), mrp: prim(r.mrp), cost: prim(r.cost), batch: S(r.batch, 40).trim() })),
    invoices: arr(x.invoices, 20).map(inv => ({
      id: S(inv.id, 40), vendor: S(inv.vendor, 120), invoiceNo: S(inv.invoiceNo, 60), date: S(inv.date, 12), fileName: S(inv.fileName, 200),
      /* Derived values are recomputed here, never trusted from the client.
         Legacy lines (qty/nr/mrp only) map in as pqty=qty, rate=nr, disc=gst=0,
         which reproduces their old numbers exactly. */
      lines: arr(inv.lines, 200).map(l => {
        const legacy = l.pqty === undefined && l.rate === undefined;
        const d = calcLine(legacy
          ? { pqty: l.qty, oqty: 0, rate: l.nr, disc: 0, gst: 0, mrp: l.mrp }
          : l);
        return {
          item: S(l.item, 150),
          // the pack rides on the line so an item BORN from a purchase carries a
          // strip size into the master — without it, packUnits is null forever
          pack: S(l.pack, 30).trim(),
          // batch identity: valuation is per batch, because the same brand arrives
          // repeatedly at different net rates and carries a different printed MRP
          // each time. expiry is per batch by law.
          batch: S(l.batch, 40).trim(), exp: validExpiry(l.exp),
          pqty: d.pqty, oqty: d.oqty, rate: d.rate, disc: d.disc, gst: d.gst, mrp: d.mrp,
          qty: d.tqty,          // Total Qty — what actually enters stock (incl. free goods)
          nr: d.nr,             // Net Rate — the cost basis used by the margin tally
          value: d.pamt         // Purchase Amount — what feeds the purchase total
        };
      })
    }))
  };
}

/* The drawer chain. Mirrored in index.html — this copy is the source of truth.
   cash_sales is sales.cash. Cash handed to the doctor is a cash payment out like
   any other: the drawer is the only place the day's cash is reconciled. */
function calcCash(e) {
  const c = e.cash || {};
  const opening = N(c.opening), receipts = N(c.receipts), payments = N(c.payments);
  const cashSales = N(e.sales.cash);
  const expected = opening + cashSales + receipts - payments;
  const hasActual = c.actual !== '' && c.actual != null;
  const actual = N(c.actual);
  const variance = hasActual ? actual - expected : 0;
  return { opening, cashSales, receipts, payments, expected, hasActual, actual, variance,
    breach: hasActual && Math.abs(variance) > CASH_VAR_THRESHOLD, reason: S(c.reason, 300) };
}

function entryAlerts(e) {
  const alerts = [];
  const purchTotal = e.purchases.reduce((a, p) => a + N(p.value), 0);
  const hasActual = e.audit.actual !== '' && e.audit.actual != null;
  if (hasActual) {
    const variance = N(e.audit.actual) - (N(e.audit.opening) + purchTotal - N(e.sales.cogs));
    if (Math.round(variance) !== 0) alerts.push({ type: 'variance', msg: `Stock variance of ${fmtRs(variance)} on day close` });
  }
  if (e.audit.unbilled) alerts.push({ type: 'unbilled', msg: 'Unbilled dispensing flagged during audit' });
  const mm = e.hv.filter(r => r.drug && (N(r.opening) + N(r.received) - N(r.dispensed)) !== N(r.closing)).length;
  if (mm > 0) alerts.push({ type: 'hv', msg: `${mm} high-value drug mismatch${mm > 1 ? 'es' : ''} in register` });
  const cc = calcCash(e);
  if (cc.breach) alerts.push({
    type: 'cashdrawer',
    msg: `Cash drawer ${cc.variance < 0 ? 'short' : 'over'} by ${fmtRs(Math.abs(cc.variance))} — counted ${fmtRs(cc.actual)} against an expected ${fmtRs(cc.expected)}${cc.reason ? ` (${cc.reason})` : ''}`
  });
  return alerts;
}

function userHospitals(u) {
  try { const v = JSON.parse(u.hospital_ids || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
/* null => every hospital; otherwise the explicit list of ids this user may open */
function allowedHids(u) {
  const list = userHospitals(u);
  return list.includes('*') ? null : list;
}
const rowUser = (u) => u && ({
  uid: u.id, name: u.name, email: u.email, role: u.role, roleLabel: u.role_label,
  hospitals: userHospitals(u), allHospitals: userHospitals(u).includes('*'), active: !!u.active
});
/* admin — full access. user — the daily entry screen only. */
const ROLES = ['admin', 'user'];
const ROLE_LABEL = { admin: 'Yajna Admin', user: 'Data entry' };
const ISSUE_METHODS = ['fefo', 'fifo'];
const rowHosp = (h) => ({ id: h.id, name: h.name, doctor: h.doctor, location: h.location, phone: h.phone, doctorPhone: h.doctor_phone || '', startDate: h.start_date, stockDate: h.stock_date || null, issueMethod: h.issue_method || 'fefo', active: !!h.active, base: h.base });
const rowVendor = (v) => ({ id: v.id, name: v.name, creditDays: v.credit_days, openingBal: v.opening_bal, phone: v.phone, addedOn: v.added_on });
const rowPay = (p) => ({ id: p.id, vendorId: p.vendor_id, vendorName: p.vendor_name, amount: p.amount, date: p.date, note: p.note });
const rowNotif = (n) => ({ id: n.id, type: n.type, hid: n.hospital_id, date: n.date, msg: n.msg, ts: n.ts, read: !!n.read });
const rowItem = (i) => ({ molecule: i.molecule || '', preferredVendor: i.preferred_vendor || '', id: i.id, name: i.name, key: i.name_key, pack: i.pack, nr: i.nr, mrp: i.mrp, openingQty: i.opening_qty || 0, source: i.source, updatedAt: i.updated_at, priceAsOf: i.price_as_of || null });
const rowAdj = (a) => ({ id: a.id, key: a.item_key, item: a.item_name, date: a.date, qty: a.qty, reason: a.reason, note: a.note, user: a.user_name, ts: a.created_at });
/* one row per opening-stock batch/lot — the ledger's source of truth for
   opening lots, replacing the old single flattened opening_qty per item */
const rowOpeningBatch = (b) => ({ id: b.id, key: b.item_key, name: b.name, pack: b.pack, batch: b.batch || '', exp: b.exp || null, qty: b.qty, nr: b.nr, mrp: b.mrp, stockDate: b.stock_date, loadedAt: b.loaded_at });

/* why stock was corrected — required, because an unexplained adjustment is the
   easiest place for leakage to hide */
const ADJ_REASONS = ['Physical count correction', 'Expiry write-off', 'Damage / breakage', 'Theft / loss', 'Free sample issued', 'Return from ward', 'Data correction', 'Other'];

/* ---------- bounce register ----------
   A bounce is a LOST SALE from unavailability — never an RTV (stock returned to
   a vendor). Separate registers, separate models, separate screens.
   reason splits the two failures the report must never merge into one number:
     not_stocked / not_in_formulary → a formulary DECISION
     out_of_stock on a stocked brand → an OPERATIONS failure (reorder level) */
const BOUNCE_REASONS = [
  { v: 'out_of_stock', l: 'Stocked but out of stock', kind: 'ops' },
  { v: 'not_stocked', l: 'Not stocked at all', kind: 'formulary' },
  { v: 'not_in_formulary', l: 'Not in formulary', kind: 'formulary' },
  { v: 'expired_pulled', l: 'Expired / pulled from shelf', kind: 'ops' },
  { v: 'other', l: 'Other', kind: 'other' }
];
const BOUNCE_ACTIONS = [
  { v: 'lost_sale', l: 'Lost sale' }, { v: 'substituted', l: 'Substituted' },
  { v: 'outside_purchase', l: 'Bought outside' }, { v: 'customer_waiting', l: 'Customer waiting' }
];
const bounceKind = (r) => (BOUNCE_REASONS.find(x => x.v === r) || { kind: 'other' }).kind;

/* Cash drawer variance needing a written reason. */
const CASH_VAR_THRESHOLD = parseFloat(process.env.CASH_VAR_THRESHOLD || '100');

/* ---------- receivables model ----------
   Each party type carries its own expected credit period; status is measured
   against THAT party's period, so a 40-day insurance claim is normal while a
   40-day patient due is critical. */
const PARTY_TYPES = [
  { v: 'Insurance / TPA', days: 45 },
  { v: 'Government scheme', days: 60 },
  { v: 'Corporate', days: 30 },
  { v: 'Ward / department', days: 15 },
  { v: 'Patient', days: 7 }
];
const partyDays = (t) => (PARTY_TYPES.find(p => p.v === t) || { days: 30 }).days;
const RECEIPT_MODES = ['Cash', 'UPI', 'Cheque', 'NEFT'];
/* Overrides explain WHY a bill is old — they can never make it look current.
   None of these are derived values, so an override can't reset the clock. */
const OVERRIDE_VALUES = ['disputed', 'payment_promised', 'legal', 'write_off_pending', 'claim_resubmitted'];
const OVERRIDE_DEFAULT_DAYS = 15, OVERRIDE_MAX_DAYS = 45;
const ADJ_THRESHOLD = parseFloat(process.env.RECV_ADJ_THRESHOLD || '5000');

const daysBetween = (from, to) => Math.floor((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 864e5);
function derivedStatus(daysOut, partyType) {
  const p = partyDays(partyType);
  if (daysOut > 2 * p) return 'critical';
  if (daysOut > p) return 'overdue';
  if (daysOut >= p * 0.8) return 'due_soon';
  return 'current';
}
const overrideActive = (r, today) => !!(r.ov_value && r.ov_expires && r.ov_expires >= today);

/* amount_due is derived, never stored: bill − receipts + signed adjustments */
function recvTotals(r, actions) {
  let received = 0, adj = 0;
  for (const a of actions) {
    if (a.type === 'receipt') received += N(a.amount);
    else if (a.type === 'adjustment') adj += N(a.amount);
  }
  return { received, adj, due: N(r.amount) - received + adj };
}
function rowRecv(r, actions, today) {
  const t = recvTotals(r, actions);
  const daysOut = daysBetween(r.bill_date, today);
  const derived = derivedStatus(daysOut, r.party_type);
  const ovOn = overrideActive(r, today);
  return {
    id: r.id, billNo: r.bill_no, billDate: r.bill_date, party: r.party, partyType: r.party_type,
    amount: N(r.amount), received: t.received, adjustments: t.adj, due: t.due,
    daysOutstanding: daysOut, creditDays: partyDays(r.party_type),
    status: derived,
    override: ovOn ? { value: r.ov_value, reason: r.ov_reason, setBy: r.ov_by, setAt: r.ov_at, setOn: msToISO(r.ov_at), expiresAt: r.ov_expires } : null,
    effectiveStatus: ovOn ? r.ov_value : derived,
    nextFollowUp: r.next_follow_up_date || null, assignedTo: r.assigned_to || null,
    priority: r.priority || 'normal', createdBy: r.created_by, createdAt: r.created_at
  };
}
const rowAction = (a) => ({
  id: a.id, receivableId: a.receivable_id, type: a.type, amount: a.amount, mode: a.mode || null,
  reason: a.reason || '', approver: a.approver_name || null, date: a.action_date,
  by: a.entered_by, ts: a.entered_at
});

/* ---------- seed (first run only) ---------- */
function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const t = todayISO(), now = Date.now();
  const insH = db.prepare('INSERT INTO hospitals(id,name,doctor,location,phone,start_date,active,base) VALUES(?,?,?,?,?,?,1,?)');
  insH.run('viraj', 'Viraj Gastro', 'Dr. Guna Ranjan', 'Juvvalapalem Rd, Bhimavaram', '+91 98480 11223', t, 42000);
  insH.run('siri', 'Siri Emergency Hospital', 'Dr. Siddartha Kannaji', 'PP Road, Bhimavaram', '+91 98661 44556', t, 58000);
  insH.run('mithra', 'Mithra Medicare', 'Dr. Vikranth Chunduri', 'Gunupudi, Bhimavaram', '+91 99590 77889', t, 71000);
  /* Seed passwords come from the environment, never from this file — a password
     committed to source is a published password. Anything not supplied is
     generated at random and printed ONCE, here, at seed time; there is no
     default to guess and nothing to leak by reading the repository. */
  const generated = [];
  const seedPw = (envKey) => {
    if (process.env[envKey]) return process.env[envKey];
    const pw = 'Yajna-' + crypto.randomBytes(9).toString('base64url');
    generated.push(`${envKey}=${pw}`);
    return pw;
  };
  const insU = db.prepare('INSERT INTO users(id,name,email,role,role_label,hospital_id,hospital_ids,active,pw_hash,created_at) VALUES(?,?,?,?,?,NULL,?,1,?,?)');
  insU.run('u-admin', 'Bhagavan', 'bhagavan@yajnapharma.in', 'admin', 'Yajna Admin', '["*"]', bcrypt.hashSync(seedPw('SEED_ADMIN_PW'), 10), now);
  insU.run('u-manager', 'Ravi Teja', 'manager@yajnapharma.in', 'admin', 'Yajna Admin', '["*"]', bcrypt.hashSync(seedPw('SEED_MANAGER_PW'), 10), now);
  insU.run('u-staff-mithra', 'Lakshmi D', 'staff.mithra@yajnapharma.in', 'user', 'Data entry', '["mithra"]', bcrypt.hashSync(seedPw('SEED_USER_PW'), 10), now);
  console.log('Seeded 3 hospitals + 3 users (clean database).');
  if (generated.length) {
    console.log('\n  First-run logins — WRITE THESE DOWN, they are not stored anywhere in readable form:');
    generated.forEach(l => console.log('    ' + l));
    console.log('  Change them from Settings once you are in.\n');
  }
}
seed();

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
// rawBody: the webhook signature is HMAC over the exact bytes received —
// verifying a re-serialisation would break on any formatting difference
// 3mb: the report-to-PDF path carries the rendered report markup (a monthly can pass 400kb)
app.use(express.json({ limit: '3mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

/* login rate limit: 10 attempts / 15 min per IP */
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || [];
  const recent = a.filter(ts => now - ts < 15 * 60 * 1000);
  attempts.set(ip, recent);
  return recent.length >= 10;
}

function setSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(token, userId, now, now + SESSION_DAYS * 864e5);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 864e5,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https'
  });
}

function auth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s || s.expires_at < Date.now()) return res.status(401).json({ error: 'Session expired — sign in again' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
  if (!u) return res.status(401).json({ error: 'Account not found' });
  if (!u.active) { db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); return res.status(401).json({ error: 'Your portal access has been turned off — contact the Yajna admin' }); }
  req.user = u;
  next();
}
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not permitted for your role' });

function scopeCheck(req, hid) {
  const allowed = allowedHids(req.user);
  if (allowed && !allowed.includes(hid)) {
    const e = new Error('You do not have access to this hospital'); e.status = 403; throw e;
  }
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(hid);
  if (!h) { const e = new Error('Unknown hospital'); e.status = 404; throw e; }
  return h;
}

/* ---------- auth routes ---------- */
app.post('/api/login', (req, res) => {
  const ip = req.ip || '?';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(S(email, 200).trim().toLowerCase());
  if (!u || !bcrypt.compareSync(S(password, 200), u.pw_hash)) {
    attempts.get(ip).push(Date.now());
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  if (!u.active) return res.status(403).json({ error: 'Your portal access has been turned off — contact the Yajna admin' });
  setSession(res, req, u.id);
  res.json({ user: rowUser(u) });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.post('/api/password', auth, (req, res) => {
  const { current, next } = req.body || {};
  if (!bcrypt.compareSync(S(current, 200), req.user.pw_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (S(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(bcrypt.hashSync(S(next, 200), 10), req.user.id);
  res.json({ ok: true });
});

/* ---------- bootstrap ---------- */
app.get('/api/bootstrap', auth, (req, res) => {
  const allowed = allowedHids(req.user);
  const hs = allowed
    ? (allowed.length ? db.prepare(`SELECT * FROM hospitals WHERE id IN (${allowed.map(() => '?').join(',')})`).all(...allowed) : [])
    : db.prepare('SELECT * FROM hospitals').all();
  const hids = hs.map(h => h.id);
  const out = { user: rowUser(req.user), hospitals: {}, vendors: {}, payments: {}, dailyData: {}, hvTracked: {}, reportPrefs: {}, notifications: [], items: {}, openingBatches: {}, adjustments: {}, pendingItems: {}, aliases: {}, offers: {}, offerActions: {}, receivables: {}, recvActions: {}, snapshots: {}, periodData: {}, offerStates: OFFER_STATES, offerActionTypes: OFFER_ACTIONS, adjReasons: ADJ_REASONS, issueMethods: ISSUE_METHODS, bounceReasons: BOUNCE_REASONS, bounceActions: BOUNCE_ACTIONS, cashVarThreshold: CASH_VAR_THRESHOLD, partyTypes: PARTY_TYPES, receiptModes: RECEIPT_MODES, overrideValues: OVERRIDE_VALUES, adjThreshold: ADJ_THRESHOLD, overrideMaxDays: OVERRIDE_MAX_DAYS, overrideDefaultDays: OVERRIDE_DEFAULT_DAYS, aiEnabled: !!process.env.ANTHROPIC_API_KEY, waEnabled: waEnabled() };
  for (const h of hs) {
    out.hospitals[h.id] = rowHosp(h);
    out.vendors[h.id] = db.prepare('SELECT * FROM vendors WHERE hospital_id=? ORDER BY name').all(h.id).map(rowVendor);
    out.payments[h.id] = db.prepare('SELECT * FROM payments WHERE hospital_id=? ORDER BY date DESC, created_at DESC').all(h.id).map(rowPay);
    out.dailyData[h.id] = {};
    for (const r of db.prepare("SELECT date,data,saved_at FROM entries WHERE hospital_id=? AND date >= date('now','-400 days')").all(h.id)) {
      const e = JSON.parse(r.data); e.savedAt = r.saved_at;
      out.dailyData[h.id][r.date] = e;
    }
    const hv = db.prepare('SELECT drugs FROM hv_tracked WHERE hospital_id=?').get(h.id);
    out.hvTracked[h.id] = hv ? JSON.parse(hv.drugs) : [];
    out.items[h.id] = db.prepare('SELECT * FROM items WHERE hospital_id=? ORDER BY name').all(h.id).map(rowItem);
    out.openingBatches[h.id] = db.prepare('SELECT * FROM opening_batches WHERE hospital_id=? ORDER BY name').all(h.id).map(rowOpeningBatch);
    out.adjustments[h.id] = db.prepare('SELECT * FROM stock_adjustments WHERE hospital_id=? ORDER BY date DESC, created_at DESC').all(h.id).map(rowAdj);
    out.pendingItems[h.id] = db.prepare("SELECT * FROM pending_items WHERE hospital_id=? ORDER BY status='pending' DESC, last_date DESC").all(h.id).map(rowPending);
    out.aliases[h.id] = db.prepare('SELECT * FROM item_aliases WHERE hospital_id=?').all(h.id).map(rowAlias);
    out.offers[h.id] = db.prepare('SELECT * FROM margin_offers WHERE hospital_id=? ORDER BY offer_date DESC, created_at DESC').all(h.id).map(o => rowOffer(o, todayISO()));
    out.offerActions[h.id] = db.prepare('SELECT * FROM margin_offer_actions WHERE hospital_id=? ORDER BY action_date, at').all(h.id).map(rowOfferAction);
    {
      const acts = db.prepare('SELECT * FROM receivable_actions WHERE hospital_id=? ORDER BY action_date, entered_at').all(h.id);
      const byR = {};
      for (const a of acts) (byR[a.receivable_id] = byR[a.receivable_id] || []).push(a);
      out.receivables[h.id] = db.prepare('SELECT * FROM receivables WHERE hospital_id=?').all(h.id)
        .map(r => rowRecv(r, byR[r.id] || [], todayISO()));
      out.recvActions[h.id] = acts.map(rowAction);
      out.snapshots[h.id] = db.prepare('SELECT * FROM expiry_snapshots WHERE hospital_id=? ORDER BY as_of DESC').all(h.id).map(rowSnap);
    }
    out.periodData[h.id] = { weekly: {}, monthly: {} };
    for (const r of db.prepare('SELECT ptype,pkey,data FROM period_data WHERE hospital_id=?').all(h.id)) {
      if (out.periodData[h.id][r.ptype]) out.periodData[h.id][r.ptype][r.pkey] = JSON.parse(r.data);
    }
    out.reportPrefs[h.id] = {};
    for (const r of db.prepare('SELECT type,prefs FROM report_prefs WHERE hospital_id=?').all(h.id)) {
      out.reportPrefs[h.id][r.type] = JSON.parse(r.prefs);
    }
  }
  out.notifications = (allowed
    ? (allowed.length ? db.prepare(`SELECT * FROM notifications WHERE hospital_id IN (${allowed.map(() => '?').join(',')}) ORDER BY ts DESC LIMIT 200`).all(...allowed) : [])
    : db.prepare('SELECT * FROM notifications ORDER BY ts DESC LIMIT 200').all()
  ).map(rowNotif);
  if (req.user.role === 'admin') {
    out.userList = db.prepare('SELECT * FROM users ORDER BY created_at').all().map(rowUser);
  }
  res.json(out);
});

/* ---------- daily entries ---------- */
app.put('/api/entries/:hid/:date', auth, (req, res) => {
  const { hid, date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });
  scopeCheck(req, hid);
  const today = todayISO();
  if (date > today) return res.status(400).json({ error: 'Cannot enter data for a future date' });
  const existing = db.prepare('SELECT saved_at FROM entries WHERE hospital_id=? AND date=?').get(hid, date);
  if (req.user.role !== 'admin' && existing && date !== today) {
    return res.status(403).json({ error: 'Saved entries for past dates are locked — ask the admin to edit' });
  }
  const entry = cleanEntry((req.body || {}).entry);
  // a drawer variance past the threshold is not a saveable day without a reason
  const cc = calcCash(entry);
  if (cc.breach && !cc.reason)
    return res.status(400).json({ error: `Cash variance of ${fmtRs(cc.variance)} needs a reason — anything over ${fmtRs(CASH_VAR_THRESHOLD)} must be explained` });
  const savedAt = Date.now();

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO entries(hospital_id,date,data,saved_at) VALUES(?,?,?,?) ON CONFLICT(hospital_id,date) DO UPDATE SET data=excluded.data, saved_at=excluded.saved_at')
      .run(hid, date, JSON.stringify(entry), savedAt);

    // auto-register unknown vendors from purchase rows
    const known = db.prepare('SELECT name FROM vendors WHERE hospital_id=?').all(hid).map(v => v.name.toLowerCase());
    const vendorsAdded = [];
    for (const p of entry.purchases) {
      const name = (p.vendor || '').trim();
      if (name && !known.includes(name.toLowerCase())) {
        const v = { id: uid(hid + '-v'), name, credit_days: 30, opening_bal: 0, phone: '', added_on: today };
        db.prepare('INSERT INTO vendors(id,hospital_id,name,credit_days,opening_bal,phone,added_on) VALUES(?,?,?,?,?,?,?)')
          .run(v.id, hid, v.name, v.credit_days, v.opening_bal, v.phone, v.added_on);
        known.push(name.toLowerCase());
        vendorsAdded.push(rowVendor(v));
      }
    }

    // keep the tracked HV drug list in sync with this entry
    const drugs = [...new Set(entry.hv.map(r => r.drug.trim()).filter(Boolean))];
    db.prepare('INSERT INTO hv_tracked(hospital_id,drugs) VALUES(?,?) ON CONFLICT(hospital_id) DO UPDATE SET drugs=excluded.drugs')
      .run(hid, JSON.stringify(drugs));

    /* Unknown invoice items are NOT auto-added any more (Arjun, Jul 22): a typo
       or a case slip would mint a duplicate. They queue as PENDING for a manager
       to approve as new — or match to the item they actually are, which leaves
       an alias so the same spelling resolves itself forever after. */
    const itemsAdded = [];      // kept in the response shape; nothing lands here from invoices now
    const pendingTouched = [];
    const marginAlerts = [];
    const itemsPriceImproved = [];
    const findItem = db.prepare('SELECT * FROM items WHERE hospital_id=? AND name_key=?');
    const findAlias = db.prepare('SELECT i.* FROM item_aliases a JOIN items i ON i.id=a.item_id WHERE a.hospital_id=? AND a.alias_key=?');
    const ratchetPrice = db.prepare('UPDATE items SET nr=?, mrp=?, price_as_of=?, updated_at=? WHERE id=?');
    const logRatchet = db.prepare(`INSERT INTO price_log(id,item_id,hospital_id,old_nr,old_mrp,new_nr,new_mrp,note,user_name,ts,source)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const inv of entry.invoices) {
      for (const l of inv.lines) {
        const name = (l.item || '').trim();
        if (!name) continue;
        const key = nameKey(name);
        const existing = findItem.get(hid, key) || findAlias.get(hid, key);
        if (!existing) {
          const pend = db.prepare('SELECT * FROM pending_items WHERE hospital_id=? AND name_key=?').get(hid, key);
          if (pend) {
            // seen again — bump the count, keep the LATEST rates (and a pack, if
            // this line finally supplies one), and reopen a dismissed one
            db.prepare(`UPDATE pending_items SET seen_count=seen_count+1, last_date=?, nr=?, mrp=?, pack=?,
              source_vendor=?, status=CASE WHEN status='dismissed' THEN 'pending' ELSE status END WHERE id=?`)
              .run(date, N(l.nr) || pend.nr, N(l.mrp) || pend.mrp, S(l.pack, 30).trim() || pend.pack || '', inv.vendor || pend.source_vendor, pend.id);
            pendingTouched.push(pend.id);
          } else {
            const pi = { id: uid('pi'), hospital_id: hid, name, name_key: key, pack: S(l.pack, 30).trim(), nr: N(l.nr), mrp: N(l.mrp),
              source_vendor: inv.vendor || '', first_date: date, last_date: date, seen_count: 1,
              status: 'pending', created_at: savedAt };
            db.prepare(`INSERT INTO pending_items(id,hospital_id,name,name_key,pack,nr,mrp,source_vendor,first_date,last_date,seen_count,status,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,1,'pending',?)`)
              .run(pi.id, pi.hospital_id, pi.name, pi.name_key, pi.pack, pi.nr, pi.mrp, pi.source_vendor, pi.first_date, pi.last_date, pi.created_at);
            pendingTouched.push(pi.id);
          }
        } else {
          /* KNOWN item (directly or via alias). The line's pack can FILL a blank
             master pack — a blank→value fill only. A DIFFERING pack is never
             overwritten silently: it raises an alert like a margin mismatch, and
             a human decides which record is wrong. */
          const linePack = S(l.pack, 30).trim();
          if (linePack) {
            if (!String(existing.pack || '').trim()) {
              db.prepare('UPDATE items SET pack=?, updated_at=? WHERE id=?').run(linePack, savedAt, existing.id);
              existing.pack = linePack;
            } else if (nameKey(existing.pack) !== nameKey(linePack)) {
              marginAlerts.push(`"${existing.name}" pack size differs: master says ${existing.pack}, the ${inv.vendor || 'invoice'} line says ${linePack} — one of the two records is wrong`);
            }
          }
          if (N(l.nr) > 0 && N(l.mrp) > 0) {
            const lineM = marginPct(l.nr, l.mrp);
            const masterM = marginPct(existing.nr, existing.mrp);
            if (Math.abs(lineM - masterM) > MARGIN_TOL) {
              marginAlerts.push(`"${existing.name}" margin ${lineM.toFixed(1)}% vs master ${masterM.toFixed(1)}% on ${inv.vendor || 'invoice'}${inv.invoiceNo ? ' #' + inv.invoiceNo : ''}`);
            }
            /* The ratchet: a genuinely BETTER margin updates the master
               automatically (mechanical fact, not a negotiation — bypasses
               the doctor-approval gate same as every other derived write); a
               worse or equal one never touches it. Uses THIS LINE's own
               rate, never a weighted average across batches — an average
               would just let a bad batch dilute a good one and reintroduce
               the exact erosion this replaces. */
            if (lineM > masterM + MARGIN_RATCHET_EPS) {
              logRatchet.run(uid('pl'), existing.id, hid, existing.nr, existing.mrp, l.nr, l.mrp,
                `Better margin found on a purchase${inv.vendor ? ' from ' + inv.vendor : ''}${inv.invoiceNo ? ' (invoice #' + inv.invoiceNo + ')' : ''} — master updated automatically`,
                'system', savedAt, 'purchase-improved');
              ratchetPrice.run(l.nr, l.mrp, date, savedAt, existing.id);
              itemsPriceImproved.push(rowItem({ ...existing, nr: l.nr, mrp: l.mrp, updated_at: savedAt, price_as_of: date }));
              // a later line for the SAME product (another invoice, or
              // another line, same save) re-reads `existing` fresh from the
              // DB every iteration — inside the same transaction, so it sees
              // THIS write immediately and compares against the just-
              // improved price, never the stale one this line started from
            }
          }
        }
      }
    }

    // regenerate audit alerts for this day
    db.prepare("DELETE FROM notifications WHERE hospital_id=? AND date=? AND type IN ('variance','unbilled','hv','margin','cashdrawer')").run(hid, date);
    const alerts = entryAlerts(entry);
    marginAlerts.slice(0, 20).forEach(msg => alerts.push({ type: 'margin', msg }));
    const notifications = alerts.map(a => {
      const n = { id: uid('n'), type: a.type, hospital_id: hid, date, msg: a.msg, ts: savedAt, read: 0 };
      db.prepare('INSERT INTO notifications(id,type,hospital_id,date,msg,ts,read) VALUES(?,?,?,?,?,?,0)')
        .run(n.id, n.type, n.hospital_id, n.date, n.msg, n.ts);
      return rowNotif(n);
    });
    const pendingItems = pendingTouched.length
      ? db.prepare(`SELECT * FROM pending_items WHERE id IN (${pendingTouched.map(() => '?').join(',')})`).all(...pendingTouched).map(rowPending)
      : [];
    return { vendorsAdded, itemsAdded, pendingItems, notifications, hvTracked: drugs, itemsPriceImproved };
  });

  const r = tx();
  res.json({ savedAt, ...r });
});

/* Removing a day's sales must leave a trace. Margin is what a performance
   engagement is settled on — if a correction changes it, the system has to be
   able to show who removed what and when, not just assert it happened. */
const rowSalesRemoval = (r) => ({ id: r.id, hid: r.hospital_id, date: r.date, itemsCount: r.items_count,
  stripsCount: r.strips_count, mrpValue: r.mrp_value, costValue: r.cost_value, fileName: r.file_name,
  removedBy: r.removed_by, removedAt: r.removed_at });

app.post('/api/entries/:hid/:date/remove-sales', auth, (req, res) => {
  const { hid, date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });
  scopeCheck(req, hid);
  const row = db.prepare('SELECT data FROM entries WHERE hospital_id=? AND date=?').get(hid, date);
  if (!row) return res.status(404).json({ error: 'No entry for this day' });
  if (req.user.role !== 'admin' && date !== todayISO()) {
    return res.status(403).json({ error: 'Saved entries for past dates are locked — ask the admin to edit' });
  }
  const entry = JSON.parse(row.data);
  const itemsCount = (entry.itemSales || []).length;
  const stripsCount = (entry.itemSales || []).reduce((a, r) => a + N(r.qty), 0);
  const costValue = (entry.itemSales || []).reduce((a, r) => a + N(r.cost), 0);
  const mrpValue = N(entry.sales.mrp);
  if (!itemsCount && !mrpValue && !N(entry.sales.cogs)) {
    return res.status(400).json({ error: "This day has no sales loaded — there's nothing to remove" });
  }
  const fileName = entry.sales.fileName || '';
  entry.itemSales = [];
  entry.sales.mrp = 0; entry.sales.cogs = 0; entry.sales.fileName = '';
  const savedAt = Date.now();
  const removal = {
    id: uid('salrm'), hospital_id: hid, date, items_count: itemsCount, strips_count: stripsCount,
    mrp_value: mrpValue, cost_value: costValue, file_name: fileName, removed_by: req.user.name, removed_at: savedAt
  };
  const tx = db.transaction(() => {
    db.prepare('UPDATE entries SET data=?, saved_at=? WHERE hospital_id=? AND date=?').run(JSON.stringify(entry), savedAt, hid, date);
    db.prepare(`INSERT INTO sales_removals(id,hospital_id,date,items_count,strips_count,mrp_value,cost_value,file_name,removed_by,removed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(removal.id, removal.hospital_id, removal.date, removal.items_count, removal.strips_count,
      removal.mrp_value, removal.cost_value, removal.file_name, removal.removed_by, removal.removed_at);
    // the day's own alerts (variance/HV/cashdrawer) can change once sales are gone
    db.prepare("DELETE FROM notifications WHERE hospital_id=? AND date=? AND type IN ('variance','unbilled','hv','cashdrawer')").run(hid, date);
    const alerts = entryAlerts(entry);
    const notifications = alerts.map(a => {
      const n = { id: uid('n'), type: a.type, hospital_id: hid, date, msg: a.msg, ts: savedAt, read: 0 };
      db.prepare('INSERT INTO notifications(id,type,hospital_id,date,msg,ts,read) VALUES(?,?,?,?,?,?,0)').run(n.id, n.type, n.hospital_id, n.date, n.msg, n.ts);
      return rowNotif(n);
    });
    return notifications;
  });
  const notifications = tx();
  console.log(`[sales-removal] ${req.user.name} removed ${itemsCount} sales row(s) for ${hid} on ${date} (was: ${fileName || 'no file on record'})`);
  res.json({ savedAt, removal: rowSalesRemoval(removal), notifications });
});

app.get('/api/sales-removals', auth, (req, res) => {
  const hid = S(req.query.hid, 60);
  scopeCheck(req, hid);
  const rows = db.prepare('SELECT * FROM sales_removals WHERE hospital_id=? ORDER BY removed_at DESC LIMIT 50').all(hid).map(rowSalesRemoval);
  res.json({ removals: rows });
});

/* ---------- payments ---------- */
app.post('/api/payments', auth, requireRole('admin'), (req, res) => {
  const { hid, vendorId, amount, date, note } = req.body || {};
  scopeCheck(req, S(hid, 60));
  const v = db.prepare('SELECT * FROM vendors WHERE id=? AND hospital_id=?').get(S(vendorId, 80), hid);
  if (!v) return res.status(404).json({ error: 'Vendor not found for this hospital' });
  const amt = N(amount);
  if (amt <= 0) return res.status(400).json({ error: 'Payment amount must be positive' });
  const d = /^\d{4}-\d{2}-\d{2}$/.test(S(date)) ? date : todayISO();
  const p = { id: uid('p'), hospital_id: hid, vendor_id: v.id, vendor_name: v.name, amount: amt, date: d, note: S(note, 200), created_at: Date.now() };
  db.prepare('INSERT INTO payments(id,hospital_id,vendor_id,vendor_name,amount,date,note,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(p.id, p.hospital_id, p.vendor_id, p.vendor_name, p.amount, p.date, p.note, p.created_at);
  res.json({ payment: rowPay(p) });
});

/* ---------- vendors bulk import ---------- */
app.post('/api/vendors/bulk', auth, requireRole('admin'), (req, res) => {
  const { hid, vendors } = req.body || {};
  scopeCheck(req, S(hid, 60));
  if (!Array.isArray(vendors)) return res.status(400).json({ error: 'vendors must be an array' });
  const today = todayISO();
  const known = db.prepare('SELECT name FROM vendors WHERE hospital_id=?').all(hid).map(v => v.name.toLowerCase());
  const created = [];
  const tx = db.transaction(() => {
    for (const raw of vendors.slice(0, 500)) {
      const name = S(raw.name, 120).trim();
      if (!name || known.includes(name.toLowerCase())) continue;
      const v = { id: uid(hid + '-v'), name, credit_days: Math.max(0, Math.round(N(raw.credit)) || 30), opening_bal: N(raw.bal), phone: S(raw.phone, 40), added_on: today };
      db.prepare('INSERT INTO vendors(id,hospital_id,name,credit_days,opening_bal,phone,added_on) VALUES(?,?,?,?,?,?,?)')
        .run(v.id, hid, v.name, v.credit_days, v.opening_bal, v.phone, v.added_on);
      known.push(name.toLowerCase());
      created.push(rowVendor(v));
    }
  });
  tx();
  res.json({ created });
});

/* ---------- hospitals (admin) ---------- */
app.post('/api/hospitals', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const name = S(b.name, 150).trim();
  if (!name) return res.status(400).json({ error: 'Hospital name is required' });
  const h = {
    id: uid('h'), name, doctor: S(b.doctor, 150), location: S(b.location, 200), phone: S(b.phone, 40),
    doctor_phone: S(b.doctorPhone, 40),
    start_date: /^\d{4}-\d{2}-\d{2}$/.test(S(b.startDate)) ? b.startDate : todayISO(), active: 1, base: 50000
  };
  db.prepare('INSERT INTO hospitals(id,name,doctor,location,phone,doctor_phone,start_date,active,base) VALUES(?,?,?,?,?,?,?,1,?)')
    .run(h.id, h.name, h.doctor, h.location, h.phone, h.doctor_phone, h.start_date, h.base);
  res.json({ hospital: rowHosp(h) });
});

app.patch('/api/hospitals/:id', auth, requireRole('admin'), (req, res) => {
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Unknown hospital' });
  const b = req.body || {};
  const upd = {
    name: b.name !== undefined ? S(b.name, 150).trim() || h.name : h.name,
    doctor: b.doctor !== undefined ? S(b.doctor, 150) : h.doctor,
    location: b.location !== undefined ? S(b.location, 200) : h.location,
    phone: b.phone !== undefined ? S(b.phone, 40) : h.phone,
    doctor_phone: b.doctorPhone !== undefined ? S(b.doctorPhone, 40) : (h.doctor_phone || ''),
    start_date: (b.startDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(S(b.startDate))) ? b.startDate : h.start_date,
    issue_method: (b.issueMethod !== undefined && ISSUE_METHODS.includes(b.issueMethod)) ? b.issueMethod : (h.issue_method || 'fefo'),
    active: b.active !== undefined ? (b.active ? 1 : 0) : h.active
  };
  db.prepare('UPDATE hospitals SET name=?,doctor=?,location=?,phone=?,doctor_phone=?,start_date=?,issue_method=?,active=? WHERE id=?')
    .run(upd.name, upd.doctor, upd.location, upd.phone, upd.doctor_phone, upd.start_date, upd.issue_method, upd.active, h.id);
  res.json({ hospital: rowHosp({ id: h.id, base: h.base, ...upd }) });
});

/* ---------- clearing data ----------
   One target per dataset, never a single "clear everything" — the datasets are
   independent (the item master outlives any day's entry; a payment is not a
   purchase), so lumping them together would make a slip unrecoverable and would
   hide what was actually removed.

   Irreversible and bulk, so it is gated hard: admin only, and the caller must
   type the hospital's name back. */
const CLEAR_TARGETS = {
  entries:     { t: 'Daily entries', ranged: true,  tables: ['entries', 'notifications'] },
  /* Opening stock is inventory's anchor, and it is NOT the item master: you can
     re-do a bad opening count without throwing away every negotiated price. It
     lives on the items rows, so it is zeroed rather than deleted. */
  opening:     { t: 'Opening stock', ranged: false, tables: [], count: (hid) =>
                 db.prepare('SELECT COUNT(*) c FROM items WHERE hospital_id=? AND opening_qty!=0').get(hid).c },
  payments:    { t: 'Vendor payments', ranged: true, tables: ['payments'] },
  adjustments: { t: 'Stock adjustments', ranged: true, tables: ['stock_adjustments'] },
  snapshots:   { t: 'Imported stock reports', ranged: true, tables: ['expiry_snapshots'] },
  receivables: { t: 'Receivables', ranged: true, tables: ['receivables', 'receivable_actions'] },
  items:       { t: 'Item Master', ranged: false, tables: ['items', 'price_log', 'pending_items', 'item_aliases'] },
  vendors:     { t: 'Vendors', ranged: false, tables: ['vendors'] },
  periods:     { t: 'Weekly / monthly entered sections', ranged: false, tables: ['period_data'] }
};
/* which column dates each table, where it is ranged at all */
const CLEAR_DATE_COL = { entries: 'date', notifications: 'date', payments: 'date',
  stock_adjustments: 'date', expiry_snapshots: 'as_of', receivables: 'bill_date' };

app.get('/api/clear/preview', auth, requireRole('admin'), (req, res) => {
  const hid = S(req.query.hid, 60);
  scopeCheck(req, hid);
  const out = {};
  for (const [key, t] of Object.entries(CLEAR_TARGETS)) {
    const from = S(req.query.from, 12), to = S(req.query.to, 12);
    const ranged = t.ranged && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
    if (t.count) { out[key] = t.count(hid); continue; }
    const tbl = t.tables[0];
    const col = CLEAR_DATE_COL[tbl];
    out[key] = ranged && col
      ? db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE hospital_id=? AND ${col} BETWEEN ? AND ?`).get(hid, from, to).c
      : db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE hospital_id=?`).get(hid).c;
  }
  res.json({ counts: out });
});

app.post('/api/clear', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const hid = S(b.hid, 60);
  scopeCheck(req, hid);
  const key = S(b.target, 40);
  const T = CLEAR_TARGETS[key];
  if (!T) return res.status(400).json({ error: 'Unknown thing to clear' });
  const h = db.prepare('SELECT name FROM hospitals WHERE id=?').get(hid);
  if (!h) return res.status(404).json({ error: 'Unknown hospital' });
  // typing the name back is the last thing between a slip and lost work
  if (S(b.confirm, 150).trim() !== h.name)
    return res.status(400).json({ error: `Type the hospital name exactly — ${h.name} — to confirm` });

  const from = S(b.from, 12), to = S(b.to, 12);
  const ranged = T.ranged && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  if (T.ranged && !ranged) return res.status(400).json({ error: 'Pick a valid date range' });
  if (ranged && from > to) return res.status(400).json({ error: 'The range starts after it ends' });

  let deleted = 0;
  const tx = db.transaction(() => {
    // opening stock is a column on the items (plus the batch rows behind it),
    // not a table of its own — zero it and drop the anchor date, but leave the
    // items and their prices standing
    if (key === 'opening') {
      deleted = db.prepare('SELECT COUNT(*) c FROM items WHERE hospital_id=? AND opening_qty!=0').get(hid).c;
      db.prepare('UPDATE items SET opening_qty=0 WHERE hospital_id=?').run(hid);
      db.prepare('DELETE FROM opening_batches WHERE hospital_id=?').run(hid);
      db.prepare('UPDATE hospitals SET stock_date=NULL WHERE id=?').run(hid);
      return;
    }
    // receivable_actions are keyed to their bill, not to a date of their own —
    // clearing a bill must take its whole action log with it
    if (key === 'receivables') {
      const ids = ranged
        ? db.prepare('SELECT id FROM receivables WHERE hospital_id=? AND bill_date BETWEEN ? AND ?').all(hid, from, to).map(r => r.id)
        : db.prepare('SELECT id FROM receivables WHERE hospital_id=?').all(hid).map(r => r.id);
      for (const id of ids) db.prepare('DELETE FROM receivable_actions WHERE receivable_id=?').run(id);
      deleted = ids.length;
      if (ranged) db.prepare('DELETE FROM receivables WHERE hospital_id=? AND bill_date BETWEEN ? AND ?').run(hid, from, to);
      else db.prepare('DELETE FROM receivables WHERE hospital_id=?').run(hid);
      return;
    }
    for (const tbl of T.tables) {
      const col = CLEAR_DATE_COL[tbl];
      const r = (ranged && col)
        ? db.prepare(`DELETE FROM ${tbl} WHERE hospital_id=? AND ${col} BETWEEN ? AND ?`).run(hid, from, to)
        : db.prepare(`DELETE FROM ${tbl} WHERE hospital_id=?`).run(hid);
      if (tbl === T.tables[0]) deleted = r.changes;
    }
    // the item master carries the opening count — clearing it clears the anchor
    if (key === 'items') db.prepare('UPDATE hospitals SET stock_date=NULL WHERE id=?').run(hid);
  });
  tx();
  console.log(`[clear] ${req.user.name} cleared ${deleted} ${key} for ${hid}${ranged ? ` (${from}..${to})` : ' (everything)'}`);
  res.json({ deleted, target: key, from: ranged ? from : null, to: ranged ? to : null });
});

/* Every table a hospital owns. Deleting the hospital takes all of it — this is
   the single most destructive thing in the app, so the list is explicit rather
   than inferred, and the impact is countable before anything happens. */
const HOSPITAL_TABLES = ['entries', 'notifications', 'vendors', 'payments', 'items', 'price_log', 'pending_items', 'item_aliases', 'wa_outbox', 'approval_batches',
  'stock_adjustments', 'receivables', 'receivable_actions', 'expiry_snapshots', 'period_data',
  'hv_tracked', 'report_prefs', 'import_receipts', 'sales_removals', 'opening_loads', 'opening_batches'];

/* What would go, and who would be left without a hospital — answered BEFORE the
   delete, so the confirmation can show it rather than surprise anyone. */
app.get('/api/hospitals/:id/impact', auth, requireRole('admin'), (req, res) => {
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Unknown hospital' });
  const rows = {};
  let total = 0;
  for (const t of HOSPITAL_TABLES) {
    const c = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE hospital_id=?`).get(h.id).c;
    if (c) { rows[t] = c; total += c; }
  }
  // a user scoped only to this hospital would be left able to sign in and see nothing
  const stranded = db.prepare('SELECT id,name,email,hospital_ids FROM users').all()
    .map(u => ({ ...u, ids: JSON.parse(u.hospital_ids || '[]') }))
    .filter(u => !u.ids.includes('*') && u.ids.includes(h.id) && u.ids.filter(x => x !== h.id).length === 0)
    .map(u => ({ name: u.name, email: u.email }));
  res.json({ hospital: rowHosp(h), rows, total, stranded, remaining: db.prepare('SELECT COUNT(*) c FROM hospitals').get().c - 1 });
});

app.delete('/api/hospitals/:id', auth, requireRole('admin'), (req, res) => {
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Unknown hospital' });
  if (db.prepare('SELECT COUNT(*) c FROM hospitals').get().c <= 1)
    return res.status(400).json({ error: 'This is the only hospital — the console would have nothing to show' });
  const b = req.body || {};
  if (S(b.confirm, 150).trim() !== h.name)
    return res.status(400).json({ error: `Type the hospital name exactly — ${h.name} — to confirm` });

  let deleted = 0;
  const stranded = [];
  const tx = db.transaction(() => {
    for (const t of HOSPITAL_TABLES) deleted += db.prepare(`DELETE FROM ${t} WHERE hospital_id=?`).run(h.id).changes;
    // a user's scope must never point at a hospital that no longer exists
    for (const u of db.prepare('SELECT id,name,hospital_ids FROM users').all()) {
      const ids = JSON.parse(u.hospital_ids || '[]');
      if (ids.includes('*') || !ids.includes(h.id)) continue;
      const left = ids.filter(x => x !== h.id);
      db.prepare('UPDATE users SET hospital_ids=? WHERE id=?').run(JSON.stringify(left), u.id);
      if (!left.length) stranded.push(u.name);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);   // their scope changed under them
    }
    db.prepare('DELETE FROM hospitals WHERE id=?').run(h.id);
  });
  tx();
  console.log(`[hospital] ${req.user.name} DELETED ${h.id} (${h.name}) — ${deleted} rows${stranded.length ? `; stranded: ${stranded.join(', ')}` : ''}`);
  res.json({ deleted, id: h.id, name: h.name, stranded });
});

/* ---------- margin offers ----------
   Status is DERIVED where it can be: `expired` is not a state anyone sets, it is
   what `valid_till` means once the date passes. Only the decisions people
   actually make — accepted, declined, applied — are stored. */
const OFFER_STATES = ['proposed', 'accepted', 'declined', 'applied'];
const OFFER_ACTIONS = ['follow_up', 'note', 'revised', 'accepted', 'declined', 'applied', 'reopened'];
const offerMargin = (nr, mrp) => (N(mrp) > 0 ? (N(mrp) - N(nr)) / N(mrp) * 100 : 0);

function rowOffer(o, today) {
  const oldM = offerMargin(o.old_nr, o.old_mrp), newM = offerMargin(o.new_nr, o.new_mrp);
  // an offer past its date is expired whatever the stored state says — unless it
  // was already applied, which is history and cannot expire
  const expired = !!o.valid_till && o.valid_till < today && o.status !== 'applied' && o.status !== 'declined';
  return {
    id: o.id, hid: o.hospital_id, itemId: o.item_id || null, item: o.item_name,
    molecule: o.molecule || '', pack: o.pack || '',
    vendor: o.vendor || '', offeredBy: o.offered_by || '', offeredByPhone: o.offered_by_phone || '',
    negotiatedBy: o.negotiated_by, offerDate: o.offer_date,
    oldNr: N(o.old_nr), oldMrp: N(o.old_mrp), newNr: N(o.new_nr), newMrp: N(o.new_mrp),
    oldMargin: oldM, newMargin: newM, gainPts: newM - oldM,
    // what the better rate is worth over the quantity committed
    qtyCommit: N(o.qty_commit), savingRs: (N(o.old_nr) - N(o.new_nr)) * N(o.qty_commit),
    validTill: o.valid_till || null, nextFollowUp: o.next_follow_up || null,
    status: o.status, expired, effectiveStatus: expired ? 'expired' : o.status,
    notes: o.notes || '', appliedAt: o.applied_at || null,
    kind: o.kind || 'offer',
    approvalSentAt: o.approval_sent_at || null,
    approvedBy: o.approved_by || '', approvedAt: o.approved_at || null,
    // proposed + sent to the doctor + not yet decided = the ball is in their court
    awaitingDoctor: o.status === 'proposed' && !!o.approval_sent_at && !o.approved_at,
    createdBy: o.created_by, createdAt: o.created_at
  };
}
const rowOfferAction = (a) => ({ id: a.id, offerId: a.offer_id, type: a.type, note: a.note || '',
  date: a.action_date, by: a.by_name, at: a.at });
const offerActions = (oid) => db.prepare('SELECT * FROM margin_offer_actions WHERE offer_id=? ORDER BY action_date, at').all(oid);

function pushOfferAction(o, type, note, date, user) {
  const a = { id: uid('oa'), offer_id: o.id, hospital_id: o.hospital_id, type,
    note: S(note, 400), action_date: date || todayISO(), by_name: user, at: Date.now() };
  db.prepare('INSERT INTO margin_offer_actions(id,offer_id,hospital_id,type,note,action_date,by_name,at) VALUES(?,?,?,?,?,?,?,?)')
    .run(a.id, a.offer_id, a.hospital_id, a.type, a.note, a.action_date, a.by_name, a.at);
  return a;
}

app.post('/api/offers', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  scopeCheck(req, S(b.hid, 60));
  const item = S(b.item, 150).trim();
  if (!item) return res.status(400).json({ error: 'Which item is the offer for?' });
  const negotiatedBy = S(b.negotiatedBy, 120).trim();
  if (!negotiatedBy) return res.status(400).json({ error: 'Who is negotiating this? An offer nobody owns is an offer nobody chases.' });
  const offerDate = /^\d{4}-\d{2}-\d{2}$/.test(S(b.offerDate)) ? b.offerDate : todayISO();
  if (offerDate > todayISO()) return res.status(400).json({ error: 'The offer date cannot be in the future' });
  const newNr = N(b.newNr), newMrp = N(b.newMrp);
  if (newNr <= 0) return res.status(400).json({ error: 'What is the offered rate?' });
  if (newMrp > 0 && newNr > newMrp) return res.status(400).json({ error: 'The offered rate is above the MRP — that would sell at a loss' });
  const validTill = /^\d{4}-\d{2}-\d{2}$/.test(S(b.validTill)) ? b.validTill : null;
  if (validTill && validTill < offerDate) return res.status(400).json({ error: 'The offer cannot expire before it was made' });

  // the CURRENT price comes from the master, not from the caller — an offer is
  // measured against what we actually pay today
  const existing = b.itemId ? db.prepare('SELECT * FROM items WHERE id=? AND hospital_id=?').get(S(b.itemId, 60), b.hid)
    : db.prepare('SELECT * FROM items WHERE hospital_id=? AND name_key=?').get(b.hid, nameKey(item));
  const o = {
    id: uid('off'), hospital_id: b.hid, item_id: existing ? existing.id : null, item_name: existing ? existing.name : item,
    molecule: S(b.molecule, 150).trim() || (existing ? existing.molecule : ''), pack: S(b.pack, 60) || (existing ? existing.pack : ''),
    vendor: S(b.vendor, 120), offered_by: S(b.offeredBy, 120), offered_by_phone: S(b.offeredByPhone, 40),
    negotiated_by: negotiatedBy, offer_date: offerDate,
    old_nr: existing ? N(existing.nr) : N(b.oldNr), old_mrp: existing ? N(existing.mrp) : N(b.oldMrp),
    new_nr: newNr, new_mrp: newMrp || (existing ? N(existing.mrp) : 0),
    qty_commit: N(b.qtyCommit), valid_till: validTill,
    next_follow_up: /^\d{4}-\d{2}-\d{2}$/.test(S(b.nextFollowUp)) ? b.nextFollowUp : null,
    status: 'proposed', notes: S(b.notes, 400), applied_at: null,
    kind: b.kind === 'manual' ? 'manual' : 'offer',
    created_by: req.user.name, created_at: Date.now()
  };
  db.prepare(`INSERT INTO margin_offers(id,hospital_id,item_id,item_name,molecule,pack,vendor,offered_by,offered_by_phone,
    negotiated_by,offer_date,old_nr,old_mrp,new_nr,new_mrp,qty_commit,valid_till,next_follow_up,status,notes,applied_at,kind,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(o.id, o.hospital_id, o.item_id, o.item_name, o.molecule, o.pack, o.vendor, o.offered_by, o.offered_by_phone,
      o.negotiated_by, o.offer_date, o.old_nr, o.old_mrp, o.new_nr, o.new_mrp, o.qty_commit, o.valid_till,
      o.next_follow_up, o.status, o.notes, o.applied_at, o.kind, o.created_by, o.created_at);
  res.json({ offer: rowOffer(o, todayISO()), actions: [] });
});

/* Every move is an action on the log — including the decision itself, so the
   history reads as what happened rather than as a field that changed. */
app.post('/api/offers/:id/actions', auth, requireRole('admin'), (req, res, next) => {
  try {
    const b = req.body || {};
    const o = db.prepare('SELECT * FROM margin_offers WHERE id=?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    scopeCheck(req, o.hospital_id);
    const type = S(b.type, 30);
    if (!OFFER_ACTIONS.includes(type)) return res.status(400).json({ error: 'Unknown action' });
    const today = todayISO();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(S(b.date)) ? b.date : today;
    if (date > today) return res.status(400).json({ error: 'That date is in the future' });
    if (date < o.offer_date) return res.status(400).json({ error: `Before the offer was made (${o.offer_date})` });

    const upd = {};
    if (type === 'follow_up') {
      const nf = S(b.nextFollowUp, 12);
      if (nf && !/^\d{4}-\d{2}-\d{2}$/.test(nf)) return res.status(400).json({ error: 'Bad follow-up date' });
      upd.next_follow_up = nf || null;
    } else if (type === 'revised') {
      // the rep came back with a different number — the offer moves, the old one
      // stays on the log
      const nr = N(b.newNr);
      if (nr <= 0) return res.status(400).json({ error: 'What is the revised rate?' });
      const mrp = N(b.newMrp) || N(o.new_mrp);
      if (mrp > 0 && nr > mrp) return res.status(400).json({ error: 'The revised rate is above the MRP' });
      upd.new_nr = nr; upd.new_mrp = mrp;
      if (!S(b.note, 400).trim()) return res.status(400).json({ error: 'Say what changed' });
    } else if (type === 'accepted') {
      /* Acceptance is the DOCTOR's move (Arjun, Jul 22) — it happens on their
         approval page, never from the console. */
      return res.status(400).json({ error: 'Acceptance comes from the doctor — send the offer to them on WhatsApp and it moves to accepted when they agree' });
    } else if (type === 'declined') {
      if (o.status === 'applied') return res.status(400).json({ error: 'This offer is already applied to the Item Master' });
      upd.status = type;
      if (!S(b.note, 400).trim()) return res.status(400).json({ error: 'Why was it declined? That is the part worth keeping.' });
    } else if (type === 'reopened') {
      upd.status = 'proposed';
      upd.approved_by = ''; upd.approved_at = null; upd.approval_hash = null; upd.approval_sent_at = null;
      if (o.status === 'applied') return res.status(400).json({ error: 'An applied offer is history — raise a new one instead' });
    } else if (type === 'applied') {
      return res.status(400).json({ error: 'Use Apply to the Item Master — it moves the price and logs itself' });
    }

    const tx = db.transaction(() => {
      const keys = Object.keys(upd);
      if (keys.length) db.prepare(`UPDATE margin_offers SET ${keys.map(k => k + '=?').join(', ')} WHERE id=?`)
        .run(...keys.map(k => upd[k]), o.id);
      pushOfferAction(o, type, b.note, date, req.user.name);
    });
    tx();
    const fresh = db.prepare('SELECT * FROM margin_offers WHERE id=?').get(o.id);
    res.json({ offer: rowOffer(fresh, today), actions: offerActions(o.id).map(rowOfferAction) });
  } catch (err) { next(err); }
});

/* Applying is the ONLY thing that moves the Item Master, and it writes the
   ordinary price_log entry too — so the item's own history still tells the whole
   story without anyone needing to know the offer tracker exists.

   Since Jul 22 the doctor stands between accept and apply: it is their money the
   price moves, so a change lands only after they have said yes — from WhatsApp,
   on a signed single-use link, no console login needed. */
function applyOfferErr(o, today) {
  if (o.status === 'applied') return 'Already applied';
  if (o.status === 'declined') return 'This offer was declined — reopen it first';
  if (o.valid_till && o.valid_till < today) return `The offer expired on ${o.valid_till} — reopen it with a new validity if the vendor still honours it`;
  return null;
}
function applyOffer(o, byName, approvedBy) {
  const today = todayISO();
  let it = o.item_id ? db.prepare('SELECT * FROM items WHERE id=?').get(o.item_id) : null;
  if (!it) it = db.prepare('SELECT * FROM items WHERE hospital_id=? AND name_key=?').get(o.hospital_id, nameKey(o.item_name));
  const now = Date.now();
  const newNr = N(o.new_nr), newMrp = N(o.new_mrp) || (it ? N(it.mrp) : 0);
  if (newMrp <= 0) return { error: 'No MRP to price against — set one on the Item Master first' };
  if (newNr > newMrp) return { error: 'The offered rate is above the MRP' };
  /* the "old" rate shown to the doctor throughout the whole WhatsApp
     approval flow was frozen the moment this offer was created — but the
     Item Master's automatic batch-weighted sync keeps moving in the
     background. A price that has drifted since then is worth flagging: not
     a block, since the doctor already agreed to a specific NEW number, but
     the comparison they saw may no longer match what's actually on file. */
  const driftNote = (it && !RATE_TOL(N(o.old_nr), N(it.nr)))
    ? `Note: the master's rate has moved to ₹${it.nr} since this offer was created (shown to the doctor as ₹${o.old_nr}) — the batches on hand changed in the meantime.`
    : null;
  const src = (o.kind === 'manual') ? 'manual' : 'offer';
  const note = o.kind === 'manual'
    ? `${o.notes || 'Price revision'} — by ${o.negotiated_by}`
    : `Offer from ${o.vendor || 'vendor'}${o.offered_by ? ' (' + o.offered_by + ')' : ''}, negotiated by ${o.negotiated_by}`;
  const tx = db.transaction(() => {
    if (it) {
      db.prepare('INSERT INTO price_log(id,item_id,hospital_id,old_nr,old_mrp,new_nr,new_mrp,note,user_name,ts,source,offer_id,approved_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(uid('pl'), it.id, it.hospital_id, it.nr, it.mrp, newNr, newMrp, note, byName, now, src, o.id, approvedBy || '');
      db.prepare('UPDATE items SET nr=?, mrp=?, updated_at=? WHERE id=?').run(newNr, newMrp, now, it.id);
    } else {
      // the offer names an item the master has never seen — create it, or the
      // negotiated price would have nowhere to land
      const nit = { id: uid('it'), hospital_id: o.hospital_id, name: o.item_name, name_key: nameKey(o.item_name),
        pack: o.pack || '', nr: newNr, mrp: newMrp, source: 'offer', updated_at: now };
      db.prepare('INSERT INTO items(id,hospital_id,name,name_key,pack,nr,mrp,source,updated_at,molecule) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(nit.id, nit.hospital_id, nit.name, nit.name_key, nit.pack, nit.nr, nit.mrp, nit.source, nit.updated_at, o.molecule || '');
      it = nit;
      db.prepare('UPDATE margin_offers SET item_id=? WHERE id=?').run(nit.id, o.id);
    }
    db.prepare("UPDATE margin_offers SET status='applied', applied_at=? WHERE id=?").run(now, o.id);
    pushOfferAction(o, 'applied', `Item Master moved to ${newNr} / ${newMrp}${approvedBy ? ` — approved by ${approvedBy}` : ''}`, today, byName);
  });
  tx();
  return { item: db.prepare('SELECT * FROM items WHERE id=?').get(it.id), driftNote };
}

app.post('/api/offers/:id/apply', auth, requireRole('admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM margin_offers WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Offer not found' });
  scopeCheck(req, o.hospital_id);
  const today = todayISO();
  const bad = applyOfferErr(o, today);
  if (bad) return res.status(400).json({ error: bad });
  /* The gate. A price change is the doctor's decision — the console records it,
     it does not make it. */
  if (!o.approved_at) return res.status(400).json({ error: "Needs the doctor's approval first — send it to them from the offer; once they agree it shows as accepted and you can add it here" });
  const r = applyOffer(o, req.user.name, o.approved_by);
  if (r.error) return res.status(400).json({ error: r.error });
  const fresh = db.prepare('SELECT * FROM margin_offers WHERE id=?').get(o.id);
  res.json({ offer: rowOffer(fresh, today), actions: offerActions(o.id).map(rowOfferAction), item: rowItem(r.item), driftNote: r.driftNote || null });
});

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- WhatsApp (ThinkAI BSP) ----------
   Session sends via the ThinkAI console API — the same shape the mithra backend
   uses. A send failure is returned, never thrown: the caller always gets a
   wa.me fallback link, so a closed 24h window cannot block an approval. */
const WA_BASE = process.env.TAI_API_BASE || 'https://console.thinkaisolutions.com/api/v1';
const waEnabled = () => !!process.env.TAI_API_KEY;
async function sendWA(phone, text) {
  if (!waEnabled()) return { ok: false, error: 'WhatsApp sending is not configured (TAI_API_KEY)' };
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return { ok: false, error: 'Not a usable phone number' };
  try {
    const r = await fetch(`${WA_BASE}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: `+${digits}`, type: 'session', text }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true };
    // the classic: outside the 24h service window — the wa.me fallback covers it
    return { ok: false, status: r.status, error: (data && (data.error?.message || data.error || data.message)) || `send failed (${r.status})` };
  } catch (e) { return { ok: false, error: e.message || 'network error' }; }
}

/* ---------- the batch approval page ----------
   Same contract as the single page — public, the signed token IS the credential,
   single-use, no login. Each item carries its own tick so the doctor can approve
   some and leave others; one submit records the lot. */
function findApprovalBatch(token) {
  if (!/^[A-Za-z0-9_-]{20,50}$/.test(token || '')) return null;
  return db.prepare('SELECT * FROM approval_batches WHERE hash=?').get(hashToken(token)) || null;
}
function batchOffers(batch) {
  const ids = JSON.parse(batch.offer_ids || '[]');
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM margin_offers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}
const batchRowsHtml = (offers, withTicks) => `<table>${offers.map(o => `
  <tr>${withTicks ? `<td style="width:26px"><input type="checkbox" name="ok_${esc(o.id)}" value="1" checked style="width:17px;height:17px"></td>` : ''}
    <td>${esc(o.item_name)}${o.pack ? ' <span style="color:#9AA6A0">· ' + esc(o.pack) + '</span>' : ''}
      <div style="color:#6B7A73;font-size:12px">${esc(o.vendor || '')}${o.negotiated_by ? ' · ' + esc(o.negotiated_by) : ''}</div></td>
    <td style="white-space:nowrap">₹${N(o.old_nr) || '—'} → <b class="green">₹${N(o.new_nr)}</b></td></tr>`).join('')}</table>`;

app.get('/approve-batch/:token', (req, res) => {
  const batch = findApprovalBatch(req.params.token);
  res.type('html');
  if (!batch) return res.status(404).send(approvalPage('Link not valid', `<div class="sub">This approval link is not recognised — it may have been replaced by a newer one. Ask Yajna to resend it.</div>`));
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(batch.hospital_id) || { name: '', doctor: 'Doctor' };
  const offers = batchOffers(batch);
  const open = offers.filter(o => o.status === 'proposed');
  if ((batch.expires || 0) < Date.now()) return res.send(approvalPage('Link expired', `<div class="sub">This link has expired. Ask Yajna to resend the approvals.</div>`));
  if (!open.length) return res.send(approvalPage(esc(h.name), `<div class="sub">Everything in this batch has already been decided — nothing further to do.</div>${batchRowsHtml(offers, false)}`));
  return res.send(approvalPage(esc(h.name),
    `<div class="sub">${esc(h.doctor || 'Doctor')} — Yajna is asking your approval for ${open.length} purchase-price change${open.length === 1 ? '' : 's'}. Untick anything you are not approving today.</div>
     <form method="POST" action="/approve-batch/${esc(req.params.token)}">
       ${batchRowsHtml(open, true)}
       <textarea name="note" rows="2" placeholder="Note (optional — required if declining)"></textarea>
       <label style="display:flex;gap:9px;align-items:flex-start;margin-top:13px;font-size:14px;cursor:pointer">
         <input type="checkbox" name="agree" value="1" id="agr" style="margin-top:2px;width:17px;height:17px">
         <span>I agree to the ticked revised purchase rates for ${esc(h.name)}.</span></label>
       <div class="btns">
         <button class="no" name="decision" value="decline">Decline all</button>
         <button class="ok" name="decision" value="approve" id="apr" disabled style="opacity:.45">Approve ticked</button>
       </div></form>
     <script>document.getElementById('agr').onchange=function(){var b=document.getElementById('apr');b.disabled=!this.checked;b.style.opacity=this.checked?'1':'.45';};</script>`));
});

app.post('/approve-batch/:token', express.urlencoded({ extended: false }), (req, res) => {
  const batch = findApprovalBatch(req.params.token);
  res.type('html');
  if (!batch) return res.status(404).send(approvalPage('Link not valid', `<div class="sub">This approval link is not recognised.</div>`));
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(batch.hospital_id) || { name: '', doctor: 'Doctor' };
  if ((batch.expires || 0) < Date.now()) return res.send(approvalPage('Link expired', `<div class="sub">This link has expired. Ask Yajna to resend the approvals.</div>`));
  const offers = batchOffers(batch).filter(o => o.status === 'proposed');
  if (!offers.length) return res.send(approvalPage(esc(h.name), `<div class="sub">Already decided — nothing further to do.</div>`));
  const decision = String(req.body.decision || '');
  const note = S(req.body.note, 300).trim();
  const today = todayISO(), now = Date.now();
  const who = h.doctor || 'Doctor';
  const kill = () => db.prepare('UPDATE approval_batches SET hash=NULL, decided_at=? WHERE id=?').run(now, batch.id);

  if (decision === 'approve') {
    if (!req.body.agree) return res.send(approvalPage(esc(h.name), `<div class="sub">Tick "I agree to the ticked revised purchase rates" and press Approve again — the tick is your sign-off.</div>`));
    const picked = offers.filter(o => req.body[`ok_${o.id}`]);
    if (!picked.length) return res.send(approvalPage(esc(h.name), `<div class="sub">Nothing was ticked — tick the changes you approve, or use Decline all.</div>`));
    const tx = db.transaction(() => {
      for (const o of picked) {
        db.prepare("UPDATE margin_offers SET status='accepted', approved_by=?, approved_at=?, approval_hash=NULL WHERE id=?").run(who, now, o.id);
        pushOfferAction(o, 'accepted', `Approved by ${who} over WhatsApp (batch)${note ? ' — ' + note : ''}`, today, who);
      }
      kill();
    });
    tx();
    const skipped = offers.length - picked.length;
    return res.send(approvalPage(esc(h.name), `<div class="sub">Recorded, thank you — ${picked.length} change${picked.length === 1 ? '' : 's'} approved${skipped ? `, ${skipped} left undecided (Yajna can resend ${skipped === 1 ? 'it' : 'them'})` : ''}. Yajna will now add ${picked.length === 1 ? 'it' : 'them'} to the Item Master.</div><div class="btns"><div class="done">✓ ${picked.length} approved</div></div>`));
  }
  if (decision === 'decline') {
    if (!note) return res.send(approvalPage(esc(h.name), `<div class="sub">A declined batch needs a word on why — go back and add a note.</div>`));
    const tx = db.transaction(() => {
      for (const o of offers) {
        db.prepare("UPDATE margin_offers SET status='declined', approval_hash=NULL WHERE id=?").run(o.id);
        pushOfferAction(o, 'declined', `Declined by ${who} over WhatsApp (batch) — ${note}`, today, who);
      }
      kill();
    });
    tx();
    return res.send(approvalPage(esc(h.name), `<div class="sub">All ${offers.length} declined and recorded. Yajna will see your note.</div><div class="btns"><div class="done" style="background:#F7ECEA;color:#B3402E">Declined</div></div>`));
  }
  return res.status(400).send(approvalPage('Nothing chosen', `<div class="sub">Use the Approve or Decline button.</div>`));
});

/* ---------- inbound webhook from the ThinkAI console ----------
   Same contract the mithra backend uses: HMAC-SHA256 over the RAW body with the
   tenant's webhook secret, header x-thinkai-signature (hex or base64, optional
   sha256= prefix). PUBLIC route — the signature IS the authentication, so it is
   checked before anything is read, on the exact bytes received. */
const timingSafeEq = (a, b) => {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};
const seenWebhookIds = new Map();   // TAI retries on slow acks — dedupe by message id

app.post('/wa/webhook', (req, res) => {
  const secret = process.env.TAI_WEBHOOK_SECRET || '';
  const raw = req.rawBody || Buffer.from('');
  const sig = String(req.headers['x-thinkai-signature'] || '').replace(/^sha256=/i, '');
  const hex = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const b64 = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  if (!secret || !sig || !(timingSafeEq(sig, hex) || timingSafeEq(sig, b64)))
    return res.status(401).json({ error: 'invalid signature' });
  res.json({ status: 'ok' });                       // ack fast so the console does not retry

  const event = req.body || {};
  try {
    if (event.event !== 'incoming_message') return; // delivery/status receipts — nothing to act on
    const data = event.data || {};
    const text = String(data.replyId ?? data.text ?? '').trim();
    const from = String(data.from || '').replace(/\D/g, '');
    if (!from || !text) return;
    const dk = `wh:${data.messageId || event.id || from + ':' + text}`;
    if (seenWebhookIds.has(dk)) return;
    seenWebhookIds.set(dk, Date.now());
    if (seenWebhookIds.size > 200) { const cut = Date.now() - 60000; for (const [k, v] of seenWebhookIds) if (v < cut) seenWebhookIds.delete(k); }

    /* A reply from a DOCTOR's number is worth surfacing: it lands as a console
       alert on their hospital, and on the log of the offer that is with them —
       so "I'll do it Monday" said in chat is not lost to one person's phone.
       The approval itself still needs the signed link; a free-text "yes" is a
       message, not a signature. */
    const h = db.prepare('SELECT * FROM hospitals').all()
      .find(x => String(x.doctor_phone || '').replace(/\D/g, '') === from || String(x.phone || '').replace(/\D/g, '') === from);
    if (!h) { console.log(`[wa] inbound from unknown number ${from.slice(-4).padStart(from.length, '*')} — ignored`); return; }
    const now = Date.now(), today = todayISO();
    db.prepare('INSERT INTO notifications(id,type,hospital_id,date,msg,ts,read) VALUES(?,?,?,?,?,?,0)')
      .run(uid('n'), 'doctor_reply', h.id, today, `${h.doctor || 'The doctor'} replied on WhatsApp: “${text.slice(0, 180)}”`, now);
    /* their reply just opened the 24h window — deliver anything parked for them */
    flushOutbox(from).then(n => { if (n) console.log(`[wa] outbox flushed for ${h.doctor || h.id}: ${n} pending`); }).catch(() => {});
    const awaiting = db.prepare(
      "SELECT * FROM margin_offers WHERE hospital_id=? AND status='proposed' AND approval_sent_at IS NOT NULL AND approved_at IS NULL ORDER BY approval_sent_at DESC LIMIT 1").get(h.id);
    if (awaiting) pushOfferAction(awaiting, 'note', `WhatsApp reply from ${h.doctor || 'the doctor'}: ${text.slice(0, 300)}`, today, h.doctor || 'Doctor');
    console.log(`[wa] reply from ${h.doctor || h.id} logged${awaiting ? ' onto offer ' + awaiting.id : ''}`);
  } catch (err) { console.error('[wa] webhook handling error:', err.message); }
});

/* Template sends deliver REGARDLESS of the 24h window — the fix for a doctor
   who has not messaged the business number that day. The template name and
   language live in env so a rename never touches code. Variables are Meta
   template params: single-line strings, filled positionally. */
async function sendWATemplate(phone, templateName, languageCode, variables) {
  if (!waEnabled()) return { ok: false, error: 'WhatsApp sending is not configured (TAI_API_KEY)' };
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return { ok: false, error: 'Not a usable phone number' };
  try {
    const r = await fetch(`${WA_BASE}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: `+${digits}`, type: 'template', templateName, languageCode, variables }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, via: 'template' };
    return { ok: false, status: r.status, error: (data && (data.error?.message || data.error || data.message)) || `template send failed (${r.status})` };
  } catch (e) { return { ok: false, error: e.message || 'network error' }; }
}

/* ---------- report PDFs ----------
   The report the doctor receives is the SAME report the console shows: the
   client sends the rendered report markup, and the page's own stylesheet is
   lifted out of index.html and wrapped around it — one styling source, no
   second layout to drift. Chrome headless-shell does the printing. */
const CHROME_BIN = process.env.CHROME_BIN ||
  '/root/.cache/puppeteer/chrome-headless-shell/linux-147.0.7727.57/chrome-headless-shell-linux64/chrome-headless-shell';
let _browser = null, _browserTimer = null;
async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  const puppeteer = require('puppeteer-core');
  _browser = await puppeteer.launch({ executablePath: CHROME_BIN, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return _browser;
}
const touchBrowserIdle = () => {   // close after 60s idle — renders are bursts, RAM is shared
  clearTimeout(_browserTimer);
  _browserTimer = setTimeout(() => { if (_browser) { _browser.close().catch(() => {}); _browser = null; } }, 60000);
};
let _appCss = null;
function appCss() {
  if (_appCss) return _appCss;
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const m = html.match(/<style>([\s\S]*?)<\/style>/);
    _appCss = m ? m[1] : '';
  } catch (e) { _appCss = ''; }
  return _appCss;
}

/* The console's typefaces (Archivo + IBM Plex Mono) load from Google Fonts via
   <link> tags — which a bare setContent never sees, so the first PDFs rendered
   in Times fallback. Download the woff2s ONCE, inline them as base64
   @font-face, cache to disk: every later render is hermetic and instant. */
const FONTS_CSS_URL = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap';
const FONTS_CACHE = path.join(__dirname, 'data', 'fonts.css');
let _fontsCss = null;
async function pdfFontsCss() {
  if (_fontsCss !== null) return _fontsCss;
  try { _fontsCss = fs.readFileSync(FONTS_CACHE, 'utf8'); return _fontsCss; } catch (e) {}
  try {
    // a modern UA is what makes Google serve woff2 instead of legacy ttf css
    const css = await (await fetch(FONTS_CSS_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }, signal: AbortSignal.timeout(15000) })).text();
    const urls = [...new Set([...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map(m => m[1]))];
    let out = css;
    for (const u of urls) {
      const buf = Buffer.from(await (await fetch(u, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
      out = out.split(u).join(`data:font/woff2;base64,${buf.toString('base64')}`);
    }
    fs.writeFileSync(FONTS_CACHE, out);
    _fontsCss = out;
  } catch (e) {
    console.error('[pdf] font embed failed, falling back to system fonts:', e.message);
    _fontsCss = '';   // system stacks still carry the layout
  }
  return _fontsCss;
}

async function renderReportPdf(reportHtml) {
  const page = await (await getBrowser()).newPage();
  try {
    /* NO body.printing here: those @media print rules hide-everything-then-show
       the report with position:absolute — right for printing the live app page,
       fatal for a standalone document (absolute content does not paginate).
       This document IS only the report, so it just flows. */
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${await pdfFontsCss()}</style><style>${appCss()}
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
      html,body{background:#fff;margin:0;padding:0}
      .report-doc{box-shadow:none;border:none;border-radius:0;margin:0;max-width:none}
      .rp-inner{padding:4mm 3mm}
      .rp-sec{break-inside:avoid}
      .report-actions{display:none}
      /* A4 content width trips the app's narrow-screen media query — on paper
         the full grid fits, so pin the desktop layouts back */
      .rp-kpis{grid-template-columns:repeat(4,1fr) !important}
      .rp-meta{grid-template-columns:repeat(4,1fr) !important}
    </style></head><body>${reportHtml}</body></html>`, { waitUntil: 'load', timeout: 20000 });
    await page.evaluateHandle('document.fonts.ready').catch(() => {});
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
  } finally {
    await page.close().catch(() => {});
    touchBrowserIdle();
  }
}

/* a document over the BSP — same error contract as sendWA */
async function sendWADocument(phone, buffer, filename, caption) {
  if (!waEnabled()) return { ok: false, error: 'WhatsApp sending is not configured (TAI_API_KEY)' };
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return { ok: false, error: 'Not a usable phone number' };
  try {
    const r = await fetch(`${WA_BASE}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: `+${digits}`, type: 'document', filename,
        mimeType: 'application/pdf', caption: caption || undefined,
        dataBase64: buffer.toString('base64') }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true };
    return { ok: false, status: r.status, code: data && data.error && data.error.code,
      error: (data && (data.error?.message || data.error || data.message)) || `document send failed (${r.status})` };
  } catch (e) { return { ok: false, error: e.message || 'network error' }; }
}

/* a document-header template carrying OUR pdf — delivers with NO open window
   and no reply from the doctor. The whole reason yajna_report_pdf exists. */
async function sendWATemplateDoc(phone, templateName, languageCode, variables, pdfBuffer, filename) {
  if (!waEnabled()) return { ok: false, error: 'WhatsApp sending is not configured (TAI_API_KEY)' };
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return { ok: false, error: 'Not a usable phone number' };
  try {
    const r = await fetch(`${WA_BASE}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: `+${digits}`, type: 'template', templateName, languageCode, variables,
        headerDocumentBase64: pdfBuffer.toString('base64'), headerFilename: filename }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, via: 'template_document' };
    return { ok: false, status: r.status, error: (data && (data.error?.message || data.error || data.message)) || `template document send failed (${r.status})` };
  } catch (e) { return { ok: false, error: e.message || 'network error' }; }
}

/* park a document for delivery the moment the doctor's window opens */
function queueOutbox(hid, phone, buffer, filename, caption) {
  const id = uid('ob');
  db.prepare('INSERT INTO wa_outbox(id,hospital_id,phone,filename,caption,mime,payload,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, hid, String(phone).replace(/\D/g, ''), filename, caption || '', 'application/pdf', buffer, 'pending', Date.now());
  return id;
}
async function flushOutbox(digits) {
  const rows = db.prepare("SELECT * FROM wa_outbox WHERE phone=? AND status='pending' ORDER BY created_at").all(digits);
  for (const row of rows) {
    const sent = await sendWADocument(row.phone, row.payload, row.filename, row.caption);
    if (sent.ok) db.prepare("UPDATE wa_outbox SET status='sent', sent_at=? WHERE id=?").run(Date.now(), row.id);
    else {
      db.prepare('UPDATE wa_outbox SET last_error=? WHERE id=?').run(String(sent.error || ''), row.id);
      break;   // the window is either open for all of them or none — do not hammer
    }
  }
  return rows.length;
}

/* ---------- doctor approval over WhatsApp ----------
   The doctor is not a console user and should not need to become one to say yes
   to a rate. They get a WhatsApp message with a signed single-use link; the page
   shows exactly what changes and two buttons. Approve applies it on the spot. */
const APPROVAL_DAYS = 7;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function approvalText(o, h, url) {
  const oldM = offerMargin(o.old_nr, o.old_mrp).toFixed(1), newM = offerMargin(o.new_nr, o.new_mrp).toFixed(1);
  return `*Price approval — ${h.name}*\n\n` +
    `${o.item_name}${o.pack ? ' (' + o.pack + ')' : ''}\n` +
    `Purchase rate: ₹${N(o.old_nr) || '—'} → *₹${N(o.new_nr)}* per strip\n` +
    `Margin: ${oldM}% → ${newM}%\n` +
    (o.vendor ? `Vendor: ${o.vendor}${o.offered_by ? ' (' + o.offered_by + ')' : ''}\n` : '') +
    `Negotiated by: ${o.negotiated_by}\n\n` +
    `Approve or decline here (link works once, for ${APPROVAL_DAYS} days):\n${url}\n\n— Yajna Pharma Solutions`;
}

app.post('/api/offers/:id/request-approval', auth, requireRole('admin'), async (req, res) => {
  const o = db.prepare('SELECT * FROM margin_offers WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Offer not found' });
  const h = scopeCheck(req, o.hospital_id);
  const today = todayISO();
  const bad = applyOfferErr(o, today);
  if (bad) return res.status(400).json({ error: bad });
  if (o.status === 'accepted' || o.approved_at) return res.status(400).json({ error: `${o.approved_by || 'The doctor'} already approved this — add it to the Item Master` });
  if (o.status !== 'proposed') return res.status(400).json({ error: 'Only an open offer can be sent for approval' });

  // re-sending replaces the token: only the LATEST link works, so a message
  // forwarded around later cannot approve anything
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare('UPDATE margin_offers SET approval_hash=?, approval_sent_at=?, approval_expires=? WHERE id=?')
    .run(hashToken(token), now, now + APPROVAL_DAYS * 86400000, o.id);
  pushOfferAction(o, 'note', `Sent to ${h.doctor || 'the doctor'} for approval`, today, req.user.name);

  const base = process.env.APP_BASE_URL || 'https://yajna.thinkaisolotions.com';
  const url = `${base}/approve/${token}`;
  const text = approvalText(o, h, url);
  const phone = (h.doctor_phone || h.phone || '').replace(/\D/g, '');
  /* template first (no window needed), session second (window open), and the
     caller always gets the wa.me fallback regardless */
  let sent = { ok: false, error: 'No WhatsApp number for the doctor — add it under Edit hospital' };
  if (phone) {
    const tpl = process.env.TAI_APPROVAL_TEMPLATE;
    if (tpl) sent = await sendWATemplate(phone, tpl, process.env.TAI_TEMPLATE_LANG || 'en_US',
      [h.doctor || 'Doctor', h.name,
       `${o.item_name}${o.pack ? ' (' + o.pack + ')' : ''} — ₹${N(o.old_nr) || 0} to ₹${N(o.new_nr)} per strip`,
       token]);
    if (!sent.ok) {
      const s2 = await sendWA(phone, text);
      if (s2.ok || !process.env.TAI_APPROVAL_TEMPLATE) sent = s2;
      else sent = { ok: false, error: `template: ${sent.error}; session: ${s2.error}` };
    }
  }

  const fresh = db.prepare('SELECT * FROM margin_offers WHERE id=?').get(o.id);
  res.json({
    offer: rowOffer(fresh, today), actions: offerActions(o.id).map(rowOfferAction),
    url, text, sent,
    waLink: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null
  });
});

function batchApprovalText(offers, h, url) {
  const lines = offers.map(o => `• ${o.item_name}${o.pack ? ' (' + o.pack + ')' : ''}: ₹${N(o.old_nr) || '—'} → ₹${N(o.new_nr)} per strip`);
  return `*Price approvals — ${h.name}*\n\n${h.doctor || 'Doctor'}, Yajna Pharma Solutions requests your approval for ${offers.length} purchase price change${offers.length === 1 ? '' : 's'}:\n\n` +
    lines.join('\n') + `\n\nReview and approve them here (link works once, for ${APPROVAL_DAYS} days):\n${url}\n\n— Yajna Pharma Solutions`;
}

/* Send EVERY open (proposed) offer to the doctor as ONE link. Individual links
   keep working; a batch is just a wider door onto the same decisions. */
app.post('/api/offers/request-batch-approval', auth, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const h = scopeCheck(req, S(b.hid, 60));
  const wanted = Array.isArray(b.offerIds) ? b.offerIds.map(x => S(x, 60)) : null;
  const today = todayISO();
  let offers = db.prepare("SELECT * FROM margin_offers WHERE hospital_id=? AND status='proposed'").all(h.id)
    .filter(o => !applyOfferErr(o, today));
  if (wanted) offers = offers.filter(o => wanted.includes(o.id));
  if (!offers.length) return res.status(400).json({ error: 'No open offers to send — record them first' });

  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const batch = { id: uid('ab'), hospital_id: h.id, hash: hashToken(token),
    offer_ids: JSON.stringify(offers.map(o => o.id)), sent_at: now, expires: now + APPROVAL_DAYS * 86400000, created_at: now };
  db.prepare('INSERT INTO approval_batches(id,hospital_id,hash,offer_ids,sent_at,expires,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(batch.id, batch.hospital_id, batch.hash, batch.offer_ids, batch.sent_at, batch.expires, batch.created_at);
  const upd = db.prepare('UPDATE margin_offers SET approval_sent_at=? WHERE id=?');
  offers.forEach(o => { upd.run(now, o.id); pushOfferAction(o, 'note', `Sent to ${h.doctor || 'the doctor'} in a batch of ${offers.length}`, today, req.user.name); });

  const base = process.env.APP_BASE_URL || 'https://yajna.thinkaisolotions.com';
  const url = `${base}/approve-batch/${token}`;
  const text = batchApprovalText(offers, h, url);
  const phone = (h.doctor_phone || h.phone || '').replace(/\D/g, '');
  let sent = { ok: false, error: 'No WhatsApp number for the doctor — add it under Edit hospital' };
  if (phone) {
    const tpl = process.env.TAI_BATCH_TEMPLATE;
    if (tpl) sent = await sendWATemplate(phone, tpl, process.env.TAI_TEMPLATE_LANG || 'en_US',
      [h.doctor || 'Doctor', String(offers.length), h.name, token]);
    if (!sent.ok) {
      const s2 = await sendWA(phone, text);
      if (s2.ok || !process.env.TAI_BATCH_TEMPLATE) sent = s2;
      else sent = { ok: false, error: `template: ${sent.error}; session: ${s2.error}` };
    }
  }
  const fresh = db.prepare(`SELECT * FROM margin_offers WHERE id IN (${offers.map(() => '?').join(',')})`).all(...offers.map(o => o.id));
  res.json({ batchId: batch.id, count: offers.length, url, text, sent,
    offers: fresh.map(o => rowOffer(o, today)),
    waLink: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null });
});

const approvalPage = (title, body, buttons) => `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} — Yajna Pharma</title>
<style>
  body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#F4F6F5;margin:0;padding:18px;color:#17211D}
  .card{max-width:430px;margin:24px auto;background:#fff;border-radius:14px;padding:22px;box-shadow:0 2px 14px rgba(0,0,0,.07)}
  h2{margin:0 0 4px;font-size:19px} .sub{color:#6B7A73;font-size:13px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;font-size:14.5px}
  td{padding:7px 0;border-bottom:1px solid #EDF0EE} td:first-child{color:#6B7A73}
  td:last-child{text-align:right;font-weight:600}
  .big{font-size:17px} .green{color:#0F6E56}
  .btns{display:flex;gap:10px;margin-top:20px}
  button,.done{flex:1;padding:13px 0;border-radius:10px;border:none;font-size:15.5px;font-weight:700;cursor:pointer}
  .ok{background:#0F6E56;color:#fff} .no{background:#fff;color:#B3402E;border:1.5px solid #E5C0B8}
  textarea{width:100%;box-sizing:border-box;margin-top:14px;border:1px solid #D8DEDA;border-radius:9px;padding:10px;font:inherit;font-size:14px}
  .done{text-align:center;background:#EAF3EF;color:#0F6E56;cursor:default}
  .foot{text-align:center;color:#9AA6A0;font-size:12px;margin-top:18px}
</style></head><body><div class="card"><h2>${title}</h2>${body}${buttons || ''}</div>
<div class="foot">Yajna Pharma Solutions · Bhimavaram</div></body></html>`;

function findApprovalOffer(token) {
  if (!/^[A-Za-z0-9_-]{20,50}$/.test(token || '')) return null;
  return db.prepare('SELECT * FROM margin_offers WHERE approval_hash=?').get(hashToken(token)) || null;
}

/* Both routes are PUBLIC: the token IS the credential. It is unguessable
   (192 random bits, stored hashed), single-purpose, and expires. */
app.get('/approve/:token', (req, res) => {
  const o = findApprovalOffer(req.params.token);
  res.type('html');
  if (!o) return res.status(404).send(approvalPage('Link not valid', `<div class="sub">This approval link is not recognised — it may have been replaced by a newer one. Ask Yajna to resend it.</div>`));
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(o.hospital_id) || { name: '', doctor: '' };
  const rows = `<table>
    <tr><td>Item</td><td>${esc(o.item_name)}${o.pack ? ' · ' + esc(o.pack) : ''}</td></tr>
    <tr><td>Purchase rate / strip</td><td class="big">₹${N(o.old_nr) || '—'} → <span class="green">₹${N(o.new_nr)}</span></td></tr>
    <tr><td>Margin</td><td>${offerMargin(o.old_nr, o.old_mrp).toFixed(1)}% → <span class="green">${offerMargin(o.new_nr, o.new_mrp).toFixed(1)}%</span></td></tr>
    ${o.vendor ? `<tr><td>Vendor</td><td>${esc(o.vendor)}</td></tr>` : ''}
    <tr><td>Negotiated by</td><td>${esc(o.negotiated_by)}</td></tr>
  </table>`;
  if (o.status === 'applied') return res.send(approvalPage(esc(h.name), `<div class="sub">This change was already approved${o.approved_by ? ' by ' + esc(o.approved_by) : ''} and is on the Item Master.</div>${rows}<div class="btns"><div class="done">✓ Approved &amp; applied</div></div>`));
  if (o.status === 'accepted') return res.send(approvalPage(esc(h.name), `<div class="sub">Already approved${o.approved_by ? ' by ' + esc(o.approved_by) : ''} — Yajna is adding it to the Item Master.</div>${rows}<div class="btns"><div class="done">✓ Approved</div></div>`));
  if (o.status === 'declined') return res.send(approvalPage(esc(h.name), `<div class="sub">This change was declined.</div>${rows}<div class="btns"><div class="done" style="background:#F7ECEA;color:#B3402E">Declined</div></div>`));
  if ((o.approval_expires || 0) < Date.now()) return res.send(approvalPage('Link expired', `<div class="sub">This link has expired. Ask Yajna to resend the approval.</div>${rows}`));
  return res.send(approvalPage(esc(h.name),
    `<div class="sub">${esc(h.doctor || 'Doctor')} — Yajna is asking your approval for this purchase-price change.</div>${rows}
     <form method="POST" action="/approve/${esc(req.params.token)}">
       <textarea name="note" rows="2" placeholder="Note (optional — required if declining)"></textarea>
       <label style="display:flex;gap:9px;align-items:flex-start;margin-top:13px;font-size:14px;cursor:pointer">
         <input type="checkbox" name="agree" value="1" id="agr" style="margin-top:2px;width:17px;height:17px">
         <span>I agree to the revised purchase rate of <b>₹${N(o.new_nr)}</b> per strip for ${esc(o.item_name)}.</span></label>
       <div class="btns">
         <button class="no" name="decision" value="decline">Decline</button>
         <button class="ok" name="decision" value="approve" id="apr" disabled style="opacity:.45">Approve</button>
       </div></form>
     <script>document.getElementById('agr').onchange=function(){var b=document.getElementById('apr');b.disabled=!this.checked;b.style.opacity=this.checked?'1':'.45';};</script>`));
});

app.post('/approve/:token', express.urlencoded({ extended: false }), (req, res) => {
  const o = findApprovalOffer(req.params.token);
  res.type('html');
  if (!o) return res.status(404).send(approvalPage('Link not valid', `<div class="sub">This approval link is not recognised.</div>`));
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(o.hospital_id) || { name: '', doctor: 'Doctor' };
  if (o.status !== 'proposed')
    return res.send(approvalPage(esc(h.name), `<div class="sub">Already decided — nothing further to do.</div>`));
  if ((o.approval_expires || 0) < Date.now())
    return res.send(approvalPage('Link expired', `<div class="sub">This link has expired. Ask Yajna to resend the approval.</div>`));
  const decision = String(req.body.decision || '');
  const note = S(req.body.note, 300).trim();
  const today = todayISO(), now = Date.now();
  const who = h.doctor || 'Doctor';
  if (decision === 'approve') {
    if (!req.body.agree) return res.send(approvalPage(esc(h.name), `<div class="sub">Tick "I agree to the revised purchase rate" and press Approve again — the tick is your sign-off.</div>`));
    /* The doctor's yes moves the offer to ACCEPTED. The Item Master itself moves
       when the manager applies it — approval is the doctor's decision, applying
       is Yajna's act, and the log shows both hands. */
    db.prepare("UPDATE margin_offers SET status='accepted', approved_by=?, approved_at=?, approval_hash=NULL WHERE id=?").run(who, now, o.id);
    pushOfferAction(o, 'accepted', `Approved by ${who} over WhatsApp${note ? ' — ' + note : ''}`, today, who);
    return res.send(approvalPage(esc(h.name), `<div class="sub">Recorded, thank you. Yajna will now add ₹${N(o.new_nr)} per strip to the Item Master.</div><div class="btns"><div class="done">✓ Approved</div></div>`));
  }
  if (decision === 'decline') {
    if (!note) return res.send(approvalPage(esc(h.name), `<div class="sub">A declined price needs a word on why — go back and add a note.</div>`));
    db.prepare("UPDATE margin_offers SET status='declined', approval_hash=NULL WHERE id=?").run(o.id);
    pushOfferAction(o, 'declined', `Declined by ${who} over WhatsApp — ${note}`, today, who);
    return res.send(approvalPage(esc(h.name), `<div class="sub">Declined and recorded. Yajna will see your note.</div><div class="btns"><div class="done" style="background:#F7ECEA;color:#B3402E">Declined</div></div>`));
  }
  return res.status(400).send(approvalPage('Nothing chosen', `<div class="sub">Use the Approve or Decline button.</div>`));
});

app.delete('/api/offers/:id', auth, requireRole('admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM margin_offers WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Offer not found' });
  scopeCheck(req, o.hospital_id);
  if (o.status === 'applied') return res.status(400).json({ error: 'An applied offer is part of the price history — it cannot be deleted' });
  db.prepare('DELETE FROM margin_offer_actions WHERE offer_id=?').run(o.id);
  db.prepare('DELETE FROM margin_offers WHERE id=?').run(o.id);
  res.json({ ok: true, id: o.id });
});

const rowPending = (p) => ({ id: p.id, hid: p.hospital_id, name: p.name, key: p.name_key, pack: p.pack || '',
  nr: N(p.nr), mrp: N(p.mrp), vendor: p.source_vendor || '', firstDate: p.first_date, lastDate: p.last_date,
  seen: p.seen_count, status: p.status, matchedItemId: p.matched_item_id || null,
  resolvedBy: p.resolved_by || '', resolvedAt: p.resolved_at || null });
const rowAlias = (a) => ({ id: a.id, aliasKey: a.alias_key, itemId: a.item_id, by: a.created_by || '', at: a.created_at });

/* ---------- pending items: the manager's gate onto the Item Master ----------
   Approve = it really is a new item, put it on the master.
   Match   = it is a misspelling of one we have — leave an alias so this exact
             spelling resolves itself on every future purchase, and the ledger
             (which derives) immediately re-counts the old lines under the real
             item. Nothing saved is rewritten.
   Dismiss = junk row; it reopens by itself if it is ever bought again. */
app.post('/api/pending-items/:id/approve', auth, requireRole('admin'), (req, res) => {
  const pi = db.prepare('SELECT * FROM pending_items WHERE id=?').get(req.params.id);
  if (!pi) return res.status(404).json({ error: 'Not found' });
  scopeCheck(req, pi.hospital_id);
  if (pi.status !== 'pending') return res.status(400).json({ error: 'Already resolved — reload' });
  const b = req.body || {};
  const name = S(b.name, 150).trim() || pi.name;
  const nr = b.nr !== undefined ? N(b.nr) : N(pi.nr);
  const mrp = b.mrp !== undefined ? N(b.mrp) : N(pi.mrp);
  if (nr <= 0 || mrp <= 0) return res.status(400).json({ error: 'The master needs a positive NR and MRP — fill them in before approving' });
  if (nr > mrp) return res.status(400).json({ error: 'NR cannot exceed MRP' });
  const key = nameKey(name);
  if (db.prepare('SELECT 1 FROM items WHERE hospital_id=? AND name_key=?').get(pi.hospital_id, key))
    return res.status(409).json({ error: 'That name is already on the master — use Match instead' });
  const now = Date.now();
  const it = { id: uid('it'), hospital_id: pi.hospital_id, name, name_key: key, pack: S(b.pack, 60).trim() || (pi.pack || ''),
    nr, mrp, molecule: S(b.molecule, 150).trim(), source: 'purchase', updated_at: now };
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO items(id,hospital_id,name,name_key,pack,nr,mrp,source,updated_at,molecule) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(it.id, it.hospital_id, it.name, it.name_key, it.pack, it.nr, it.mrp, it.source, it.updated_at, it.molecule);
    // approving under a corrected spelling: the PURCHASED spelling still needs to
    // resolve, so it becomes an alias of the new item
    if (key !== pi.name_key)
      db.prepare('INSERT OR IGNORE INTO item_aliases(id,hospital_id,alias_key,item_id,created_by,created_at) VALUES(?,?,?,?,?,?)')
        .run(uid('al'), pi.hospital_id, pi.name_key, it.id, req.user.name, now);
    db.prepare("UPDATE pending_items SET status='approved', matched_item_id=?, resolved_by=?, resolved_at=? WHERE id=?")
      .run(it.id, req.user.name, now, pi.id);
  });
  tx();
  const aliases = db.prepare('SELECT * FROM item_aliases WHERE hospital_id=?').all(pi.hospital_id).map(rowAlias);
  res.json({ item: rowItem(it), pending: rowPending(db.prepare('SELECT * FROM pending_items WHERE id=?').get(pi.id)), aliases });
});

app.post('/api/pending-items/:id/match', auth, requireRole('admin'), (req, res) => {
  const pi = db.prepare('SELECT * FROM pending_items WHERE id=?').get(req.params.id);
  if (!pi) return res.status(404).json({ error: 'Not found' });
  scopeCheck(req, pi.hospital_id);
  if (pi.status !== 'pending') return res.status(400).json({ error: 'Already resolved — reload' });
  const it = db.prepare('SELECT * FROM items WHERE id=? AND hospital_id=?').get(S(req.body && req.body.itemId, 60), pi.hospital_id);
  if (!it) return res.status(400).json({ error: 'Pick the master item this really is' });
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO item_aliases(id,hospital_id,alias_key,item_id,created_by,created_at) VALUES(?,?,?,?,?,?)')
      .run(uid('al'), pi.hospital_id, pi.name_key, it.id, req.user.name, now);
    db.prepare("UPDATE pending_items SET status='matched', matched_item_id=?, resolved_by=?, resolved_at=? WHERE id=?")
      .run(it.id, req.user.name, now, pi.id);
  });
  tx();
  const aliases = db.prepare('SELECT * FROM item_aliases WHERE hospital_id=?').all(pi.hospital_id).map(rowAlias);
  res.json({ pending: rowPending(db.prepare('SELECT * FROM pending_items WHERE id=?').get(pi.id)), aliases, item: rowItem(it) });
});

app.post('/api/pending-items/:id/dismiss', auth, requireRole('admin'), (req, res) => {
  const pi = db.prepare('SELECT * FROM pending_items WHERE id=?').get(req.params.id);
  if (!pi) return res.status(404).json({ error: 'Not found' });
  scopeCheck(req, pi.hospital_id);
  if (pi.status !== 'pending') return res.status(400).json({ error: 'Already resolved — reload' });
  db.prepare("UPDATE pending_items SET status='dismissed', resolved_by=?, resolved_at=? WHERE id=?")
    .run(req.user.name, Date.now(), pi.id);
  res.json({ pending: rowPending(db.prepare('SELECT * FROM pending_items WHERE id=?').get(pi.id)) });
});

/* ---------- procurement price history ----------
   Every price the master has ever carried, hospital-wide: what moved, when, who
   negotiated it, and which doctor said yes. This IS the "offers that updated the
   Item Master" view — price_log is the one ledger both paths write. */
app.get('/api/price-history', auth, requireRole('admin'), (req, res) => {
  const hid = S(req.query.hid, 60);
  scopeCheck(req, hid);
  const rows = db.prepare(`
    SELECT pl.*, i.name AS item_name, i.pack AS item_pack, o.vendor AS offer_vendor, o.offered_by AS offer_by
    FROM price_log pl
    LEFT JOIN items i ON i.id = pl.item_id
    LEFT JOIN margin_offers o ON o.id = pl.offer_id
    WHERE pl.hospital_id = ? ORDER BY pl.ts DESC LIMIT 500`).all(hid);
  res.json({ history: rows.map(r => ({
    id: r.id, itemId: r.item_id, item: r.item_name || '(item removed)', pack: r.item_pack || '',
    oldNr: N(r.old_nr), oldMrp: N(r.old_mrp), newNr: N(r.new_nr), newMrp: N(r.new_mrp),
    oldMargin: offerMargin(r.old_nr, r.old_mrp), newMargin: offerMargin(r.new_nr, r.new_mrp),
    source: r.source || 'manual', offerId: r.offer_id || null,
    vendor: r.offer_vendor || '', offeredBy: r.offer_by || '',
    approvedBy: r.approved_by || '', note: r.note || '', by: r.user_name || '', ts: r.ts
  })) });
});

/* ---------- send a report to the doctor ----------
   The client already builds the WhatsApp summary for every report — this just
   carries it the last mile, to the doctor's own number, over the BSP. */
app.post('/api/wa/report', auth, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const h = scopeCheck(req, S(b.hid, 60));
  const text = S(b.text, 3500).trim();
  if (!text) return res.status(400).json({ error: 'Nothing to send — generate the report first' });
  const phone = (h.doctor_phone || h.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: "No WhatsApp number for the doctor — add it under Edit hospital" });

  /* The doctor gets the REPORT, not a summary of it: the client ships the
     rendered markup, we print it to PDF and send the document. When the 24h
     window is shut the PDF parks in the outbox, a template nudge goes out, and
     the doctor's reply (webhook) delivers it. The text summary rides as the
     caption — and stays the whole fallback when no HTML came. */
  const html = typeof b.html === 'string' ? b.html.slice(0, 2_000_000) : '';
  const label = S(b.label, 80) || 'report';
  const fname = `Yajna-${(h.name || 'report').replace(/[^A-Za-z0-9]+/g, '-')}-${label.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`;

  let pdf = null, pdfError = '';
  if (html) {
    try { pdf = Buffer.from(await renderReportPdf(html)); }
    catch (e) { pdfError = e.message || 'PDF render failed'; console.error('[wa] pdf render:', pdfError); }
  }

  if (pdf) {
    const caption = `${h.doctor ? h.doctor + ' — ' : ''}${label} · Yajna Pharma Solutions`;
    const sent = await sendWADocument(phone, pdf, fname, caption);
    if (sent.ok) return res.json({ sent: { ok: true, via: 'document' }, to: `+${phone}` });

    /* Window shut (or no conversation yet): the PDF still goes NOW — it rides a
       document-header template, which Meta delivers without any open window.
       Nobody has to reply to anything. */
    if (process.env.TAI_REPORT_DOC_TEMPLATE) {
      const tdoc = await sendWATemplateDoc(phone, process.env.TAI_REPORT_DOC_TEMPLATE,
        process.env.TAI_TEMPLATE_LANG || 'en_US', [h.doctor || 'Doctor', label], pdf, fname);
      if (tdoc.ok) return res.json({ sent: { ok: true, via: 'template_document' }, to: `+${phone}` });
    }

    /* Last ditch (doc template missing / still pending at Meta): park the PDF +
       nudge — their reply delivers it via the webhook. */
    const outboxId = queueOutbox(h.id, phone, pdf, fname, caption);
    let nudge = { ok: false, error: 'TAI_REPORT_TEMPLATE not set' };
    if (process.env.TAI_REPORT_TEMPLATE) {
      nudge = await sendWATemplate(phone, process.env.TAI_REPORT_TEMPLATE,
        process.env.TAI_TEMPLATE_LANG || 'en_US', [h.doctor || 'Doctor', label]);
    }
    return res.json({
      sent: { ok: nudge.ok, via: nudge.ok ? 'template_nudge' : 'queued', queued: true,
        error: nudge.ok ? undefined : `Direct send: ${sent.error}. Nudge: ${nudge.error || 'failed'}` },
      to: `+${phone}`, outboxId,
      note: nudge.ok
        ? 'The PDF is queued — the doctor got a WhatsApp asking them to reply, and their reply delivers it automatically.'
        : 'The PDF is queued and will deliver the next time the doctor messages the business number.',
      waLink: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
    });
  }

  // no PDF (no HTML from the client, or the render failed) — the text summary path
  const sent = await sendWA(phone, text);
  res.json({ sent, to: `+${phone}`, pdfError: pdfError || undefined,
    waLink: `https://wa.me/${phone}?text=${encodeURIComponent(text)}` });
});

/* ---------- the group item master ----------
   Every hospital's master in one place, grouped by MOLECULE so the same purchase
   decision made twice can be compared. The whole point is the spread: if one
   hospital buys a molecule 12 points better than another, that gap is money. */
app.get('/api/master', auth, requireRole('admin'), (req, res) => {
  const hids = allowedHids(req.user);
  const hosps = (hids === null ? db.prepare('SELECT * FROM hospitals').all()
    : db.prepare(`SELECT * FROM hospitals WHERE id IN (${hids.map(() => '?').join(',') || "''"})`).all(...hids));
  const groups = {};
  for (const h of hosps) {
    for (const it of db.prepare('SELECT * FROM items WHERE hospital_id=?').all(h.id)) {
      /* Group by molecule when it is recorded, else by the item name — grouping
         everything unlabelled together would invent comparisons that do not exist. */
      const key = it.molecule ? 'm:' + nameKey(it.molecule) : 'n:' + it.name_key;
      const g = groups[key] = groups[key] || { key, molecule: it.molecule || '', label: it.molecule || it.name, byMolecule: !!it.molecule, rows: [] };
      if (it.molecule && !g.molecule) { g.molecule = it.molecule; g.label = it.molecule; g.byMolecule = true; }
      g.rows.push({ hid: h.id, hospital: h.name, itemId: it.id, name: it.name, pack: it.pack || '',
        nr: N(it.nr), mrp: N(it.mrp), margin: offerMargin(it.nr, it.mrp), openingQty: N(it.opening_qty), updatedAt: it.updated_at });
    }
  }
  const out = Object.values(groups).map(g => {
    const ms = g.rows.map(r => r.margin);
    const best = Math.max(...ms), worst = Math.min(...ms);
    const bestRow = g.rows.find(r => r.margin === best);
    return { ...g, hospitals: g.rows.length, bestMargin: best, worstMargin: worst,
      spreadPts: g.rows.length > 1 ? best - worst : 0,
      bestAt: bestRow ? bestRow.hospital : '', bestNr: bestRow ? bestRow.nr : 0 };
  }).sort((a, z) => z.spreadPts - a.spreadPts || a.label.localeCompare(z.label));
  res.json({ groups: out, hospitals: hosps.map(h => ({ id: h.id, name: h.name })) });
});

/* ---------- notifications ---------- */
app.patch('/api/notifications/read', auth, (req, res) => {
  const { all, ids, hid } = req.body || {};
  const allowed = allowedHids(req.user);
  // scope every write to the hospitals this user may open
  let scope = allowed;                       // null => all hospitals
  if (hid) { scopeCheck(req, S(hid, 60)); scope = [hid]; }
  const inClause = scope ? ` AND hospital_id IN (${scope.map(() => '?').join(',')})` : '';
  const scopeArgs = scope || [];
  if (scope && !scope.length) return res.json({ ok: true });
  if (all) {
    db.prepare('UPDATE notifications SET read=1 WHERE 1=1' + inClause).run(...scopeArgs);
  } else if (Array.isArray(ids)) {
    const st = db.prepare('UPDATE notifications SET read=1 WHERE id=?' + inClause);
    for (const id of ids.slice(0, 200)) st.run(S(id, 60), ...scopeArgs);
  }
  res.json({ ok: true });
});

/* ---------- report prefs ---------- */
app.put('/api/report-prefs/:hid/:type', auth, (req, res) => {
  const { hid, type } = req.params;
  if (!['daily', 'weekly', 'monthly'].includes(type)) return res.status(400).json({ error: 'Bad report type' });
  scopeCheck(req, hid);
  const prefs = (req.body || {}).prefs;
  if (!prefs || typeof prefs !== 'object') return res.status(400).json({ error: 'Bad prefs' });
  const clean = {};
  for (const [k, v] of Object.entries(prefs).slice(0, 40)) clean[k] = !!v;
  db.prepare('INSERT INTO report_prefs(hospital_id,type,prefs) VALUES(?,?,?) ON CONFLICT(hospital_id,type) DO UPDATE SET prefs=excluded.prefs')
    .run(hid, type, JSON.stringify(clean));
  res.json({ ok: true });
});

/* ---------- user management (admin) ---------- */
app.get('/api/users', auth, requireRole('admin'), (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY created_at').all().map(rowUser) });
});

/* accepts ["*"] (every hospital) or an explicit list of existing hospital ids */
function cleanHospitalList(v) {
  if (!Array.isArray(v) || !v.length) return null;
  if (v.includes('*')) return ['*'];
  const ids = [...new Set(v.map(x => S(x, 60)))].filter(Boolean);
  if (!ids.length) return null;
  const found = db.prepare(`SELECT id FROM hospitals WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(h => h.id);
  return found.length === ids.length ? ids : null;
}
const adminCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;

app.post('/api/users', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const email = S(b.email, 200).trim().toLowerCase();
  const name = S(b.name, 120).trim();
  const role = ROLES.includes(b.role) ? b.role : null;
  if (!name || !email.includes('@') || !role) return res.status(400).json({ error: 'Name, valid email and role are required' });
  if (S(b.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const hospitals = cleanHospitalList(b.hospitals);
  if (!hospitals) return res.status(400).json({ error: 'Pick at least one hospital this user can access' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'That email already has an account' });
  const u = {
    id: uid('u'), name, email, role, role_label: ROLE_LABEL[role],
    hospital_ids: JSON.stringify(hospitals), active: b.active === false ? 0 : 1,
    pw_hash: bcrypt.hashSync(S(b.password, 200), 10), created_at: Date.now()
  };
  db.prepare('INSERT INTO users(id,name,email,role,role_label,hospital_id,hospital_ids,active,pw_hash,created_at) VALUES(?,?,?,?,?,NULL,?,?,?,?)')
    .run(u.id, u.name, u.email, u.role, u.role_label, u.hospital_ids, u.active, u.pw_hash, u.created_at);
  res.json({ user: rowUser(u) });
});

app.patch('/api/users/:id', auth, requireRole('admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  const isSelf = u.id === req.user.id;

  const name = b.name !== undefined ? S(b.name, 120).trim() || u.name : u.name;
  let role = u.role;
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
    // don't let the last admin (or yourself) drop admin rights and lock everyone out
    if (u.role === 'admin' && b.role !== 'admin') {
      if (isSelf) return res.status(400).json({ error: "You can't change your own role — ask another admin" });
      if (adminCount() <= 1) return res.status(400).json({ error: 'This is the last admin — promote someone else first' });
    }
    role = b.role;
  }
  let hospital_ids = u.hospital_ids;
  if (b.hospitals !== undefined) {
    const list = cleanHospitalList(b.hospitals);
    if (!list) return res.status(400).json({ error: 'Pick at least one hospital this user can access' });
    hospital_ids = JSON.stringify(list);
  }
  let active = u.active;
  if (b.active !== undefined) {
    const next = b.active ? 1 : 0;
    if (!next) {
      if (isSelf) return res.status(400).json({ error: "You can't turn off your own portal access" });
      if (u.role === 'admin' && adminCount() <= 1) return res.status(400).json({ error: 'This is the last active admin — promote someone else first' });
    }
    active = next;
  }
  db.prepare('UPDATE users SET name=?, role=?, role_label=?, hospital_ids=?, active=? WHERE id=?')
    .run(name, role, ROLE_LABEL[role], hospital_ids, active, u.id);
  // revoking access or changing scope must not leave a live session behind
  if (!active || hospital_ids !== u.hospital_ids || role !== u.role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  res.json({ user: rowUser({ ...u, name, role, role_label: ROLE_LABEL[role], hospital_ids, active }) });
});

app.delete('/api/users/:id', auth, requireRole('admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  if (u.role === 'admin' && adminCount() <= 1) return res.status(400).json({ error: 'This is the last admin — promote someone else first' });
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/password', auth, requireRole('admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (S((req.body || {}).password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(bcrypt.hashSync(S(req.body.password, 200), 10), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  res.json({ ok: true });
});

/* ---------- weekly / monthly period data (manual report sections) ---------- */
function deepClean(v, depth = 0) {
  if (depth > 4) return null;
  if (typeof v === 'string') return v.slice(0, 300);
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => deepClean(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 40)) o[S(k, 60)] = deepClean(v[k], depth + 1);
    return o;
  }
  return null;
}

app.put('/api/period/:hid/:ptype/:pkey', auth, (req, res) => {
  const { hid, ptype, pkey } = req.params;
  scopeCheck(req, hid);
  if (!['weekly', 'monthly'].includes(ptype)) return res.status(400).json({ error: 'Bad period type' });
  if (ptype === 'weekly' && !/^\d{4}-\d{2}-\d{2}$/.test(pkey)) return res.status(400).json({ error: 'Weekly key must be the Monday date' });
  if (ptype === 'monthly' && !/^\d{4}-\d{2}$/.test(pkey)) return res.status(400).json({ error: 'Monthly key must be YYYY-MM' });
  const data = deepClean((req.body || {}).data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Bad data payload' });
  const json = JSON.stringify(data);
  if (json.length > 100000) return res.status(400).json({ error: 'Period data too large' });
  db.prepare('INSERT INTO period_data(hospital_id,ptype,pkey,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(hospital_id,ptype,pkey) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at')
    .run(hid, ptype, pkey, json, Date.now());
  res.json({ ok: true });
});

/* ---------- item master ---------- */
app.post('/api/items', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  scopeCheck(req, S(b.hid, 60));
  const name = S(b.name, 150).trim();
  if (!name) return res.status(400).json({ error: 'Item name is required' });
  const nr = N(b.nr), mrp = N(b.mrp);
  if (nr <= 0 || mrp <= 0) return res.status(400).json({ error: 'Purchase price (NR) and MRP must be positive' });
  if (nr > mrp) return res.status(400).json({ error: 'NR cannot exceed MRP' });
  const key = nameKey(name);
  if (db.prepare('SELECT 1 FROM items WHERE hospital_id=? AND name_key=?').get(b.hid, key))
    return res.status(409).json({ error: 'That item already exists on the master' });
  const it = { id: uid('it'), hospital_id: b.hid, name, name_key: key, pack: S(b.pack, 60), nr, mrp,
    molecule: S(b.molecule, 150).trim(), source: 'manual', updated_at: Date.now() };
  db.prepare('INSERT INTO items(id,hospital_id,name,name_key,pack,nr,mrp,source,updated_at,molecule) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(it.id, it.hospital_id, it.name, it.name_key, it.pack, it.nr, it.mrp, it.source, it.updated_at, it.molecule);
  res.json({ item: rowItem(it) });
});

app.patch('/api/items/:id', auth, requireRole('admin'), (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Item not found' });
  scopeCheck(req, it.hospital_id);
  const b = req.body || {};
  const nr = b.nr !== undefined ? N(b.nr) : it.nr;
  const mrp = b.mrp !== undefined ? N(b.mrp) : it.mrp;
  if (nr <= 0 || mrp <= 0) return res.status(400).json({ error: 'NR and MRP must be positive' });
  if (nr > mrp) return res.status(400).json({ error: 'NR cannot exceed MRP' });
  /* A price change on the master is the doctor's call, not an edit (Arjun,
     Jul 22). Pack / molecule / opening stay direct edits — they describe the
     item, they do not move its money. Imports are untouched: they capture what
     already is, this guards what CHANGES. */
  if (nr !== it.nr || mrp !== it.mrp)
    return res.status(400).json({ error: "Price changes need the doctor's approval — record it as a price change on the Margin offers tab and it lands once they tap Approve", code: 'needs_approval' });
  const pack = b.pack !== undefined ? S(b.pack, 60) : it.pack;
  const molecule = b.molecule !== undefined ? S(b.molecule, 150).trim() : (it.molecule || '');
  const preferredVendor = b.preferredVendor !== undefined ? S(b.preferredVendor, 120).trim() : (it.preferred_vendor || '');
  const openingQty = b.openingQty !== undefined ? N(b.openingQty) : it.opening_qty;
  if (openingQty < 0) return res.status(400).json({ error: 'Opening quantity cannot be negative' });
  const now = Date.now();
  const tx = db.transaction(() => {
    if (nr !== it.nr || mrp !== it.mrp) {
      db.prepare('INSERT INTO price_log(id,item_id,hospital_id,old_nr,old_mrp,new_nr,new_mrp,note,user_name,ts) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(uid('pl'), it.id, it.hospital_id, it.nr, it.mrp, nr, mrp, S(b.note, 200), req.user.name, now);
    }
    db.prepare('UPDATE items SET nr=?, mrp=?, pack=?, molecule=?, preferred_vendor=?, opening_qty=?, updated_at=? WHERE id=?').run(nr, mrp, pack, molecule, preferredVendor, openingQty, now, it.id);
  });
  tx();
  res.json({ item: rowItem({ ...it, nr, mrp, pack, molecule, preferred_vendor: preferredVendor, opening_qty: openingQty, updated_at: now }) });
});

app.get('/api/items/:id/history', auth, (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Item not found' });
  scopeCheck(req, it.hospital_id);
  const rows = db.prepare('SELECT * FROM price_log WHERE item_id=? ORDER BY ts DESC LIMIT 30').all(it.id)
    .map(r => ({ oldNr: r.old_nr, oldMrp: r.old_mrp, newNr: r.new_nr, newMrp: r.new_mrp, note: r.note, user: r.user_name, ts: r.ts }));
  res.json({ history: rows });
});

/* Before saving an opening count with a date that isn't today, the modal asks
   this: is there already daily activity on/after that date? If so the count is
   about to have real purchases/sales/RTV layered on top of it, and the user
   needs to actively confirm the count really was taken before that activity —
   not just accept whatever date happened to be in the box. */
app.get('/api/items/opening/movements-after', auth, requireRole('admin'), (req, res) => {
  const hid = S(req.query.hid, 60);
  scopeCheck(req, hid);
  const date = S(req.query.date, 12);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid date is required' });
  const count = db.prepare('SELECT COUNT(*) c FROM entries WHERE hospital_id=? AND date>=?').get(hid, date).c;
  res.json({ count });
});

/* a rounding-level difference, not a real disagreement — 2% relative, with a
   small absolute floor so two near-zero rates don't trip it on noise */
const RATE_TOL = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 0.02 + 0.01;

/* The Item Master's nr/mrp for an EXISTING product is a RATCHET, never a
   continuously-recomputed average. An earlier version of this kept it
   current with the weighted average across whatever batches a product
   currently held, recomputed after every purchase, sale and adjustment —
   which meant a single worse-margin purchase would drag the master down to
   match it, and every purchase AFTER that one would then be compared
   against the already-eroded figure and pass silently. A margin check that
   moves to match whatever just happened can never catch drift.
   So: the master only ever improves automatically, and only from a
   genuinely better-margin PURCHASE LINE (see the ratchet in
   PUT /entries/:hid/:date, right where marginAlerts already compares a
   line's margin to the master's) — never from an average across several
   batches, which would just reintroduce the same erosion by another path.
   A worse price never touches the master automatically; correcting one
   deliberately still goes through the existing doctor-approval price-change
   flow (margin_offers), and every automatic improvement is visible on the
   Price History tab same as a negotiated one, tagged source='purchase-
   improved' so the two are never confused for each other. */

/* Wipes this hospital's opening batches before a CONFIRMED second load
   rewrites them from scratch — called once, before the chunked upload
   sequence begins. Never folded into an ordinary per-chunk save, which must
   never delete rows a previous chunk of the SAME load already landed. */
app.post('/api/items/opening/reset-batches', auth, requireRole('admin'), (req, res) => {
  const hid = S((req.body || {}).hid, 60);
  scopeCheck(req, hid);
  const zeroed = db.transaction(() => {
    // a product dropped entirely from the corrective file should show ZERO
    // opening qty — a real, immediate fact about what's now counted. nr/mrp
    // stay untouched: "last known price" is correct once there's nothing
    // left to weight, and the client's sync pass after this load recomputes
    // properly from whatever lots (including purchases) still remain.
    const now = Date.now();
    const affected = db.prepare('SELECT DISTINCT item_key FROM opening_batches WHERE hospital_id=?').all(hid).map(r => r.item_key);
    const zero = db.prepare('UPDATE items SET opening_qty=0, updated_at=? WHERE hospital_id=? AND name_key=?');
    const findItem = db.prepare('SELECT * FROM items WHERE hospital_id=? AND name_key=?');
    // returned so the client can zero these same items in its own local
    // mirror (db.items) — otherwise a product dropped from the corrective
    // file would keep showing its old opening qty until the next full reload
    const out = [];
    for (const key of affected) {
      zero.run(now, hid, key);
      const it = findItem.get(hid, key);
      if (it) out.push(rowItem(it));
    }
    db.prepare('DELETE FROM opening_batches WHERE hospital_id=?').run(hid);
    return out;
  })();
  res.json({ ok: true, zeroed });
});

/* Opening stock, batch-wise: the one-time (or corrected) physical count.
   Every row is its OWN lot with its own frozen cost/MRP — nothing is
   flattened or averaged at load time (that's what the OLD single-lot-per-
   item design did, and it's the actual bug this replaces). The Item Master
   (name/pack/nr/mrp) is upserted per distinct product as the quantity-
   weighted average across THAT product's current batches, computed fresh
   from opening_batches after every row lands — never a single row's value
   simply overwriting whatever was already there. */
app.post('/api/items/opening', auth, requireRole('admin'), (req, res) => {
  const { hid, stockDate, rows, fileName, source } = req.body || {};
  const h = scopeCheck(req, S(hid, 60));
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });
  /* The count date decides which movements land on top of it — a wrong date
     double-counts or drops real activity. The client always sends one; a
     silent fallback to the hospital's start date is exactly how Viraj Gastro
     got anchored to 15 Jul when the count was actually taken later. Refuse
     rather than guess. */
  if (!/^\d{4}-\d{2}-\d{2}$/.test(S(stockDate)))
    return res.status(400).json({ error: 'Stock count date is required — pick the day the shelf was physically counted' });
  const sd = stockDate;
  if (sd > todayISO()) return res.status(400).json({ error: 'Stock count date cannot be in the future' });
  const now = Date.now();
  const skipped = [], cautions = [];
  let rowsImported = 0;
  const touchedKeys = new Set();
  // batches this SAME request has itself written — the only thing that
  // distinguishes a genuine in-file duplicate (merge, summed) from a plain
  // resubmission of a batch that was already on record from an earlier,
  // separate call (an update/correction to that count, not a second lot;
  // matches how a lone paste-box correction or a direct API resubmission has
  // always behaved — it must stay idempotent, not additive)
  const touchedThisReq = new Set();
  const tx = db.transaction(() => {
    const findItem = db.prepare('SELECT * FROM items WHERE hospital_id=? AND name_key=?');
    const findBatch = db.prepare('SELECT * FROM opening_batches WHERE hospital_id=? AND item_key=? AND batch=?');
    const insBatch = db.prepare('INSERT INTO opening_batches(id,hospital_id,item_key,name,pack,batch,exp,qty,nr,mrp,stock_date,loaded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const updBatch = db.prepare('UPDATE opening_batches SET qty=?, nr=?, mrp=?, pack=?, exp=?, stock_date=?, loaded_at=? WHERE id=?');

    // captured up front — so a skipped row carries back what was actually
    // typed, not just a name and a reason, for the retry table to edit
    rows.slice(0, 5000).forEach((raw, ix) => {
      const row = raw.row ?? (ix + 1);
      const name = S(raw.name, 150).trim();
      const cells = { pack: S(raw.pack, 60).trim(), qty: N(raw.qty), nr: N(raw.nr), mrp: N(raw.mrp),
        batch: S(raw.batch, 40).trim(), exp: parseExpiryCell(raw.exp) };
      const skip = (reason) => skipped.push({ row, name, reason, ...cells });
      if (!name) { skip('no product name'); return; }
      if (cells.qty < 0) { skip('negative opening count'); return; }

      const key = nameKey(name);
      const bkey = key + '|' + cells.batch;
      const existingItem = findItem.get(hid, key);
      const existingBatch = findBatch.get(hid, key, cells.batch);

      // a row that omits its own price falls back to whatever this exact
      // batch (if it's a repeat) or the item's own known price already says
      // — never to a bare zero, and never diluting a real average with one
      const nr = cells.nr > 0 ? cells.nr : (existingBatch ? existingBatch.nr : (existingItem ? existingItem.nr : 0));
      const mrp = cells.mrp > 0 ? cells.mrp : (existingBatch ? existingBatch.mrp : (existingItem ? existingItem.mrp : 0));
      if (nr > mrp && mrp > 0) { skip('net rate would exceed the MRP — kept as it was'); return; }
      const pack = cells.pack || (existingBatch ? existingBatch.pack : (existingItem ? existingItem.pack : ''));

      if (existingBatch && touchedThisReq.has(bkey)) {
        /* same product, same batch (or both blank) as an earlier row/chunk of
           THIS load — a genuine duplicate. Merge when the rate roughly
           agrees (reported, not silent); reject outright when it disagrees
           by more than a rounding difference, rather than guessing which
           row is right and quietly averaging away a real disagreement. */
        if (!RATE_TOL(nr, existingBatch.nr) || !RATE_TOL(mrp, existingBatch.mrp)) {
          skip(`same batch already loaded for this product at a different rate (₹${existingBatch.nr} vs ₹${nr} net) — fix and re-upload`);
          return;
        }
        const mergedQty = existingBatch.qty + cells.qty;
        const mergedNr = mergedQty > 0 ? (existingBatch.qty * existingBatch.nr + cells.qty * nr) / mergedQty : nr;
        const mergedMrp = mergedQty > 0 ? (existingBatch.qty * existingBatch.mrp + cells.qty * mrp) / mergedQty : mrp;
        updBatch.run(mergedQty, mergedNr, mergedMrp, pack, cells.exp || existingBatch.exp, sd, now, existingBatch.id);
        cautions.push({ row, name, reason: cells.batch
          ? `duplicate of batch "${cells.batch}" already on this file — quantities added (${existingBatch.qty} + ${cells.qty} = ${mergedQty})`
          : `another no-batch row for this product already on file — quantities added (${existingBatch.qty} + ${cells.qty} = ${mergedQty})` });
      } else if (existingBatch) {
        // on record from an earlier, separate call (not this request) —
        // a correction to that count, so the new row's own qty REPLACES it
        updBatch.run(cells.qty, nr, mrp, pack, cells.exp || existingBatch.exp, sd, now, existingBatch.id);
      } else {
        insBatch.run(uid('opb'), hid, key, name, pack, cells.batch, cells.exp || null, cells.qty, nr, mrp, sd, now);
      }
      touchedThisReq.add(bkey);
      rowsImported++;
      touchedKeys.add(key);
    });

    // one upsert per distinct product touched, AFTER every one of its rows
    // has landed — the weighted average is across every batch the product
    // now holds, never a single row's own value
    const insItem = db.prepare('INSERT INTO items(id,hospital_id,name,name_key,pack,nr,mrp,opening_qty,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const updItem = db.prepare('UPDATE items SET opening_qty=?, pack=?, nr=?, mrp=?, updated_at=? WHERE id=?');
    const aggBatches = db.prepare('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(qty*nr),0) sn, COALESCE(SUM(qty*mrp),0) sm FROM opening_batches WHERE hospital_id=? AND item_key=?');
    const latestBatch = db.prepare('SELECT name, pack FROM opening_batches WHERE hospital_id=? AND item_key=? ORDER BY loaded_at DESC LIMIT 1');
    const batchRows = db.prepare('SELECT * FROM opening_batches WHERE hospital_id=? AND item_key=?');
    const created = [], updated = [], batches = [];
    touchedKeys.forEach(key => {
      const agg = aggBatches.get(hid, key);
      const totalQty = agg.q, avgNr = totalQty > 0 ? agg.sn / totalQty : 0, avgMrp = totalQty > 0 ? agg.sm / totalQty : 0;
      const lb = latestBatch.get(hid, key);
      const ex = findItem.get(hid, key);
      if (ex) {
        const pack = ex.pack || (lb ? lb.pack : '');
        updItem.run(totalQty, pack, avgNr, avgMrp, now, ex.id);
        updated.push(rowItem({ ...ex, opening_qty: totalQty, pack, nr: avgNr, mrp: avgMrp, updated_at: now }));
      } else {
        const it = { id: uid('it'), hospital_id: hid, name: lb.name, name_key: key, pack: lb.pack,
          nr: avgNr, mrp: avgMrp, opening_qty: totalQty, source: 'opening', updated_at: now };
        insItem.run(it.id, it.hospital_id, it.name, it.name_key, it.pack, it.nr, it.mrp, it.opening_qty, it.source, it.updated_at);
        created.push(rowItem(it));
      }
      // the client's own ledger needs these rows (not just the item-level
      // average) to build per-batch lots — returned per touched product so
      // a chunked, multi-request load can patch its local mirror incrementally
      batchRows.all(hid, key).forEach(b => batches.push(rowOpeningBatch(b)));
    });
    db.prepare('UPDATE hospitals SET stock_date=? WHERE id=?').run(sd, hid);
    return { created, updated, batches };
  });
  const { created, updated, batches } = tx();
  res.json({ created, updated, batches, batchesLoaded: rowsImported, productsTouched: touchedKeys.size,
    stockDate: sd, hospital: rowHosp({ ...h, stock_date: sd }),
    ...receiptFields({ fileName: S(fileName, 200), sheet: null, fileRows: rows.length,
      parsed: rows.length, imported: rowsImported, skipped, ignored: 0, source: S(source, 20) || 'template', cautions }) });
});

const rowOpeningLoad = (r) => ({ id: r.id, hid: r.hospital_id, stockDate: r.stock_date, itemsCount: r.items_count,
  valueNr: r.value_nr, valueMrp: r.value_mrp, fileName: r.file_name, source: r.source,
  loadedBy: r.loaded_by, loadedAt: r.loaded_at });

/* One record per logical "Save opening stock" click — a big load may take
   several /items/opening batches (chunkedSaveUI), so the client calls this
   ONCE at the end with the totals it already computed for the preview, rather
   than the server trying to stitch batches back together into one figure.
   This is the record a later question about the opening position gets
   answered from, and the check a second load warns against before overwriting
   it — never cleared by "Clear opening stock" (that resets the count itself,
   not the history of what was counted). */
app.post('/api/opening-loads', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const hid = S(b.hid, 60);
  scopeCheck(req, hid);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(S(b.stockDate))) return res.status(400).json({ error: 'A valid stock count date is required' });
  const rec = {
    id: uid('opl'), hospital_id: hid, stock_date: b.stockDate, items_count: N(b.itemsCount),
    value_nr: N(b.valueNr), value_mrp: N(b.valueMrp), file_name: S(b.fileName, 200), source: S(b.source, 20),
    loaded_by: req.user.name, loaded_at: Date.now()
  };
  db.prepare(`INSERT INTO opening_loads(id,hospital_id,stock_date,items_count,value_nr,value_mrp,file_name,source,loaded_by,loaded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(rec.id, rec.hospital_id, rec.stock_date, rec.items_count, rec.value_nr, rec.value_mrp,
    rec.file_name, rec.source, rec.loaded_by, rec.loaded_at);
  res.json({ load: rowOpeningLoad(rec) });
});

app.get('/api/opening-loads', auth, (req, res) => {
  const hid = S(req.query.hid, 60);
  scopeCheck(req, hid);
  const rows = db.prepare('SELECT * FROM opening_loads WHERE hospital_id=? ORDER BY loaded_at DESC LIMIT 20').all(hid).map(rowOpeningLoad);
  res.json({ loads: rows });
});

app.post('/api/items/bulk', auth, requireRole('admin'), (req, res) => {
  const { hid, items, fileName, sheet, fileRows, source } = req.body || {};
  scopeCheck(req, S(hid, 60));
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  const now = Date.now();
  const created = [], filled = [], skipped = [];
  const tx = db.transaction(() => {
    const find = db.prepare('SELECT * FROM items WHERE hospital_id=? AND name_key=?');
    const ins = db.prepare('INSERT INTO items(id,hospital_id,name,name_key,pack,nr,mrp,source,updated_at,molecule) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const fill = db.prepare('UPDATE items SET molecule=?, pack=?, updated_at=? WHERE id=?');
    items.slice(0, 3000).forEach((raw, ix) => {
      const row = raw.row ?? (ix + 1);
      const name = S(raw.name, 150).trim();
      // captured up front — so a skipped row carries back what was actually
      // typed, not just a name and a reason, for the retry table to edit
      const cells = { pack: S(raw.pack, 60).trim(), nr: N(raw.nr), mrp: N(raw.mrp), molecule: S(raw.molecule, 150).trim() };
      const skip = (reason) => skipped.push({ row, name, reason, ...cells });
      if (!name) { skip('no product name'); return; }
      if (cells.nr <= 0 || cells.mrp <= 0 || cells.nr > cells.mrp) { skip('net rate and MRP must be positive, and net rate cannot exceed MRP'); return; }
      const key = nameKey(name), mol = cells.molecule, pack = cells.pack;
      const ex = find.get(hid, key);
      if (ex) {
        // a re-import does not overwrite prices, but it MAY fill in a molecule
        // or pack size the master is missing (blank -> value only, a differing
        // one is never overwritten) — this is how the group comparison gets
        // populated, and how an item auto-created without a pack gets one
        const molFill = mol && !ex.molecule, packFill = pack && !ex.pack;
        if (molFill || packFill) {
          const newMol = molFill ? mol : ex.molecule, newPack = packFill ? pack : ex.pack;
          fill.run(newMol, newPack, now, ex.id);
          filled.push(rowItem({ ...ex, molecule: newMol, pack: newPack, updated_at: now }));
        } else {
          skip('already on the master — nothing new to fill');
        }
        return;
      }
      const it = { id: uid('it'), hospital_id: hid, name, name_key: key, pack, nr: cells.nr, mrp: cells.mrp, molecule: mol, source: 'import', updated_at: now };
      ins.run(it.id, it.hospital_id, it.name, it.name_key, it.pack, it.nr, it.mrp, it.source, it.updated_at, it.molecule);
      created.push(rowItem(it));
    });
  });
  tx();
  res.json({ created, filled, skipped,
    ...receiptFields({ fileName: S(fileName, 200), sheet: sheet ? S(sheet, 80) : null, fileRows: N(fileRows) || items.length,
      parsed: items.length, imported: created.length + filled.length, skipped, ignored: 0, source: S(source, 20) || 'template' }) });
});

/* XLSX of the item master — its Sheet 1 headers are the SAME ones
   templateHeaders('items') writes, so an export can be edited in Excel and fed
   straight back through the Item Master importer. This is also how a blank
   pack on an item auto-created from an invoice gets fixed: export, fill the
   gap, re-import (the bulk endpoint above fills a blank pack on re-import). */
app.post('/api/items/export', auth, (req, res) => {
  const b = req.body || {};
  scopeCheck(req, S(b.hid, 60));
  const ids = Array.isArray(b.ids) ? b.ids.map(x => S(x, 60)) : null;
  let rows = db.prepare('SELECT * FROM items WHERE hospital_id=?').all(b.hid).map(rowItem);
  if (ids) rows = rows.filter(r => ids.includes(r.id));
  rows.sort((a, z) => a.name.localeCompare(z.name));
  const today = todayISO();
  const T = TEMPLATES.items;
  const hdr = templateHeaders('items');
  const hdrOf = {}; T.cols.forEach((c, i) => { hdrOf[c] = hdr[i]; });
  const data = rows.map(r => ({
    [hdrOf.name]: r.name, [hdrOf.mol]: r.molecule || '', [hdrOf.pack]: r.pack || '',
    [hdrOf.nr]: r.nr, [hdrOf.mrp]: r.mrp
  }));
  const details = rows.map(r => ({
    'Product name': r.name, 'Opening qty': r.openingQty || 0,
    'Preferred vendor': r.preferredVendor || '', Source: r.source || '',
    'Last updated': r.updatedAt ? msToISO(r.updatedAt) : ''
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Note: 'No items on the master yet' }]), T.sheet);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(details.length ? details : [{ Note: 'No items on the master yet' }]), 'Details');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${b.hid}-item-master-${today}.xlsx"`);
  res.send(buf);
});

const rowReceipt = (r) => ({ id: r.id, kind: r.kind, fileName: r.file_name || '', sheet: r.sheet,
  fileRows: r.file_rows, parsed: r.parsed, imported: r.imported,
  skipped: JSON.parse(r.skipped || '[]'), ignored: r.ignored, source: r.source || '',
  user: r.user_name || '', at: r.created_at });

/* One row per upload, written by the client once a receipt is FINAL — after the
   save step, not right after parsing, so it reflects what actually landed, not
   just what a file preview predicted. Kept even after the dialog closes: an
   import that dropped rows stays auditable in History, not just in a toast. */
app.post('/api/import-receipts', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  scopeCheck(req, S(b.hid, 60));
  const rec = {
    id: uid('rcpt'), hospital_id: b.hid, kind: S(b.kind, 30),
    file_name: S(b.fileName, 200), sheet: b.sheet ? S(b.sheet, 80) : null,
    file_rows: N(b.fileRows), parsed: N(b.parsed), imported: N(b.imported),
    skipped: JSON.stringify((Array.isArray(b.skipped) ? b.skipped : []).slice(0, 2000)),
    ignored: N(b.ignored), source: S(b.source, 20), user_name: req.user.name, created_at: Date.now()
  };
  db.prepare('INSERT INTO import_receipts(id,hospital_id,kind,file_name,sheet,file_rows,parsed,imported,skipped,ignored,source,user_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(rec.id, rec.hospital_id, rec.kind, rec.file_name, rec.sheet, rec.file_rows, rec.parsed, rec.imported, rec.skipped, rec.ignored, rec.source, rec.user_name, rec.created_at);
  // keep the last 50 per hospital — plenty of headroom over the 20 the UI shows
  db.prepare(`DELETE FROM import_receipts WHERE hospital_id=? AND id NOT IN
    (SELECT id FROM import_receipts WHERE hospital_id=? ORDER BY created_at DESC LIMIT 50)`).run(b.hid, b.hid);
  res.json({ receipt: rowReceipt(rec) });
});

app.get('/api/import-receipts', auth, requireRole('admin'), (req, res) => {
  const hid = S(req.query.hid, 60);
  scopeCheck(req, hid);
  const rows = db.prepare('SELECT * FROM import_receipts WHERE hospital_id=? ORDER BY created_at DESC LIMIT 20').all(hid).map(rowReceipt);
  res.json({ receipts: rows });
});

/* a not-imported row's ORIGINAL values, mapped back onto this template's own
   column key — so "download not-imported rows" hands back a sheet the user
   can fix in place and re-upload directly, not a bare list of names. Values
   readTemplate never had a chance to capture come back blank for the user to
   re-key. */
function skipCellValue(kind, s, colKey) {
  switch (colKey) {
    case 'name': return s.name || '';
    case 'pack': return s.pack || '';
    case 'mol': return s.molecule || '';
    case 'nr': return s.nr ?? '';
    case 'mrp': return s.mrp ?? '';
    case 'pqty': return s.pqty ?? '';
    case 'oqty': return s.oqty ?? '';
    case 'rate': return s.rate ?? '';
    case 'disc': return s.disc ?? '';
    case 'gst': return s.gst ?? '';
    case 'qty': return (kind === 'sales' || kind === 'opening') ? (s.qty ?? '') : '';
    case 'open': return s.qty ?? '';
    case 'qtyTab': return kind === 'sales' ? (s.loose ?? '') : '';
    case 'openTab': return kind === 'opening' ? (s.loose ?? '') : '';
    default: return '';
  }
}
/* Read-only: rebuilds a sheet in the SAME shape as the upload template, one row
   per skipped item, pre-filled with whatever was captured plus a Reason column
   — so fixing the flagged cell and re-uploading the SAME file format works. */
app.post('/api/import-receipts/not-imported', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const kind = S(b.kind, 30);
  const T = TEMPLATES[kind];
  if (!T) return res.status(400).json({ error: 'This upload has no fixed template shape to rebuild' });
  const skipped = Array.isArray(b.skipped) ? b.skipped.slice(0, 5000) : [];
  const hdr = templateHeaders(kind);
  const data = skipped.map(s => {
    const obj = {};
    T.cols.forEach((c, i) => { obj[hdr[i]] = skipCellValue(kind, s, c); });
    obj['Row in the original file'] = s.row ?? '';
    obj.Reason = s.reason || '';
    return obj;
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Note: 'Nothing was skipped' }]), T.sheet);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${kind}-not-imported-${todayISO()}.xlsx"`);
  res.send(buf);
});

/* ---------- receivables ---------- */
const recvActions = (rid) => db.prepare('SELECT * FROM receivable_actions WHERE receivable_id=? ORDER BY action_date, entered_at').all(rid);
function loadRecv(req, id) {
  const r = db.prepare('SELECT * FROM receivables WHERE id=?').get(id);
  if (!r) { const e = new Error('Bill not found'); e.status = 404; throw e; }
  scopeCheck(req, r.hospital_id);
  return r;
}
function pushAction(a) {
  db.prepare('INSERT INTO receivable_actions(id,receivable_id,hospital_id,type,amount,mode,reason,approver_id,approver_name,action_date,entered_by,entered_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(a.id, a.receivable_id, a.hospital_id, a.type, a.amount, a.mode, a.reason, a.approver_id, a.approver_name, a.action_date, a.entered_by, a.entered_at);
}
/* an action can never predate the bill or land in the future */
function checkActionDate(d, billDate) {
  const today = todayISO();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(S(d)) ? d : today;
  if (date > today) { const e = new Error('Action date cannot be in the future'); e.status = 400; throw e; }
  if (date < billDate) { const e = new Error(`Action date cannot be before the bill date (${billDate})`); e.status = 400; throw e; }
  return date;
}

app.post('/api/receivables', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  scopeCheck(req, S(b.hid, 60));
  const billNo = S(b.billNo, 60).trim(), party = S(b.party, 150).trim();
  if (!billNo) return res.status(400).json({ error: 'Bill number is required' });
  if (!party) return res.status(400).json({ error: 'Party name is required' });
  if (!PARTY_TYPES.some(p => p.v === b.partyType)) return res.status(400).json({ error: 'Choose a valid party type' });
  const amount = N(b.amount);
  if (amount <= 0) return res.status(400).json({ error: 'Bill amount must be positive' });
  const billDate = /^\d{4}-\d{2}-\d{2}$/.test(S(b.billDate)) ? b.billDate : todayISO();
  if (billDate > todayISO()) return res.status(400).json({ error: 'Bill date cannot be in the future' });
  if (db.prepare('SELECT 1 FROM receivables WHERE hospital_id=? AND bill_no=?').get(b.hid, billNo))
    return res.status(409).json({ error: 'That bill number already exists for this hospital' });
  const r = {
    id: uid('rcv'), hospital_id: b.hid, bill_no: billNo, bill_date: billDate, party, party_type: b.partyType,
    amount, next_follow_up_date: null, assigned_to: S(b.assignedTo, 120) || null,
    priority: b.priority === 'high' ? 'high' : 'normal',
    ov_value: null, ov_reason: null, ov_by: null, ov_at: null, ov_expires: null,
    created_by: req.user.name, created_at: Date.now()
  };
  db.prepare('INSERT INTO receivables(id,hospital_id,bill_no,bill_date,party,party_type,amount,next_follow_up_date,assigned_to,priority,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.hospital_id, r.bill_no, r.bill_date, r.party, r.party_type, r.amount, r.next_follow_up_date, r.assigned_to, r.priority, r.created_by, r.created_at);
  res.json({ receivable: rowRecv(r, [], todayISO()), actions: [] });
});

/* Money only ever moves through an action. */
app.post('/api/receivables/:id/actions', auth, (req, res, next) => {
  try {
    const b = req.body || {};
    const r = loadRecv(req, req.params.id);
    const today = todayISO();
    const type = S(b.type, 30);
    if (!['receipt', 'adjustment', 'follow_up', 'note'].includes(type))
      return res.status(400).json({ error: 'Unknown action type' });
    // a data-entry user chases the money; they never record it moving
    if ((type === 'receipt' || type === 'adjustment') && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Only an admin can record receipts and adjustments' });
    const date = checkActionDate(b.date, r.bill_date);
    const cur = recvTotals(r, recvActions(r.id));
    const a = {
      id: uid('act'), receivable_id: r.id, hospital_id: r.hospital_id, type,
      amount: null, mode: null, reason: S(b.reason, 300), approver_id: null, approver_name: null,
      action_date: date, entered_by: req.user.name, entered_at: Date.now()
    };

    if (type === 'receipt') {
      const amt = N(b.amount);
      if (amt <= 0) return res.status(400).json({ error: 'Receipt must be more than zero' });
      if (amt > cur.due + 1e-9) return res.status(400).json({ error: `Receipt cannot exceed the amount due (${fmtRs(cur.due)})` });
      if (!RECEIPT_MODES.includes(b.mode)) return res.status(400).json({ error: 'Choose how the money came in (Cash / UPI / Cheque / NEFT)' });
      a.amount = amt; a.mode = b.mode;
    } else if (type === 'adjustment') {
      const amt = N(b.amount);
      if (!amt) return res.status(400).json({ error: 'Adjustment cannot be zero' });
      if (!a.reason || a.reason.length < 3) return res.status(400).json({ error: 'An adjustment needs a reason' });
      if (cur.due + amt < -1e-9) return res.status(400).json({ error: `That would drive the amount due below zero (due is ${fmtRs(cur.due)})` });
      a.amount = amt;
      /* Over the threshold the approver is NAMED on the action. It is no longer a
         gate: with two roles, everyone who can adjust at all is an admin, so a
         403 here could never fire. What still matters — and what an audit asks —
         is who signed off on a write-off big enough to matter. */
      if (Math.abs(amt) > ADJ_THRESHOLD) { a.approver_id = req.user.id; a.approver_name = req.user.name; }
    } else if (type === 'follow_up') {
      const nf = S(b.nextFollowUp, 12);
      if (nf && !/^\d{4}-\d{2}-\d{2}$/.test(nf)) return res.status(400).json({ error: 'Bad follow-up date' });
      db.prepare('UPDATE receivables SET next_follow_up_date=? WHERE id=?').run(nf || null, r.id);
      r.next_follow_up_date = nf || null;
    }
    pushAction(a);
    const acts = recvActions(r.id);
    res.json({ receivable: rowRecv(r, acts, today), actions: acts.map(rowAction), action: rowAction(a) });
  } catch (err) { next(err); }
});

/* Override: explains why a bill is old. Admin-only, reasoned, and it expires. */
app.post('/api/receivables/:id/override', auth, requireRole('admin'), (req, res, next) => {
  try {
    const b = req.body || {};
    const r = loadRecv(req, req.params.id);
    const today = todayISO();
    if (!OVERRIDE_VALUES.includes(b.value)) return res.status(400).json({ error: 'Choose a valid override' });
    const reason = S(b.reason, 300).trim();
    if (reason.length < 10) return res.status(400).json({ error: 'Override reason must be at least 10 characters — say why this bill is being held' });
    const setAt = Date.now();
    const def = addDaysISO(today, OVERRIDE_DEFAULT_DAYS);
    const expires = /^\d{4}-\d{2}-\d{2}$/.test(S(b.expiresAt)) ? b.expiresAt : def;
    if (expires <= today) return res.status(400).json({ error: 'Override must expire in the future' });
    if (expires > addDaysISO(today, OVERRIDE_MAX_DAYS)) return res.status(400).json({ error: `An override can run for at most ${OVERRIDE_MAX_DAYS} days` });
    db.prepare('UPDATE receivables SET ov_value=?, ov_reason=?, ov_by=?, ov_at=?, ov_expires=? WHERE id=?')
      .run(b.value, reason, req.user.name, setAt, expires, r.id);
    Object.assign(r, { ov_value: b.value, ov_reason: reason, ov_by: req.user.name, ov_at: setAt, ov_expires: expires });
    pushAction({
      id: uid('act'), receivable_id: r.id, hospital_id: r.hospital_id, type: 'override_set',
      amount: null, mode: null, reason: `${b.value}: ${reason} (until ${expires})`,
      approver_id: req.user.id, approver_name: req.user.name,
      action_date: today, entered_by: req.user.name, entered_at: setAt
    });
    const acts = recvActions(r.id);
    res.json({ receivable: rowRecv(r, acts, today), actions: acts.map(rowAction) });
  } catch (err) { next(err); }
});

/* Clearing writes an override_cleared action — the override_set stays on the log. */
app.delete('/api/receivables/:id/override', auth, requireRole('admin'), (req, res, next) => {
  try {
    const r = loadRecv(req, req.params.id);
    if (!r.ov_value) return res.status(400).json({ error: 'No override to clear' });
    const today = todayISO();
    db.prepare('UPDATE receivables SET ov_value=NULL, ov_reason=NULL, ov_by=NULL, ov_at=NULL, ov_expires=NULL WHERE id=?').run(r.id);
    pushAction({
      id: uid('act'), receivable_id: r.id, hospital_id: r.hospital_id, type: 'override_cleared',
      amount: null, mode: null, reason: S((req.body || {}).reason, 300) || `Cleared "${r.ov_value}"`,
      approver_id: req.user.id, approver_name: req.user.name,
      action_date: today, entered_by: req.user.name, entered_at: Date.now()
    });
    Object.assign(r, { ov_value: null, ov_reason: null, ov_by: null, ov_at: null, ov_expires: null });
    const acts = recvActions(r.id);
    res.json({ receivable: rowRecv(r, acts, today), actions: acts.map(rowAction) });
  } catch (err) { next(err); }
});

/* Bulk is deliberately limited to assignment and follow-up dates —
   money never moves in bulk. */
app.patch('/api/receivables/bulk', auth, (req, res) => {
  const b = req.body || {};
  scopeCheck(req, S(b.hid, 60));
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500).map(x => S(x, 60)) : [];
  if (!ids.length) return res.status(400).json({ error: 'No bills selected' });
  const sets = [], args = [];
  if (b.assignedTo !== undefined) { sets.push('assigned_to=?'); args.push(S(b.assignedTo, 120) || null); }
  if (b.nextFollowUp !== undefined) {
    const nf = S(b.nextFollowUp, 12);
    if (nf && !/^\d{4}-\d{2}-\d{2}$/.test(nf)) return res.status(400).json({ error: 'Bad follow-up date' });
    sets.push('next_follow_up_date=?'); args.push(nf || null);
  }
  if (b.priority !== undefined) { sets.push('priority=?'); args.push(b.priority === 'high' ? 'high' : 'normal'); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  const today = todayISO();
  const out = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const r = db.prepare('SELECT * FROM receivables WHERE id=? AND hospital_id=?').get(id, b.hid);
      if (!r) continue;
      db.prepare(`UPDATE receivables SET ${sets.join(', ')} WHERE id=?`).run(...args, id);
      const fresh = db.prepare('SELECT * FROM receivables WHERE id=?').get(id);
      out.push(rowRecv(fresh, recvActions(id), today));
    }
  });
  tx();
  res.json({ updated: out });
});

/* XLSX of exactly what the user is looking at */
app.post('/api/receivables/export', auth, (req, res) => {
  const b = req.body || {};
  scopeCheck(req, S(b.hid, 60));
  const today = todayISO();
  const ids = Array.isArray(b.ids) ? b.ids.map(x => S(x, 60)) : null;
  let rows = db.prepare('SELECT * FROM receivables WHERE hospital_id=?').all(b.hid);
  if (ids) rows = rows.filter(r => ids.includes(r.id));
  const data = rows.map(r => rowRecv(r, recvActions(r.id), today)).sort((a, z) => z.due - a.due).map(r => ({
    'Bill No': r.billNo, 'Bill Date': r.billDate, Party: r.party, 'Party Type': r.partyType,
    'Bill Amount': r.amount, Received: r.received, Adjustments: r.adjustments, 'Amount Due': r.due,
    'Days Outstanding': r.daysOutstanding, 'Credit Days': r.creditDays,
    Status: r.effectiveStatus, Overridden: r.override ? 'Yes' : 'No',
    'Override Reason': r.override ? r.override.reason : '', 'Override Expires': r.override ? r.override.expiresAt : '',
    'Assigned To': r.assignedTo || '', 'Next Follow-up': r.nextFollowUp || '', Priority: r.priority
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Note: 'No receivables match this view' }]), 'Receivables');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${b.hid}-receivables-${today}.xlsx"`);
  res.send(buf);
});

/* ---------- stock adjustments ----------
   Restricted to admin on purpose: if a data-entry user could silently
   adjust stock to make it balance, the audit would be worthless. */
app.post('/api/stock/adjust', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const h = scopeCheck(req, S(b.hid, 60));
  const item = S(b.item, 150).trim();
  if (!item) return res.status(400).json({ error: 'Pick an item to adjust' });
  const qty = N(b.qty);
  if (!qty) return res.status(400).json({ error: 'Adjustment quantity cannot be zero' });
  const reason = ADJ_REASONS.includes(b.reason) ? b.reason : null;
  if (!reason) return res.status(400).json({ error: 'Choose a reason for the adjustment' });
  const today = todayISO();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(S(b.date)) ? b.date : today;
  if (date > today) return res.status(400).json({ error: 'Adjustment date cannot be in the future' });
  const from = h.stock_date || h.start_date;
  if (from && date < from) return res.status(400).json({ error: `Adjustment must be on or after the stock count date (${from})` });

  const a = {
    id: uid('adj'), hospital_id: h.id, item_key: nameKey(item), item_name: item,
    date, qty, reason, note: S(b.note, 200), user_name: req.user.name, created_at: Date.now()
  };
  db.prepare('INSERT INTO stock_adjustments(id,hospital_id,item_key,item_name,date,qty,reason,note,user_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(a.id, a.hospital_id, a.item_key, a.item_name, a.date, a.qty, a.reason, a.note, a.user_name, a.created_at);
  res.json({ adjustment: rowAdj(a) });
});

/* reversal is admin-only, and deletes the record rather than editing it —
   an adjustment history that can be rewritten is not an audit trail */
app.delete('/api/stock/adjust/:id', auth, requireRole('admin'), (req, res) => {
  const a = db.prepare('SELECT * FROM stock_adjustments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Adjustment not found' });
  scopeCheck(req, a.hospital_id);
  db.prepare('DELETE FROM stock_adjustments WHERE id=?').run(a.id);
  res.json({ ok: true });
});

/* ---------- AI parsing: invoices & Marg GP reports ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
let anthropic = null;
function getAI() {
  if (!process.env.ANTHROPIC_API_KEY) { const e = new Error('AI parsing is not configured yet — add ANTHROPIC_API_KEY to /root/yajna-pharma/.env and restart'); e.status = 503; throw e; }
  if (!anthropic) anthropic = new Anthropic();
  return anthropic;
}

const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    vendor: { type: 'string', description: 'Supplier/distributor name printed on the invoice' },
    invoice_no: { type: 'string' },
    date: { type: 'string', description: 'Invoice date as YYYY-MM-DD, empty string if unreadable' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Product name exactly as printed, with strength/pack e.g. "Tab. Pantoprazole 40"' },
          qty: { type: 'number', description: 'Quantity in saleable units (strips/vials/bottles). Include free/scheme quantity.' },
          nr: { type: 'number', description: 'Net rate per unit INCLUSIVE of GST, after discount. If the invoice shows a GST-exclusive rate, add the GST percentage to compute this.' },
          mrp: { type: 'number', description: 'MRP per unit as printed' },
          value: { type: 'number', description: 'Line total = qty x nr (GST-inclusive)' }
        },
        required: ['item', 'qty', 'nr', 'mrp', 'value'],
        additionalProperties: false
      }
    }
  },
  required: ['vendor', 'invoice_no', 'date', 'lines'],
  additionalProperties: false
};

const GP_SCHEMA = {
  type: 'object',
  properties: {
    sales_mrp: { type: 'number', description: 'Total sales at MRP / total sale amount for the day. 0 if not found.' },
    cogs: { type: 'number', description: 'Total cost of goods sold / purchase cost of items sold. If only gross profit is given, cogs = sales - gross profit. 0 if not derivable.' },
    cash_sales: { type: 'number', description: 'Cash sales portion, 0 if not present' },
    credit_sales: { type: 'number', description: 'Credit/insurance sales portion, 0 if not present' },
    gross_profit: { type: 'number', description: 'Gross profit figure if stated, else sales - cogs, else 0' },
    items: {
      type: 'array',
      description: 'Item-wise sales rows if the report lists individual products. Up to 150 rows, largest sale amount first. Empty array if the report only has bill-wise rows or totals.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product name as printed' },
          qty: { type: 'number', description: 'Quantity sold in units' },
          amount: { type: 'number', description: 'Sale amount (MRP value) for this item' }
        },
        required: ['name', 'qty', 'amount'],
        additionalProperties: false
      }
    },
    note: { type: 'string', description: 'One line: what totals row/columns you used' }
  },
  required: ['sales_mrp', 'cogs', 'cash_sales', 'credit_sales', 'gross_profit', 'items', 'note'],
  additionalProperties: false
};

const EXPIRY_SCHEMA = {
  type: 'object',
  properties: {
    as_of: { type: 'string', description: 'The date this stock report refers to, as YYYY-MM-DD. Empty string if not printed.' },
    note: { type: 'string', description: 'One short line on what was read, or any problem with the file.' },
    rows: {
      type: 'array',
      description: 'Every batch line in the report. One row per item+batch. Skip group headers and total rows.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product name exactly as printed, including strength' },
          batch: { type: 'string', description: 'Batch number exactly as printed, else empty string' },
          expiry: { type: 'string', description: 'Expiry as YYYY-MM. Indian reports print MM/YY, MM/YYYY, MM-YY or similar — convert. Empty string if not printed.' },
          qty: { type: 'number', description: 'Closing/balance quantity of THIS batch, in saleable units' },
          nr: { type: 'number', description: 'Purchase/cost rate per unit INCLUSIVE of GST if printed, else 0' },
          mrp: { type: 'number', description: 'MRP per unit as printed on this batch, else 0' }
        },
        required: ['name', 'batch', 'expiry', 'qty', 'nr', 'mrp'],
        additionalProperties: false
      }
    }
  },
  required: ['as_of', 'note', 'rows'],
  additionalProperties: false
};

const STOCK_SCHEMA = {
  type: 'object',
  properties: {
    stock_date: { type: 'string', description: 'The date this stock count / report refers to, as YYYY-MM-DD. Empty string if not printed.' },
    items: {
      type: 'array',
      description: 'Every stock line in the report. Skip group headers and total rows.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product name exactly as printed, including strength' },
          qty: { type: 'number', description: 'Closing/balance quantity in stock, in saleable units' },
          pack: { type: 'string', description: 'Pack size if printed (e.g. "10s", "vial"), else empty string' },
          nr: { type: 'number', description: 'Purchase/cost rate per unit INCLUSIVE of GST if printed, else 0' },
          mrp: { type: 'number', description: 'MRP per unit if printed, else 0' }
        },
        required: ['name', 'qty', 'pack', 'nr', 'mrp'],
        additionalProperties: false
      }
    },
    note: { type: 'string', description: 'One line: which columns you read qty/rate/MRP from' }
  },
  required: ['stock_date', 'items', 'note'],
  additionalProperties: false
};

async function askClaude(content, schema) {
  const client = getAI();
  const resp = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }]
  });
  if (resp.stop_reason === 'refusal') { const e = new Error('The AI declined to process this file'); e.status = 422; throw e; }
  if (resp.stop_reason === 'max_tokens') { const e = new Error('File too large/complex to parse in one pass — split it and retry'); e.status = 422; throw e; }
  const text = (resp.content || []).find(b => b.type === 'text');
  if (!text) { const e = new Error('AI returned no result'); e.status = 502; throw e; }
  return JSON.parse(text.text);
}

function fileBlock(file) {
  const mt = (file.mimetype || '').toLowerCase();
  const b64 = file.buffer.toString('base64');
  if (mt === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mt)) return { type: 'image', source: { type: 'base64', media_type: mt, data: b64 } };
  return null;
}

app.post('/api/parse/invoice', auth, upload.single('file'), async (req, res, next) => {
  try {
    const hid = S(req.query.hid, 60);
    scopeCheck(req, hid);
    if (!req.file) return res.status(400).json({ error: 'Attach an invoice file (PDF or photo)' });
    const block = fileBlock(req.file);
    if (!block) return res.status(400).json({ error: 'Unsupported file type — upload a PDF or JPG/PNG photo of the invoice' });

    const data = await askClaude([
      block,
      { type: 'text', text: 'This is a pharmaceutical wholesale purchase invoice from an Indian distributor to a hospital pharmacy. Extract the vendor, invoice number, date and every product line. NR means the net landed cost per saleable unit INCLUSIVE of GST and after any discount — compute it from rate + GST% if the invoice lists pre-GST rates. Skip summary/total rows. Amounts are in rupees; output plain numbers.' }
    ], INVOICE_SCHEMA);

    // persist the original for the audit trail
    const dir = path.join(__dirname, 'data', 'uploads', hid);
    fs.mkdirSync(dir, { recursive: true });
    const safe = (req.file.originalname || 'invoice').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const fileName = Date.now() + '-' + safe;
    fs.writeFileSync(path.join(dir, fileName), req.file.buffer);

    // enrich lines with margin comparison against the item master
    const find = db.prepare('SELECT * FROM items WHERE hospital_id=? AND name_key=?');
    const rawLines = (data.lines || []).slice(0, 200).map((l, ix) => ({ row: ix + 1, item: S(l.item, 150), qty: N(l.qty), nr: N(l.nr), mrp: N(l.mrp), value: N(l.value) }));
    const skipped = [];
    const lines = rawLines.filter(l => {
      if (!l.item) { skipped.push({ row: l.row, name: '', reason: 'no product name' }); return false; }
      return true;
    }).map(l => {
      const master = find.get(hid, nameKey(l.item));
      const given = marginPct(l.nr, l.mrp);
      const expected = master ? marginPct(master.nr, master.mrp) : null;
      return {
        item: l.item, qty: l.qty, nr: l.nr, mrp: l.mrp, value: l.value || +(l.qty * l.nr).toFixed(2),
        givenMargin: +given.toFixed(1),
        expectedMargin: expected == null ? null : +expected.toFixed(1),
        status: master ? (Math.abs(given - expected) <= MARGIN_TOL ? 'match' : (given < expected ? 'low' : 'high')) : 'new'
      };
    });
    res.json({ vendor: S(data.vendor, 120), invoiceNo: S(data.invoice_no, 60), date: S(data.date, 12), fileName, lines,
      ...receiptFields({ fileName: req.file.originalname, sheet: null, fileRows: rawLines.length,
        parsed: lines.length, imported: lines.length, skipped, ignored: 0, source: 'ai' }) });
  } catch (err) { next(err); }
});

/* ---------- the upload templates ----------
   Three fixed shapes we hand out — sales, opening stock, item master. Each is
   read by matching column HEADINGS, so a filled sheet needs no AI to interpret:
   deterministic, instant, and it cannot misread a number. Columns may be in any
   order and common Marg spellings are accepted; only the headings must survive.

   ONE UNIT THROUGHOUT: a STRIP. Quantities are counts of strips whatever the
   strip contains, and both rates are for ONE strip. The headings say so out
   loud, because the single most expensive mistake here is keying tablets into a
   column the rest of the app reads as strips.

   ⚠️ Margin % is a RATIO — (MRP − net rate) ÷ MRP — so the pack size never
   enters it. Pack is captured so inventory and the master know what one unit IS
   (a 10s strip is not a 15s strip), and because value totals are qty × rate. */
const COL = {
  name: { hdr: 'Product name',                          match: [/^product/i, /^item/i, /^name/i, /^description/i, /^particular/i, /vendor/i, /supplier/i] },
  pack: { hdr: 'Pack size (10s / 15s)',                 match: [/^pack/i, /^strip *size/i, /^unit/i, /^conv/i] },
  /* the STRIP matchers must never swallow a "(tablets)" heading — the tablet
     keys sit after them in cols order, so a claimed heading never reaches them */
  qty:  { hdr: 'Qty sold (strips)',                     match: [/^(?!.*tablets?)qty/i, /^(?!.*tablets?)quantity/i, /^(?!.*tablets?)sold/i, /^strips? *(sold|count)/i, /^(?!.*tablets?)nos/i] },
  open: { hdr: 'Opening stock (strips)',                match: [/^(?!.*tablets?)opening/i, /^(?!.*tablets?)stock/i, /^(?!.*tablets?)balance/i, /^(?!.*tablets?)qty/i, /^(?!.*tablets?)quantity/i, /^(?!.*tablets?)closing/i] },
  qtyTab:  { hdr: 'Qty sold (tablets)',       match: [/^qty.*tab/i, /tablets?/i] },
  openTab: { hdr: 'Opening stock (tablets)',  match: [/^opening.*tab/i, /tablets?/i] },
  nr:   { hdr: 'Net rate — single strip (incl. GST)',   match: [/net *rate/i, /^cost/i, /purchase *rate/i, /^p\.?rate/i, /^ptr/i, /^rate$/i] },
  mol:  { hdr: 'Molecule / salt', match: [/^molecule/i, /^salt/i, /^generic/i, /composition/i, /^content/i] },
  pqty: { hdr: 'Purchase Qty (strips)', match: [/purchase *qty/i, /^qty/i, /billed/i] },
  oqty: { hdr: 'Offer Qty (free / scheme)', match: [/offer/i, /free/i, /scheme/i] },
  rate: { hdr: 'Rate ₹ (per strip, pre-disc/tax)', match: [/^rate/i, /^p\.? *rate/i, /^price/i] },
  disc: { hdr: 'Vendor Disc %', match: [/disc/i] },
  gst:  { hdr: 'GST %', match: [/^gst/i, /^tax/i] },
  mrp:  { hdr: 'MRP — single strip',                    match: [/^mrp/i, /^m\.r\.p/i, /retail/i, /^sale *rate/i] },
  bal:  { hdr: 'Opening Balance (Rs.) — end with Cr or Dr', match: [/open.*bal/i, /^balance/i, /outstanding/i, /^amount/i, /\bdue\b/i] },
  credit: { hdr: 'Credit Days', match: [/credit/i] },
  phone: { hdr: 'Phone', match: [/phone/i, /mobile/i, /contact/i] },
  batch: { hdr: 'Batch No.', match: [/^batch/i, /^lot *no/i, /^lot$/i] },
  exp:  { hdr: 'Expiry (MM-YYYY)', match: [/^exp/i, /expiry/i, /expires?/i, /best *before/i] }
};
/* Marg exports a vendor ledger balance with a trailing Cr/Dr rather than a
   sign: Cr is the ordinary case (a payable — we owe them), entered positive;
   Dr is the reverse (an advance or credit note in our favour), entered
   negative. Indian exports also comma-group in lakhs ("1,25,000"), which
   parseFloat alone would silently truncate at the first comma — so commas are
   always stripped before parsing, never left for the number parser to trip
   over. A value that isn't a plain number once the suffix and separators are
   gone is refused outright rather than guessed at. Mirrored client-side. */
function parseVendorBalance(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: 0 };
  const m = s.match(/^[₹Rs.\s]*(-?[\d,]+(?:\.\d+)?)\s*(cr|dr)?\.?\s*$/i);
  if (!m) return { ok: false, value: 0 };
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return { ok: false, value: 0 };
  const suffix = (m[2] || '').toLowerCase();
  if (suffix === 'cr') return { ok: true, value: Math.abs(n) };
  if (suffix === 'dr') return { ok: true, value: -Math.abs(n) };
  return { ok: true, value: n };
}
/* mirror of the client helper: the strip size out of the pack string; null for
   vial / btl / amp — nothing to divide by */
function packUnits(pack) {
  const m = String(pack || '').match(/\d+/);
  const u = m ? parseInt(m[0], 10) : 0;
  return u >= 1 ? u : null;
}

const TEMPLATES = {
  sales: {
    file: 'yajna-sales-margin-template.xlsx', sheet: 'Sales',
    cols: ['name', 'pack', 'qty', 'qtyTab', 'nr', 'mrp', 'batch'],
    need: ['name', ['qty', 'qtyTab'], 'mrp'],
    /* full strips AND loose tablets are ADDITIVE — both columns filled is the
       normal way to count a part strip (2 strips + 5 loose of a 10s = 2.5),
       not an either/or choice. Either column alone still works on its own. */
    helpers: [
      { after: 'qtyTab', hdr: '» Total strips (auto — do not fill)' },
      { after: 'mrp', hdr: '» Rate per piece (auto, display only)' },
      { after: 'mrp', hdr: '» MRP per piece (auto, display only)' },
      { after: 'mrp', hdr: '» Sale value at MRP (auto)' },
      { after: 'mrp', hdr: '» Cost of goods sold (auto)' },
      { after: 'mrp', hdr: '» Margin ₹ (auto)' },
      { after: 'mrp', hdr: '» Margin % (auto)' }
    ],
    eg: [
      ['Tab. Rifaximin 550', '10s', 12, '', 12, 298, 412, 29.8, 41.2, 4944, 3576, 1368, 27.67, 'B2201'],
      ['Tab. Sample Combo 10', '10s', 2, 5, 2.5, 759.25, 999, 75.925, 99.9, 2497.5, 1898.125, 599.375, 24.0, ''],
      ['Tab. Metformin 500', '15s', '', 75, 5, 12, 21, 0.8, 1.4, 105, 60, 45, 42.86, ''],
      ['Inj. Pantoprazole 40', 'vial', 8, '', 8, 38, 58, '', '', 464, 304, 160, 34.48, 'B2210']
    ],
    notes: [
      ['Qty sold — full strips AND/OR loose tablets', 'Fill full strips, loose tablets, or BOTH per row — they ADD UP (2 strips + 5 loose of a 10s = 2.5 strips). Loose tablets alone are divided by the pack size (75 tablets of a 15s = 5 strips). Loose tablets need a numeric pack — a vial has no strip size to divide by.'],
      ['Net rate — single strip', 'What ONE strip cost you, INCLUSIVE of GST. The same basis the purchase entry uses.'],
      ['MRP — single strip', 'The printed MRP of ONE strip.'],
      ['Rate / MRP per piece', 'The single-strip rate divided by the pack size — DISPLAY ONLY, so you can sanity-check a part-strip row. Never a second costing basis.'],
      ['What you get back', 'Sale value = Total strips × MRP. Cost of goods sold = Total strips × Net rate. Margin % = (MRP − Net rate) ÷ MRP — a ratio, unchanged by part strips.'],
      ['Batch (optional)', 'If the Marg report shows which batch was actually billed, put it here — the sale draws down THAT exact batch instead of guessing. Leave blank and the app falls back to first-expiry-first-out, same as always. A batch that does not exist, or does not have enough left, is reported rather than silently substituted.']
    ]
  },
  opening: {
    file: 'yajna-opening-stock-template.xlsx', sheet: 'Opening stock',
    cols: ['name', 'pack', 'open', 'openTab', 'nr', 'mrp', 'batch', 'exp'],
    need: ['name', 'open'],
    helpers: [
      { after: 'openTab', hdr: '» Total strips (auto — do not fill)' },
      { after: 'mrp', hdr: '» Rate per piece (auto, display only)' },
      { after: 'mrp', hdr: '» MRP per piece (auto, display only)' },
      { after: 'mrp', hdr: '» Value at cost (auto)' },
      { after: 'mrp', hdr: '» Value at MRP (auto)' }
    ],
    eg: [
      ['Tab. Rifaximin 550', '10s', 120, '', 120, 298, 412, 29.8, 41.2, 35760, 49440, 'B2318', '2027-06'],
      ['Tab. Sample Combo 10', '10s', 10, 3, 10.3, 759.25, 999, 75.925, 99.9, 7820.275, 10289.7, '', ''],
      ['Tab. Metformin 500', '15s', '', 4500, 300, 12, 21, 0.8, 1.4, 3600, 6300, 'B2402', '2028-01'],
      ['Inj. Pantoprazole 40', 'vial', 45, '', 45, 38, 58, '', '', 1710, 2610, '', '']
    ],
    notes: [
      ['Opening stock — full strips AND/OR loose tablets', 'Count the shelf however it sits: full strips, loose tablets, or BOTH per row — they ADD UP (10 strips + 3 loose of a 10s = 10.3). Loose tablets alone are divided by the pack size (4500 tablets of a 15s = 300 strips). Loose tablets need a numeric pack — a vial has no strip size to divide by.'],
      ['Net rate — single strip', 'What ONE strip cost, INCLUSIVE of GST. This is what the stock is VALUED at.'],
      ['MRP — single strip', 'The printed MRP of ONE strip.'],
      ['Rate / MRP per piece', 'The single-strip rate divided by the pack size — DISPLAY ONLY, so a part strip like 10.3 still checks out at a glance. Never a second costing basis.'],
      ['What you get back', 'Stock value at net rate = Total strips × net rate. Value at MRP = Total strips × MRP. Potential margin, the item table and every downstream figure follow from these.'],
      ['Items already on the master', 'Their opening count is updated; the prices are only overwritten if you supply them.'],
      ['The » columns are LIVE formulas', 'They recalculate as you type. Adding your own rows below row 5? Select the five » cells in row 5 and drag the fill handle (or copy/paste) down through your last row, so your own products total correctly too.'],
      ['The TOTAL row (further down the sheet)', 'Already filled in — how many BATCH LINES, the value at cost, and the value at MRP, added up from every row above it. Leave it where it is; it recalculates on its own and the app never loads it as a product. This is the row to check against the Marg report before uploading — note it counts rows (batches), not distinct products, since one product can legitimately span more than one row.'],
      ['Which total to trust', 'Check the VALUE AT MRP total against Marg first — MRP carries no tax, so nothing distorts it. If that agrees, the products and quantities are right. The value-at-cost total can still differ even when everything is correct: Marg commonly values stock EXCLUDING GST, so a real load can show MRP matching within a fraction of a percent while cost differs by several percent. That gap is not a data problem — it is the GST.'],
      ['Batch and Expiry (both optional)', 'Each row is ONE BATCH. A product with two batches — bought at different times, at different costs — appears on TWO rows, one per batch, each with its own batch number and expiry. Leave both blank if you cannot supply them: the row loads exactly as before, as one unidentified lot. The Item Master price becomes the quantity-weighted average across a product\'s batches — a batch of 5 does not count as heavily as a batch of 500.'],
      ['Two rows, same product', 'DIFFERENT batch numbers means two real batches — both are kept. The SAME batch number (or no batch number) on two rows for the same product is treated as a duplicate: the quantities are added together and it is reported as a merge, not silently overwritten — unless the rate on the two rows disagrees by more than a rounding difference, in which case it is rejected instead of guessed at.']
    ]
  },
  purchase: {
    file: 'yajna-purchase-upload-template.xlsx', sheet: 'Purchase',
    /* LINE INPUTS ONLY — no vendor column (the vendor is chosen at upload and
       the whole file lands under them), no calculated columns, no totals. The
       app derives total qty, net rate, margin from these seven via calcLine. */
    cols: ['name', 'pack', 'pqty', 'oqty', 'rate', 'disc', 'gst', 'mrp', 'batch', 'exp'],
    hdrs: { name: 'Item', mrp: 'MRP ₹ (per strip)' },
    need: ['name', 'pqty'],
    eg: [['Tab. Rifaximin 550', '10s', 10, 1, 85, 10, 12, 120, 'B2318', '2027-06']],
    notes: [
      ['Purchase Qty (strips)', 'STRIPS billed by the vendor. Part strips are fine: 2.5 is two and a half. Must be 0 or more.'],
      ['Offer Qty (free / scheme)', 'Free / scheme strips — they enter stock and dilute the net rate, but you are not billed for them. 0 if none.'],
      ['Rate ₹', 'Per strip, BEFORE discount and BEFORE GST — exactly as printed on the bill. Must be 0 or more.'],
      ['Vendor Disc %', 'A percentage between 0 and 100, never rupees.'],
      ['GST %', 'One of 0, 5, 12 or 18.'],
      ['MRP ₹', 'Printed MRP of one strip. Must be 0 or more.'],
      ['What the app computes', 'Total Qty = purchase + offer · Net Rate = billed amount ÷ total qty · Margin % = (MRP − net rate) ÷ MRP — the same calcLine math as manual entry, so nothing can disagree.'],
      ['One vendor per file', 'There is no vendor column on purpose. You name the vendor when uploading and every line lands under them.'],
      ['Pack size', 'OPTIONAL for items already on the Item Master (their pack is known). REQUIRED when a line creates a NEW item — an item born without a pack can never convert tablets to strips.'],
      ['Batch and Expiry (both optional)', 'Printed on the vendor\'s invoice. Filling them in gives this exact lot a real identity — checkable at sale time, reportable for expiry risk. Left blank, the line still enters stock and is valued correctly; it just carries no batch identity of its own.']
    ]
  },
  items: {
    file: 'yajna-item-master-template.xlsx', sheet: 'Item master',
    cols: ['name', 'mol', 'pack', 'nr', 'mrp'],
    need: ['name', 'mrp'],
    eg: [['Tab. Rifaximin 550', 'Rifaximin 550mg', '10s', 298, 412], ['Tab. Metformin 500', 'Metformin 500mg', '15s', 12, 21], ['Inj. Pantoprazole 40', 'Pantoprazole 40mg', 'vial', 38, 58]],
    notes: [
      ['Molecule / salt', 'The generic content — "Rifaximin 550mg". Optional, but it is what lets the All-companies master compare the SAME medicine across hospitals when the brands differ.'],
      ['Net rate — single strip', 'The negotiated cost of ONE strip, INCLUSIVE of GST.'],
      ['MRP — single strip', 'The printed MRP of ONE strip.'],
      ['What you get back', 'Expected margin % = (MRP − Net rate) ÷ MRP. Every purchase line is tallied against it, and a line priced away from it alerts the admin.'],
      ['No quantity here', 'The master is prices, not stock. Opening counts go in the opening-stock template.']
    ]
  },
  vendors: {
    file: 'yajna-vendor-balances-template.xlsx', sheet: 'Vendors',
    cols: ['name', 'bal', 'credit', 'phone'],
    hdrs: { name: 'Vendor Name' },
    /* both a name AND a balance column must be recognized — 'name' alone
       would happily match an items/sales/opening sheet's own name column too
       (nothing else on this template is required), letting the wrong file
       "match" and hand back nonsense rows read as vendor names. Requiring the
       BALANCE COLUMN to exist (not that every cell under it is filled — a
       brand-new vendor's row can still be blank) is what actually tells a
       vendor file apart from anything else in the console. */
    need: ['name', 'bal'],
    eg: [
      ['Sun Pharma Distributors', '1,25,000 Cr', 30, '+91 98480 12345'],
      ['Cipla Agencies', 42500, 21, '+91 98661 44556'],
      ['Zydus Lifecare Agencies', '8,500 Dr', 30, '']
    ],
    notes: [
      ['Opening Balance', 'What you owed this vendor the day you started with us. A Marg export often ends the figure with Cr or Dr: Cr is the ordinary case — you owe them — entered as a positive number, or just left with the suffix on (it is read either way). Dr is the reverse — an advance, or a credit note in your favour — entered as negative. Leave it blank for a brand-new vendor with nothing owed yet. A balance that cannot be read this way is rejected with a reason, never guessed at.'],
      ['Credit Days', 'How many days of credit this vendor gives you. Optional — 30 if left blank.'],
      ['Phone', 'Optional. Used for WhatsApp order lists.']
    ]
  }
};

/* the header row a template writes for its columns, in cols order — shared
   with the export routes so an exported sheet's headers can never drift from
   what the uploader actually matches against */
function templateHeaders(kind) {
  const T = TEMPLATES[kind];
  return T.cols.map(c => (T.hdrs && T.hdrs[c]) || COL[c].hdr);
}
/* the STANDARD IMPORT RECEIPT — the one shape every /api/parse/* endpoint's
   response carries, so a single client component can render (and a single
   test suite can pin) all six. fileRows === imported + skipped.length always.
   `cautions` is separate from `skipped` on purpose — a caution ships WITH the
   row it warns about (still imported, still counted), never against it. */
function receiptFields({ fileName, sheet, fileRows, parsed, imported, skipped, ignored, source, cautions }) {
  return { fileName: fileName || '', sheet: sheet || null, fileRows: fileRows || 0,
    parsed: parsed || 0, imported: imported || 0, skipped: skipped || [], ignored: ignored || 0, source,
    cautions: cautions || [] };
}
/* the template-only endpoints (purchase, items) have no AI fallback — when
   nothing in the file matches the template's headers, this is the whole
   response: a receipt-shaped refusal naming exactly what was expected, rather
   than a bare error the client has to special-case. */
function noSheetMatchedReceipt(kind, fileName) {
  const expected = templateHeaders(kind);
  return {
    error: `No sheet matched the template headers; expected: ${expected.join(', ')}`,
    ...receiptFields({ fileName, sheet: null, fileRows: 0, parsed: 0, imported: 0, skipped: [], ignored: 0, source: 'template' }),
    expected
  };
}
function buildTemplate(kind) {
  const T = TEMPLATES[kind];
  const baseHdr = templateHeaders(kind);
  let hdr = [], widthKeys = [];
  /* read-only "what the app will compute" columns, each inserted right after
     the real column it is named for — several may share the same anchor (e.g.
     four columns all follow MRP), and they stay in the order given here. The
     parser IGNORES every one of them (their headers are worded to match NO
     COL pattern — asserted in tests) and recomputes server-side, so a sheet
     can never smuggle in its own numbers. The eg rows below already carry
     every helper value in position. */
  T.cols.forEach((c, i) => {
    hdr.push(baseHdr[i]); widthKeys.push(c);
    (T.helpers || []).filter(h => h.after === c).forEach(h => { hdr.push(h.hdr); widthKeys.push('_helper'); });
  });
  let ws;
  if (kind === 'opening') {
    /* opening stock is loaded ONCE per pharmacy and everything downstream is
       built on it — the sheet is the only cheap moment to catch a mistake, so
       its calculated columns and TOTAL row are LIVE formulas, not static
       illustrations, and the TOTAL row is what gets checked against Marg
       before anything is uploaded. Column layout (fixed by T.cols/helpers
       above): A name, B pack, C open, D openTab, E »Total strips, F nr,
       G mrp, H »Rate/piece, I »MRP/piece, J »Value at cost, K »Value at MRP,
       L batch, M exp — batch/exp are APPENDED at the end deliberately, so the
       A-K formula system below (already shipped, already trusted) never has
       to be re-derived for a shifted column letter. */
    ws = XLSX.utils.aoa_to_sheet([hdr, ...T.eg]);
    ws['!cols'] = widthKeys.map(c => ({ wch: c === 'name' ? 34 : c === 'nr' ? 32 : c === '_helper' ? 28 : 20 }));
    const col = { name: 'A', pack: 'B', open: 'C', openTab: 'D', totalStrips: 'E', nr: 'F', mrp: 'G', ratePiece: 'H', mrpPiece: 'I', valueCost: 'J', valueMrp: 'K' };
    /* pack units come from a leading number ("10s" -> 10); anything that
       doesn't parse that way (vial / btl / amp) correctly falls through to
       blank, matching packUnits() server-side — verified by hand against
       all 4 example rows before shipping this. */
    const packOf = r => `VALUE(LEFT(${col.pack}${r},LEN(${col.pack}${r})-1))`;
    const setF = (addr, formula) => { ws[addr] = { t: 'n', f: formula }; };
    /* ONLY the fixed example rows (2-5) get formulas — never pre-fill further
       rows "just in case": a formula cell that evaluates to "" still reads
       back as a non-blank row once a real spreadsheet recalculates and caches
       that empty string, which would make readTemplate see it as a nameless
       row and reject it. Verified empirically with the xlsx package before
       choosing this design — an untouched cell stays genuinely blank, a
       formula cell that resolves to "" does not. */
    for (let r = 2; r <= 5; r++) {
      setF(`${col.totalStrips}${r}`,
        `IF(${col.name}${r}="","",IF(AND(${col.openTab}${r}<>"",${col.openTab}${r}<>0,ISERROR(${packOf(r)})),"check pack size",${col.open}${r}+IF(OR(${col.openTab}${r}="",${col.openTab}${r}=0),0,${col.openTab}${r}/${packOf(r)})))`);
      setF(`${col.ratePiece}${r}`, `IF(OR(${col.name}${r}="",${col.nr}${r}="",${col.nr}${r}=0),"",IFERROR(${col.nr}${r}/${packOf(r)},""))`);
      setF(`${col.mrpPiece}${r}`, `IF(OR(${col.name}${r}="",${col.mrp}${r}="",${col.mrp}${r}=0),"",IFERROR(${col.mrp}${r}/${packOf(r)},""))`);
      setF(`${col.valueCost}${r}`, `IF(OR(${col.name}${r}="",NOT(ISNUMBER(${col.totalStrips}${r}))),"",${col.totalStrips}${r}*${col.nr}${r})`);
      setF(`${col.valueMrp}${r}`, `IF(OR(${col.name}${r}="",NOT(ISNUMBER(${col.totalStrips}${r}))),"",${col.totalStrips}${r}*${col.mrp}${r})`);
    }
    // capacity for ~3000 BATCH LINES (Viraj's real load was 419 lines across
    // 407 products) before a TOTAL row placed comfortably clear of any
    // realistic amount of real data — one product can now span several rows
    const lastDataRow = 3000, totalRow = 3002;
    ws[`${col.name}${totalRow}`] = { t: 'str', v: 'TOTAL' };
    setF(`${col.valueCost}${totalRow}`, `SUM(${col.valueCost}2:${col.valueCost}${lastDataRow})`);
    setF(`${col.valueMrp}${totalRow}`, `SUM(${col.valueMrp}2:${col.valueMrp}${lastDataRow})`);
    // this counts ROWS (batch lines), not distinct products — a product with
    // two batches legitimately appears twice; the distinct-product count is
    // shown in the upload preview instead, where it can be checked alongside
    // this figure rather than faked as a second, fragile Excel formula
    ws[`${col.pack}${totalRow}`] = { t: 'str', f: `COUNTA(${col.name}2:${col.name}${lastDataRow})&" batch lines"` };
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totalRow - 1, c: hdr.length - 1 } });
  } else if (kind === 'purchase') {
    /* branding band + legend above the header. readTemplate scans the first 15
       rows for the header, so the band costs nothing at read time. (This xlsx
       build cannot write cell colours — the band and legend carry the branding
       in text; the validations live in the legend and are ENFORCED at parse.) */
    ws = XLSX.utils.aoa_to_sheet([
      ['YAJNA PHARMA SOLUTIONS — Purchase Upload'],
      ['One vendor per file (named at upload) · all quantities in STRIPS · pack required for NEW items · qty/rate/MRP ≥ 0 · disc 0–100% · GST one of 0/5/12/18 · the app computes total qty, net rate and margin'],
      [],
      hdr, ...T.eg
    ]);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: hdr.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: hdr.length - 1 } }
    ];
    ws['!cols'] = T.cols.map(c => ({ wch: c === 'name' ? 34 : c === 'rate' ? 30 : c === 'pqty' || c === 'oqty' ? 22 : 16 }));
  } else {
    ws = XLSX.utils.aoa_to_sheet([hdr, ...T.eg]);
    ws['!cols'] = widthKeys.map(c => ({ wch: c === 'name' ? 34 : c === 'nr' ? 32 : c === '_helper' ? 28 : 20 }));
  }
  const notes = XLSX.utils.aoa_to_sheet([
    ['How to fill this sheet'], [],
    ['Product name', 'Exactly as it appears on the bill — it is matched to the Item Master by name.'],
    ['Pack size', 'The strip size: 10s, 15s, or vial / btl / amp for anything not in strips.'],
    ...T.notes, [],
    ['Everything is per STRIP', 'Quantities count strips whatever the strip holds; both rates are for ONE strip. Margin % is a ratio, so the pack size never changes it — but the VALUES do depend on it, and so does stock.'],
    ['Column order', 'Any order you like. The columns are found by their headings, so keep the header row.'],
    ['Rows that are skipped', 'Blank rows, and TOTAL / Grand Total rows.']
  ]);
  notes['!cols'] = [{ wch: 28 }, { wch: 96 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, T.sheet);
  XLSX.utils.book_append_sheet(wb, notes, 'How to fill');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* Deliberately UNAUTHENTICATED. The file is a blank form — column headings,
   three invented example rows and instructions. It reads nothing from the
   database and is scoped to no hospital, so a session would gate a document
   that contains nothing to protect, and would break demo mode for no reason.
   Anything that reads real data stays behind `auth`. */
app.get('/api/template/:kind', (req, res) => {
  const T = TEMPLATES[req.params.kind];
  if (!T) return res.status(404).json({ error: 'Unknown template' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${T.file}"`);
  res.send(buildTemplate(req.params.kind));
});

/* Read a filled template by matching headings. Every data row under the header
   is accounted for exactly once: it lands in `rows` (parsed) or in `skipped`
   (with a reason) — never dropped without a trace. `fileRows === rows.length +
   skipped.length` always holds; total/subtotal rows are counted separately in
   `ignored` since they are not a data problem, just noise to skip past.
   `matched:false` means no sheet/header combination in the file fit this
   template at all — the caller decides what to do (fall back to AI, or refuse
   with the headers it expected, for the template-only endpoints). */
function readTemplate(buf, kind) {
  const T = TEMPLATES[kind];
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer' }); } catch (e) { return { matched: false, expected: templateHeaders(kind) }; }
  for (const sn of wb.SheetNames.slice(0, 5)) {
    // blankrows must stay TRUE (the default) — sheet_to_json with false
    // DELETES blank rows from the array rather than leaving an empty [] at
    // their position, which shifts every later index out from under the
    // real sheet row it came from. The template ships with ~2,500 blank
    // rows before TOTAL specifically so a real file can carry that many
    // batch lines; compacting them made TOTAL (and anything genuinely past
    // it) report the wrong row number — "row 474" for a row that is
    // actually row 2997. Blank rows are still never reported as rejections
    // (see the blank-row skip just below); this only fixes their address.
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: true });
    for (let h = 0; h < Math.min(grid.length, 15); h++) {
      const hdr = (grid[h] || []).map(c => String(c == null ? '' : c).trim());
      const col = {};
      /* a heading is claimed by the FIRST field that wants it, in the template's
         own order — otherwise "Qty" would be taken by both qty and open */
      const taken = new Set();
      for (const key of T.cols) {
        const ix = hdr.findIndex((c, n) => c && !taken.has(n) && COL[key].match.some(p => p.test(c)));
        if (ix >= 0) { col[key] = ix; taken.add(ix); }
      }
      // a `need` entry may be an any-of list: sales accepts qty OR qtyTab
      if (T.need.some(k => Array.isArray(k) ? k.every(x => col[x] === undefined) : col[k] === undefined)) continue;
      const qtyCol = col.qty !== undefined ? col.qty : col.open;
      const tabCol = kind === 'sales' ? col.qtyTab : kind === 'opening' ? col.openTab : undefined;
      const out = [], skipped = [], cautions = [];
      let ignored = 0;
      for (let r = h + 1; r < grid.length; r++) {
        const row = grid[r] || [];
        const sheetRow = r + 1;
        // a fully empty row is just template space (the ~2,500-row gap
        // before TOTAL), never a rejected data row — it is silently ignored,
        // not counted in fileRows and never shown as "no product name".
        // Anything with SOME content but no name is a real anomaly and
        // still falls through to that rejection below.
        if (row.every(c => c === undefined || c === null || String(c).trim() === '')) continue;
        const name = S(row[col.name], 150).trim();
        /* whatever this template's columns hold for this row, captured ONCE up
           front — so a rejected row can be handed back with its original
           values pre-filled on the "download not-imported rows" sheet, not
           just named and blamed */
        const cells = kind === 'purchase'
          ? { pack: S(row[col.pack ?? -1], 30).trim(), pqty: N(row[col.pqty]), oqty: N(row[col.oqty ?? -1]),
              rate: N(row[col.rate ?? -1]), disc: N(row[col.disc ?? -1]), gst: N(row[col.gst ?? -1]), mrp: N(row[col.mrp ?? -1]),
              batch: S(row[col.batch ?? -1], 40).trim(), exp: parseExpiryCell(row[col.exp ?? -1]) }
          : kind === 'vendors'
          ? { bal: S(row[col.bal ?? -1]), credit: N(row[col.credit ?? -1]), phone: S(row[col.phone ?? -1], 40).trim() }
          : { pack: S(row[col.pack ?? -1], 30).trim(), molecule: S(row[col.mol ?? -1], 150).trim(),
              qty: qtyCol === undefined ? undefined : N(row[qtyCol]),
              loose: tabCol === undefined ? undefined : N(row[tabCol]),
              nr: N(row[col.nr ?? -1]), mrp: N(row[col.mrp ?? -1]),
              batch: S(row[col.batch ?? -1], 40).trim(), exp: parseExpiryCell(row[col.exp ?? -1]) };
        const skip = (reason) => skipped.push({ row: sheetRow, name, reason, ...cells });
        if (!name) { skip(kind === 'vendors' ? 'no vendor name' : 'no product name'); continue; }
        if (/^(total|grand total|sub ?total)/i.test(name)) { skip('skipped: total row'); ignored++; continue; }
        if (kind === 'purchase') {
          /* raw INPUTS only — cleanEntry + calcLine derive everything on save,
             so the sheet can never smuggle in a wrong net rate */
          const l = { row: sheetRow, item: name, ...cells };
          if (l.pqty < 0 || l.rate < 0 || l.mrp < 0) { skip('negative value — must be 0 or more'); continue; }  // legend rule: ≥ 0
          l.disc = Math.min(100, Math.max(0, l.disc));                       // legend rule: 0–100
          if (l.pqty + l.oqty <= 0) { skip('no quantity — nothing purchased'); continue; }
          out.push(l);
          continue;
        }
        if (kind === 'vendors') {
          const b = parseVendorBalance(cells.bal);
          if (!b.ok) { skip('could not read the opening balance — expected a plain number, optionally ending in Cr or Dr'); continue; }
          out.push({ row: sheetRow, name, bal: b.value, credit: cells.credit > 0 ? Math.round(cells.credit) : 30, phone: cells.phone });
          continue;
        }
        /* FULL STRIPS + LOOSE TABLETS, together — 10 strips + 3 loose of a 10s
           is 10.3 strips, not a choice between the two columns. Either alone
           still works: a plain strip count, or a plain tablet count divided by
           the pack (103 tablets of a 10s = 10.3, same number either way).
           Loose tablets with no numeric pack = nothing to divide by, rejected.
           The "» Total strips" helper column is ignored entirely: its header
           matches no COL pattern, and the total is recomputed HERE. */
        const srcStrips = qtyCol === undefined ? 0 : N(row[qtyCol]);
        let qty = srcStrips, unit = 'strips', srcLoose = 0;
        if (tabCol !== undefined) {
          const hasLoose = S(row[tabCol]).trim() !== '';
          if (hasLoose) {
            const u = packUnits(S(row[col.pack ?? -1]));
            if (!u) { skip('pack size needed to convert loose tablets — a vial has no strip size'); continue; }
            srcLoose = N(row[tabCol]);
            qty = srcStrips + srcLoose / u;
            unit = srcStrips > 0 ? 'mixed' : 'tablets';
            /* loose tablets AT LEAST a full strip, alongside a strip count already
               filled in, is the signature of a total tablet count pasted into the
               loose column by mistake — worth a caution, never a rejection: the
               number as entered is still summed and imported. */
            if (srcStrips > 0 && srcLoose >= u) {
              cautions.push({ row: sheetRow, name, reason: `${srcLoose} loose tablets is a full strip or more (pack ${u}s) alongside ${srcStrips} strips already filled — check this isn't a total tablet count` });
            }
          }
        }
        // sales needs something sold; opening allows a zero count; the master has no qty at all
        if (kind === 'sales' && qty <= 0) { skip('no quantity sold'); continue; }
        if (kind === 'opening' && qty < 0) { skip('negative opening count'); continue; }
        out.push({ row: sheetRow, name, unit, srcStrips, srcLoose, molecule: S(row[col.mol ?? -1], 150).trim(), pack: S(row[col.pack ?? -1], 30).trim(), qty, nr: N(row[col.nr ?? -1]), mrp: N(row[col.mrp ?? -1]), batch: cells.batch, exp: cells.exp });
      }
      const fileRows = out.length + skipped.length;
      // if the header matched but nothing at all sits below it, keep scanning —
      // a later header row further down the sheet may be the real one
      if (fileRows) return { matched: true, rows: out, sheet: sn, fileRows, skipped, rejected: skipped, ignored, cautions, tabletsCol: tabCol !== undefined };
    }
  }
  return { matched: false, expected: templateHeaders(kind) };
}
const readSalesTemplate = (buf) => readTemplate(buf, 'sales');

/* The item-master template. No AI fallback: the master is prices, and a price
   guessed out of a free-form sheet is worse than no price at all. */
/* Bulk purchase upload: ONE vendor (from the popup, never the sheet) + the
   filled template. The response is a PREVIEW — nothing touches the day until
   the client appends the invoice and saves through the ordinary entry path,
   where cleanEntry + calcLine recompute every derived figure. */
app.post('/api/parse/purchase', auth, requireRole('admin'), upload.single('file'), (req, res) => {
  const hid = S(req.query.hid, 60);
  scopeCheck(req, hid);
  const vendor = S((req.body && req.body.vendor) || req.query.vendor, 120).trim();
  if (!vendor) return res.status(400).json({ error: 'Vendor name is required — the whole file lands under one vendor' });
  const invoiceNo = S((req.body && req.body.invoiceNo) || req.query.invoiceNo, 60).trim();
  if (!req.file) return res.status(400).json({ error: 'Attach the filled purchase template' });
  const tpl = readTemplate(req.file.buffer, 'purchase');
  if (!tpl.matched) return res.status(400).json(noSheetMatchedReceipt('purchase', req.file.originalname));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(S(req.query.date)) ? req.query.date : todayISO();
  /* NEW items (not on the master, no alias) MUST bring a pack — an item born
     without one can never convert tablets to strips. Those rows are BLOCKED with
     the reason; known items with a blank pack import fine (theirs is on file).
     This is purchase's SAVE-STAGE rejection: the row parsed fine but will not
     become an invoice line, so it joins the parse-stage skips in one list. */
  const findIt = db.prepare('SELECT 1 FROM items WHERE hospital_id=? AND name_key=?');
  const findAl = db.prepare('SELECT 1 FROM item_aliases WHERE hospital_id=? AND alias_key=?');
  const known = (nm) => !!(findIt.get(hid, nameKey(nm)) || findAl.get(hid, nameKey(nm)));
  const lines = [], blocked = [];
  tpl.rows.slice(0, 500).forEach((l) => {
    const isNew = !known(l.item);
    if (isNew && !l.pack) { blocked.push({ row: l.row, name: l.item, reason: 'pack size needed — this line creates a NEW item' }); return; }
    lines.push({ ...l, isNew });
  });
  const invoice = { id: uid('inv'), vendor, invoiceNo, date, fileName: req.file.originalname || '',
    lines: lines.map(({ isNew, row, ...l }) => l) };
  // the preview shows what calcLine WILL derive — same math, so the numbers the
  // user approves are the numbers the day will carry
  const preview = lines.map(l => { const d = calcLine(l); return { ...l,
    tqty: d.tqty, nr: +d.nr.toFixed(2), pamt: +d.pamt.toFixed(2), marginPct: +d.marginPct.toFixed(2) }; });
  const skipped = tpl.skipped.concat(blocked);
  res.json({ source: 'template', sheet: tpl.sheet, invoice, preview, blocked,
    ...receiptFields({ fileName: req.file.originalname, sheet: tpl.sheet, fileRows: tpl.fileRows,
      parsed: tpl.rows.length, imported: lines.length, skipped, ignored: tpl.ignored, source: 'template' }),
    note: `Read ${lines.length} line${lines.length === 1 ? '' : 's'} from the template (sheet "${tpl.sheet}") — all for ${vendor}`
      + (blocked.length ? ` · ${blocked.length} row${blocked.length === 1 ? '' : 's'} blocked` : '') });
});

app.post('/api/parse/items', auth, requireRole('admin'), upload.single('file'), (req, res) => {
  const hid = S(req.query.hid, 60);
  scopeCheck(req, hid);
  if (!req.file) return res.status(400).json({ error: 'Attach the filled item-master template' });
  const tpl = readTemplate(req.file.buffer, 'items');
  if (!tpl.matched) return res.status(400).json(noSheetMatchedReceipt('items', req.file.originalname));
  const rows = tpl.rows.map(r => ({ row: r.row, name: r.name, molecule: r.molecule || '', pack: r.pack, nr: r.nr, mrp: r.mrp }));
  res.json({
    source: 'template', sheet: tpl.sheet, rows,
    ...receiptFields({ fileName: req.file.originalname, sheet: tpl.sheet, fileRows: tpl.fileRows,
      parsed: rows.length, imported: rows.length, skipped: tpl.skipped, ignored: tpl.ignored, source: 'template' }),
    note: `Read ${rows.length} row${rows.length === 1 ? '' : 's'} from the template (sheet "${tpl.sheet}")`
  });
});

/* Vendor opening balances. No AI fallback, same reasoning as the item master:
   these are ledger figures, not something worth guessing from a free-form
   layout. Excel/CSV go through the same readTemplate() every other upload
   uses — the balance's Cr/Dr suffix is resolved server-side (parseVendorBalance)
   so a bad value is rejected with a reason rather than silently truncated. */
app.post('/api/parse/vendors', auth, requireRole('admin'), upload.single('file'), (req, res) => {
  const hid = S(req.query.hid, 60);
  scopeCheck(req, hid);
  if (!req.file) return res.status(400).json({ error: 'Attach the filled vendor balances template' });
  const tpl = readTemplate(req.file.buffer, 'vendors');
  if (!tpl.matched) return res.status(400).json(noSheetMatchedReceipt('vendors', req.file.originalname));
  const rows = tpl.rows.map(r => ({ row: r.row, name: r.name, bal: r.bal, credit: r.credit, phone: r.phone }));
  res.json({
    source: 'template', sheet: tpl.sheet, rows,
    ...receiptFields({ fileName: req.file.originalname, sheet: tpl.sheet, fileRows: tpl.fileRows,
      parsed: rows.length, imported: rows.length, skipped: tpl.skipped, ignored: tpl.ignored, source: 'template' }),
    note: `Read ${rows.length} row${rows.length === 1 ? '' : 's'} from the template (sheet "${tpl.sheet}")`
  });
});

app.post('/api/parse/gpreport', auth, upload.single('file'), async (req, res, next) => {
  try {
    const hid = S(req.query.hid, 60);
    scopeCheck(req, hid);
    if (!req.file) return res.status(400).json({ error: 'Attach the sales report (Excel/CSV/PDF)' });

    /* Our own template first: the columns are known, so it is read by matching
       headings — no AI, nothing to misread, and it works with no API key. */
    const tpl = readSalesTemplate(req.file.buffer);
    if (tpl.matched) {
      const items = tpl.rows.map(r => {
        const value = r.qty * r.mrp, cost = r.qty * r.nr;
        return { row: r.row, item: r.name, pack: r.pack, qty: r.qty, nr: r.nr, mrp: r.mrp,
          unit: r.unit || 'strips', srcStrips: r.srcStrips || 0, srcLoose: r.srcLoose || 0,
          amount: +value.toFixed(2), cost: +cost.toFixed(2), batch: r.batch || '',
          // a ratio — the pack size never enters it, only the same unit on both sides
          marginPct: r.mrp > 0 ? (r.mrp - r.nr) / r.mrp * 100 : 0 };
      });
      const salesMrp = items.reduce((a, r) => a + r.amount, 0);
      const cogs = items.reduce((a, r) => a + r.cost, 0);
      const noRate = items.filter(r => !(r.nr > 0)).length;
      return res.json({
        source: 'template', sheet: tpl.sheet,
        salesMrp: +salesMrp.toFixed(2), cogs: +cogs.toFixed(2), cash: 0, credit: 0,
        rejected: tpl.rejected || [], tabletsCol: !!tpl.tabletsCol,
        grossProfit: +(salesMrp - cogs).toFixed(2),
        marginPct: salesMrp > 0 ? (salesMrp - cogs) / salesMrp * 100 : 0,
        ...receiptFields({ fileName: req.file.originalname, sheet: tpl.sheet, fileRows: tpl.fileRows,
          parsed: items.length, imported: items.length, skipped: tpl.skipped, ignored: tpl.ignored, source: 'template', cautions: tpl.cautions }),
        note: `Read ${items.length} row${items.length === 1 ? '' : 's'} from the template (sheet "${tpl.sheet}")`
          + (noRate ? ` · ${noRate} row${noRate === 1 ? ' has' : 's have'} no cost price, so ${noRate === 1 ? 'it counts' : 'they count'} as zero cost` : ''),
        items
      });
    }

    const mt = (req.file.mimetype || '').toLowerCase();
    const name = (req.file.originalname || '').toLowerCase();
    let content;
    const direct = fileBlock(req.file);
    if (direct) {
      content = [direct];
    } else if (/\.(xlsx?|csv)$/.test(name) || mt.includes('sheet') || mt.includes('excel') || mt.includes('csv') || mt === 'text/plain') {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      let text = '';
      for (const sn of wb.SheetNames.slice(0, 5)) {
        text += `--- sheet: ${sn} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + '\n';
      }
      if (text.length > 300000) text = text.slice(0, 300000) + '\n[truncated]';
      if (!text.trim()) return res.status(400).json({ error: 'The file appears to be empty' });
      content = [{ type: 'text', text: 'Report contents (CSV):\n\n' + text }];
    } else {
      return res.status(400).json({ error: 'Unsupported file type — upload Excel, CSV, PDF or an image of the report' });
    }
    content.push({ type: 'text', text: "This is a daily Gross Profit / sales report exported from Marg ERP for a hospital pharmacy in India. Extract (1) the day's totals — sales at MRP, cost of goods sold (COGS), cash vs credit split if present, and gross profit — from the grand-total row, and (2) the item-wise sales rows (product name, quantity, sale amount) if the report lists individual products; return up to 150 items by sale amount, or an empty items array if the report has no item-wise rows. Amounts in rupees, plain numbers." });
    const data = await askClaude(content, GP_SCHEMA);
    const sm = N(data.sales_mrp), cg = N(data.cogs);
    // the AI's own items array can carry rows with no name or no sale amount —
    // give those a reason too, rather than filtering them out unaccounted for
    const rawItems = (Array.isArray(data.items) ? data.items : []).slice(0, 300)
      .map((r, ix) => ({ row: ix + 1, item: S(r.name, 150), qty: N(r.qty), amount: N(r.amount), pack: '', nr: 0, mrp: 0 }));
    const aiSkipped = [];
    const items = rawItems.filter(r => {
      if (!r.item) { aiSkipped.push({ row: r.row, name: '', reason: 'no product name' }); return false; }
      if (!(r.amount > 0)) { aiSkipped.push({ row: r.row, name: r.item, reason: 'no sale amount' }); return false; }
      return true;
    });
    res.json({
      source: 'ai',
      salesMrp: sm, cogs: cg, cash: N(data.cash_sales), credit: N(data.credit_sales),
      grossProfit: N(data.gross_profit), marginPct: sm > 0 ? (sm - cg) / sm * 100 : 0, note: S(data.note, 300),
      ...receiptFields({ fileName: req.file.originalname, sheet: null, fileRows: rawItems.length,
        parsed: items.length, imported: items.length, skipped: aiSkipped, ignored: 0, source: 'ai' }),
      items
    });
  } catch (err) { next(err); }
});

/* read an opening-stock file (Marg stock report / count sheet) */
/* ---------- expiry snapshots ---------- */
const rowSnap = (r) => ({ id: r.id, asOf: r.as_of, fileName: r.file_name || '', rows: JSON.parse(r.rows),
  by: r.uploaded_by, at: r.uploaded_at });

/* Indian stock reports print expiry as MM/YY, MM/YYYY, MM-YY, YYYY-MM … */
function normExpiry(v) {
  const x = S(v, 12).trim();
  if (!x) return '';
  let m = /^(\d{4})[-/](\d{1,2})$/.exec(x);                 // YYYY-MM
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;
  m = /^(\d{1,2})[-/](\d{2,4})$/.exec(x);                   // MM/YY or MM/YYYY
  if (m) {
    const mo = +m[1]; let yr = +m[2];
    if (yr < 100) yr += 2000;
    if (mo >= 1 && mo <= 12 && yr >= 2000 && yr <= 2099) return `${yr}-${String(mo).padStart(2, '0')}`;
  }
  return '';
}
/* A real Excel-typed date (typed by hand, or pasted from a date-formatted
   source) arrives from XLSX.read as a raw numeric day-serial, not a string —
   normExpiry's regexes would never match a bare number and would silently
   treat a genuine date as blank. Detected and converted first; anything else
   still goes through normExpiry's flexible MM/YY-style string parsing. */
function parseExpiryCell(raw) {
  if (typeof raw === 'number' && raw > 0) {
    const d = XLSX.SSF.parse_date_code(raw);
    return (d && d.y && d.m) ? `${d.y}-${String(d.m).padStart(2, '0')}` : '';
  }
  return normExpiry(raw);
}
/* Used at BOTH the preview (/parse/expiry) and the actual save (/snapshots) —
   the same blank-name drop happens in both places, so both get to report it
   rather than one silently doing what the other explains. */
function cleanSnapRows(rows) {
  const raw = (Array.isArray(rows) ? rows : []).slice(0, 8000)
    .map((r, ix) => ({ row: ix + 1, name: S(r.name, 150).trim(), batch: S(r.batch, 40).trim(), expiry: normExpiry(r.expiry),
      qty: N(r.qty), nr: N(r.nr), mrp: N(r.mrp) }));
  const skipped = [];
  const out = raw.filter(r => {
    if (!r.name) { skipped.push({ row: r.row, name: '', reason: 'no product name' }); return false; }
    return true;
  });
  return { rows: out, skipped, fileRows: raw.length };
}

app.post('/api/parse/expiry', auth, requireRole('admin'), upload.single('file'), async (req, res, next) => {
  try {
    const hid = S(req.query.hid, 60);
    scopeCheck(req, hid);
    if (!req.file) return res.status(400).json({ error: 'Attach the batch/expiry report (Excel/CSV/PDF/photo)' });
    const mt = (req.file.mimetype || '').toLowerCase();
    const name = (req.file.originalname || '').toLowerCase();
    let content;
    const direct = fileBlock(req.file);
    if (direct) {
      content = [direct];
    } else if (/\.(xlsx?|csv)$/.test(name) || mt.includes('sheet') || mt.includes('excel') || mt.includes('csv') || mt === 'text/plain') {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      let text = '';
      for (const sn of wb.SheetNames.slice(0, 5)) text += `--- sheet: ${sn} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + '\n';
      if (text.length > 300000) text = text.slice(0, 300000) + '\n[truncated]';
      if (!text.trim()) return res.status(400).json({ error: 'The file appears to be empty' });
      content = [{ type: 'text', text: 'Batch-wise stock report contents (CSV):\n\n' + text }];
    } else {
      return res.status(400).json({ error: 'Unsupported file type — upload Excel, CSV, PDF or an image' });
    }
    content.push({ type: 'text', text: "This is a BATCH-WISE stock / expiry report from an Indian hospital pharmacy (usually exported from Marg ERP). Extract one row per item AND batch: the product name as printed, the batch number, the expiry, the closing quantity of that batch, and the cost rate and MRP if printed. Expiry is usually MM/YY or MM/YYYY — convert it to YYYY-MM. Skip group headers and total rows. Quantities in saleable units, amounts in rupees." });
    const data = await askClaude(content, EXPIRY_SCHEMA);
    const clean = cleanSnapRows(data.rows);
    const rows = clean.rows;
    res.json({
      asOf: /^\d{4}-\d{2}-\d{2}$/.test(S(data.as_of)) ? data.as_of : '',
      note: S(data.note, 300),
      rows,
      withExpiry: rows.filter(r => r.expiry).length,
      withBatch: rows.filter(r => r.batch).length,
      ...receiptFields({ fileName: req.file.originalname, sheet: null, fileRows: clean.fileRows,
        parsed: rows.length, imported: rows.length, skipped: clean.skipped, ignored: 0, source: 'ai' })
    });
  } catch (err) { next(err); }
});

/* One snapshot per as-of date: re-uploading the same date replaces it, so a
   corrected export supersedes rather than double-counts. */
app.post('/api/snapshots', auth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  scopeCheck(req, S(b.hid, 60));
  const asOf = S(b.asOf, 12);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return res.status(400).json({ error: 'Pick the date this report is as-of' });
  if (asOf > todayISO()) return res.status(400).json({ error: 'A stock report cannot be dated in the future' });
  const clean = cleanSnapRows(b.rows);
  if (!clean.rows.length) return res.status(400).json({ error: 'No stock rows to save' });
  // `row` is upload provenance only — the stored snapshot keeps the same shape it always has
  const storedRows = clean.rows.map(({ row, ...r }) => r);
  const snap = { id: uid('snap'), hospital_id: b.hid, as_of: asOf, file_name: S(b.fileName, 200),
    rows: JSON.stringify(storedRows), uploaded_by: req.user.name, uploaded_at: Date.now() };
  db.prepare('DELETE FROM expiry_snapshots WHERE hospital_id=? AND as_of=?').run(b.hid, asOf);
  db.prepare('INSERT INTO expiry_snapshots(id,hospital_id,as_of,file_name,rows,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?)')
    .run(snap.id, snap.hospital_id, snap.as_of, snap.file_name, snap.rows, snap.uploaded_by, snap.uploaded_at);
  res.json({ snapshot: rowSnap(snap),
    ...receiptFields({ fileName: b.fileName, sheet: null, fileRows: clean.fileRows,
      parsed: clean.rows.length, imported: storedRows.length, skipped: clean.skipped, ignored: 0, source: S(b.source, 20) || 'ai' }) });
});

app.delete('/api/snapshots/:id', auth, requireRole('admin'), (req, res) => {
  const s0 = db.prepare('SELECT * FROM expiry_snapshots WHERE id=?').get(req.params.id);
  if (!s0) return res.status(404).json({ error: 'Snapshot not found' });
  scopeCheck(req, s0.hospital_id);
  db.prepare('DELETE FROM expiry_snapshots WHERE id=?').run(s0.id);
  res.json({ ok: true });
});

app.post('/api/parse/stock', auth, upload.single('file'), async (req, res, next) => {
  try {
    const hid = S(req.query.hid, 60);
    scopeCheck(req, hid);
    if (!req.file) return res.status(400).json({ error: 'Attach the stock report (Excel/CSV/PDF/photo)' });

    // our own opening-stock template reads by heading — no AI, nothing misread
    const tpl = readTemplate(req.file.buffer, 'opening');
    if (tpl.matched) {
      const items = tpl.rows.map(r => ({ row: r.row, name: r.name, qty: r.qty, pack: r.pack, nr: r.nr, mrp: r.mrp, unit: r.unit || 'strips', srcStrips: r.srcStrips || 0, srcLoose: r.srcLoose || 0, batch: r.batch || '', exp: r.exp || '' }));
      const noRate = items.filter(r => !(r.nr > 0)).length;
      return res.json({
        source: 'template', stockDate: '', rejected: tpl.rejected || [], tabletsCol: !!tpl.tabletsCol,
        ...receiptFields({ fileName: req.file.originalname, sheet: tpl.sheet, fileRows: tpl.fileRows,
          parsed: items.length, imported: items.length, skipped: tpl.skipped, ignored: tpl.ignored, source: 'template', cautions: tpl.cautions }),
        note: `Read ${items.length} row${items.length === 1 ? '' : 's'} from the template (sheet "${tpl.sheet}")`
          + (noRate ? ` · ${noRate} without a net rate, so ${noRate === 1 ? 'it cannot' : 'they cannot'} be valued until the Item Master has one` : ''),
        items
      });
    }

    const mt = (req.file.mimetype || '').toLowerCase();
    const name = (req.file.originalname || '').toLowerCase();
    let content;
    const direct = fileBlock(req.file);
    if (direct) {
      content = [direct];
    } else if (/\.(xlsx?|csv)$/.test(name) || mt.includes('sheet') || mt.includes('excel') || mt.includes('csv') || mt === 'text/plain') {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      let text = '';
      for (const sn of wb.SheetNames.slice(0, 5)) text += `--- sheet: ${sn} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + '\n';
      if (text.length > 300000) text = text.slice(0, 300000) + '\n[truncated]';
      if (!text.trim()) return res.status(400).json({ error: 'The file appears to be empty' });
      content = [{ type: 'text', text: 'Stock report contents (CSV):\n\n' + text }];
    } else {
      return res.status(400).json({ error: 'Unsupported file type — upload Excel, CSV, PDF or an image' });
    }
    content.push({ type: 'text', text: "This is a pharmacy stock / inventory report from an Indian hospital pharmacy (often exported from Marg ERP). Extract every product line with its closing balance quantity, and the pack, purchase rate (inclusive of GST) and MRP where printed. Skip group headers and total rows. Quantities in saleable units, amounts in rupees, plain numbers." });
    const data = await askClaude(content, STOCK_SCHEMA);
    const rawItems = (Array.isArray(data.items) ? data.items : []).slice(0, 5000)
      .map((r, ix) => ({ row: ix + 1, name: S(r.name, 150), qty: N(r.qty), pack: S(r.pack, 60), nr: N(r.nr), mrp: N(r.mrp) }));
    const aiSkipped = [];
    const items = rawItems.filter(r => {
      if (!r.name) { aiSkipped.push({ row: r.row, name: '', reason: 'no product name' }); return false; }
      if (!(r.qty >= 0)) { aiSkipped.push({ row: r.row, name: r.name, reason: 'negative opening count' }); return false; }
      return true;
    });
    res.json({
      stockDate: /^\d{4}-\d{2}-\d{2}$/.test(S(data.stock_date)) ? data.stock_date : '',
      note: S(data.note, 300),
      ...receiptFields({ fileName: req.file.originalname, sheet: null, fileRows: rawItems.length,
        parsed: items.length, imported: items.length, skipped: aiSkipped, ignored: 0, source: 'ai' }),
      items
    });
  } catch (err) { next(err); }
});

app.get('/api/uploads/:hid/:name', auth, (req, res) => {
  const hid = S(req.params.hid, 60);
  scopeCheck(req, hid);
  const name = path.basename(S(req.params.name, 220));
  const fp = path.join(__dirname, 'data', 'uploads', hid, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(fp);
});

/* ---------- static & errors ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 12 MB)' : 'Upload failed: ' + err.code });
  }
  if (err instanceof Anthropic.APIError) {
    console.error('Anthropic API error:', err.status, err.message);
    if (err.status === 401) return res.status(503).json({ error: 'AI key invalid — check ANTHROPIC_API_KEY' });
    if (err.status === 429) return res.status(503).json({ error: 'AI is rate-limited right now — retry in a minute' });
    return res.status(502).json({ error: 'AI parsing failed — try again' });
  }
  if (err instanceof SyntaxError && err.message.includes('JSON')) {
    return res.status(502).json({ error: 'AI returned an unreadable result — try again' });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

app.listen(PORT, '127.0.0.1', () => console.log(`Yajna Pharma console on http://127.0.0.1:${PORT}`));
