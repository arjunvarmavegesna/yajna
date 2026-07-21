# yajna-Pharma-Reporting-Tool

Pharmacy audit and reporting console for Yajna Pharma Solutions, Bhimavaram.

Live at **https://yajna.thinkaisolotions.com**

## What it does

Yajna audits the pharmacies inside partner hospitals. This console is where the
day is keyed in and where it is read back:

- **Daily entry** — purchases and RTV, sales & margin, the cash drawer, the
  bounce register, the audit close and the high-value drug register.
- **Inventory** — batch-level stock valued at two bases (net rate and MRP),
  reconstructed as of any date from the movements themselves.
- **Receivables** — credit bills with an append-only action log; the amount due
  is never stored, it is derived.
- **Margin offers** — vendor rate offers, who is negotiating each one and when
  to chase it. Only "apply" moves a price on the Item Master.
- **All-companies item master** — the same molecule across every hospital, so a
  rate one pharmacy already gets can be taken to another.
- **Reports** — daily, weekly and monthly, with FLOW sections summed across the
  period and POSITION sections read as a snapshot at its end.

## Stack

Node + Express + better-sqlite3 (WAL), bcrypt sessions, a single-file vanilla-JS
frontend in `public/index.html`. XLSX templates are read by matching column
headings; Claude is only a fallback for sheets that are not ours.

## Running it

```bash
npm install
cp .env.example .env      # then fill in the values
node server.js            # or: pm2 start server.js --name yajna-pharma
```

The database is created and seeded on first run at `data/yajna.db`.

## Two things to know before you touch it

- **`public/index.html` is served straight from disk**, so editing it is live
  immediately. `server.js` needs a restart.
- **SQLite cannot alter a CHECK constraint.** Widening one in `CREATE TABLE`
  only helps a fresh database — an existing one has to be rebuilt. Always run a
  migration against a copy of the live database before deploying it.

## Tests

`tests/` holds the suites (jsdom for the UI, live HTTP for the API). Each one
wants its own fresh database on port 3061 — several rotate the admin password
or move master prices, so they cannot share one.
