/* Tests: expiry snapshots — the pharmacy software's batch report, kept as its own dataset */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const MANAGER_PW = process.env.SEED_MANAGER_PW || 'Test@Manager#1';
const USER_PW = process.env.SEED_USER_PW || 'Test@User#1';

const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));
const near = (a, b, t = 0.01) => Math.abs(a - b) < t;

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }};
}
const T = (() => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); })();
const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const adm = jar(), mgr = jar(), stf = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await mgr.req('POST', '/login', { email: 'manager@yajnapharma.in', password: MANAGER_PW });
await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });

const rows = (o = []) => o.length ? o : [{ name: 'Alpha', batch: 'B1', expiry: '2027-06', qty: 10, nr: 12, mrp: 25 }];

console.log('— saving a snapshot —');
let r = await adm.req('POST', '/snapshots', { hid: 'mithra', asOf: T, rows: rows(), fileName: 'marg.xlsx' });
ok(r.status === 200, 'snapshot saves');
ok(r.data.snapshot.rows.length === 1 && r.data.snapshot.by === 'Bhagavan', 'with its rows and who uploaded it');
ok(r.data.snapshot.asOf === T && r.data.snapshot.fileName === 'marg.xlsx', 'dated and named', JSON.stringify({ a: r.data.snapshot.asOf, f: r.data.snapshot.fileName }));

console.log('— Indian expiry formats are normalised —');
const fmts = [
  ['07/26', '2026-07'], ['7/26', '2026-07'], ['07/2026', '2026-07'], ['12-27', '2027-12'],
  ['2026-07', '2026-07'], ['2026-7', '2026-07'], ['13/26', ''], ['garbage', ''], ['', '']
];
for (const [inp, want] of fmts) {
  r = await adm.req('POST', '/snapshots', { hid: 'mithra', asOf: addD(T, -1), rows: [{ name: 'X', batch: 'B', expiry: inp, qty: 1, nr: 1, mrp: 2 }] });
  ok(r.data.snapshot.rows[0].expiry === want, `"${inp}" → ${want || '(rejected)'}`, r.data.snapshot.rows[0].expiry);
}

console.log('— one snapshot per date; a re-upload supersedes —');
await adm.req('POST', '/snapshots', { hid: 'mithra', asOf: T, rows: [{ name: 'First', batch: 'B', expiry: '2027-01', qty: 1, nr: 1, mrp: 2 }] });
await adm.req('POST', '/snapshots', { hid: 'mithra', asOf: T, rows: [{ name: 'Second', batch: 'B', expiry: '2027-01', qty: 2, nr: 1, mrp: 2 }] });
let boot = (await adm.req('GET', '/bootstrap')).data;
let sameDay = boot.snapshots.mithra.filter(s => s.asOf === T);
ok(sameDay.length === 1, 're-uploading the same date leaves ONE snapshot, not two', sameDay.length);
ok(sameDay[0].rows[0].name === 'Second', 'and it is the newer one — a corrected export supersedes', sameDay[0].rows[0].name);

console.log('— validation —');
r = await adm.req('POST', '/snapshots', { hid: 'mithra', asOf: addD(T, 2), rows: rows() });
ok(r.status === 400 && /future/i.test(r.data.error), 'a report cannot be dated in the future', r.data.error);
r = await adm.req('POST', '/snapshots', { hid: 'mithra', asOf: 'nonsense', rows: rows() });
ok(r.status === 400, 'the as-of date is required');
r = await adm.req('POST', '/snapshots', { hid: 'mithra', asOf: T, rows: [] });
ok(r.status === 400 && /no stock rows/i.test(r.data.error), 'an empty report is rejected', r.data.error);
r = await adm.req('POST', '/snapshots', { hid: 'mithra', asOf: T, rows: [{ name: '', batch: 'B', expiry: '2027-01', qty: 5, nr: 1, mrp: 2 }] });
ok(r.status === 400, 'a row with no item name is dropped, and an all-blank file is rejected');

console.log('— permissions and scoping —');
r = await stf.req('POST', '/snapshots', { hid: 'mithra', asOf: T, rows: rows() });
ok(r.status === 403, 'a data-entry user cannot upload a stock report');
r = await mgr.req('POST', '/snapshots', { hid: 'mithra', asOf: addD(T, -3), rows: rows() });
ok(r.status === 200, 'a manager/admin can');
const mgrSnap = r.data.snapshot.id;
r = await stf.req('DELETE', '/snapshots/' + mgrSnap);
ok(r.status === 403, 'a data-entry user cannot remove one');
r = await adm.req('DELETE', '/snapshots/' + mgrSnap);
ok(r.status === 200, 'a manager/admin can');
r = await adm.req('DELETE', '/snapshots/' + mgrSnap);
ok(r.status === 404, 'removing it twice 404s');
r = await stf.req('POST', '/snapshots', { hid: 'viraj', asOf: T, rows: rows() });
ok(r.status === 403, 'and nobody reaches a hospital they are not on');
boot = (await stf.req('GET', '/bootstrap')).data;
ok(!boot.snapshots.viraj && Array.isArray(boot.snapshots.mithra), 'bootstrap is scoped to the hospitals they can see');

console.log('— DOM —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {}; w.confirm = () => true;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const w = dom.window, doc = w.document;
await tick(400);
doc.querySelector('[data-quick="admin"]').click(); await tick(700);
const ev = s => w.eval(s);
const J = s => JSON.parse(w.eval(`JSON.stringify(${s})`));

/* a controlled hospital: our books say 100 Alpha, the shelf report says 95 */
ev(`
  db.hospitals.lab = {id:'lab', name:'Lab', doctor:'D', location:'', phone:'', startDate:'2026-01-01', stockDate:'2026-01-10', issueMethod:'fefo', active:true, base:1000};
  db.items.lab = [{id:'l1', name:'Alpha', key:'alpha', pack:'', nr:10, mrp:20, openingQty:100, source:'t', updatedAt:1},
                  {id:'l2', name:'Beta', key:'beta', pack:'', nr:10, mrp:18, openingQty:0, source:'t', updatedAt:1}];
  db.adjustments.lab = []; db.dailyData.lab = {}; db.vendors.lab = []; db.payments.lab = []; db.receivables.lab = []; db.recvActions.lab = []; db.snapshots.lab = [];
`);

console.log('— no report: the app says so and offers the upload —');
ok(ev(`hasExpiryData('lab')`) === false, 'no snapshot means no expiry data');
let sec = ev(`stockSection('lab','2026-02-01','daily')`);
ok(/data-expup/.test(sec), 'the report section carries an upload button');
ok(/needs the stock data for/.test(sec), 'and says what it needs and for which day', /needs the stock data/.test(sec));
ok(/Stock value \(at NR\)/.test(sec), 'while still reporting the valuation — that never needed expiry');
ok(!/Expiry bucket/.test(sec), 'and no empty bucket table');

console.log('— with a report: expiry lights up —');
ev(`db.snapshots.lab = [{id:'s1', asOf:'2026-02-01', fileName:'marg.xlsx', by:'Bhagavan', at:1, rows:[
  {name:'Alpha', batch:'BX', expiry:'2026-03', qty:40, nr:12, mrp:25},
  {name:'Alpha', batch:'BY', expiry:'2028-01', qty:55, nr:14, mrp:30},
  {name:'Beta',  batch:'BZ', expiry:'', qty:10, nr:0,  mrp:0}
]}];`);
ok(ev(`hasExpiryData('lab')`) === true, 'the snapshot is the expiry source');
const eb = J(`expiryBuckets('lab','2026-02-01')`);
ok(near(eb.buckets.b90.valueNr, 40 * 12), 'BX (end-Mar 2026, 58 days out) buckets at 31–90 days, valued at its own cost — 480', eb.buckets.b90.valueNr);
ok(!near(eb.buckets.b90.valueNr, 40 * 25), 'NOT at MRP — an expiry loses what was paid', eb.buckets.b90.valueNr);
ok(near(eb.buckets.healthy.valueNr, 55 * 14), 'BY (Jan 2028) is healthy — 770', eb.buckets.healthy.valueNr);
ok(near(eb.buckets.noexp.valueNr, 10 * 10), 'a row with no expiry falls back to the master rate and is reported separately — 100', eb.buckets.noexp.valueNr);
const sr = J(`snapRows('lab','2026-02-01')`);
ok(sr.rows.find(r => r.batch === 'BZ').rateFrom === 'master', 'a batch with no printed rate is flagged as valued from the master', sr.rows.find(r => r.batch === 'BZ').rateFrom);
ev(`db.snapshots.lab[0].rows.push({name:'Ghost', batch:'G1', expiry:'2027-01', qty:3, nr:0, mrp:0});`);
const ghost = J(`snapRows('lab','2026-02-01')`).rows.find(r => r.batch === 'G1');
ok(ghost.rateFrom === 'none' && ghost.valueNr === 0, 'a batch with no rate AND no master entry is flagged unvalued, not guessed at', ghost.rateFrom);
ev(`db.snapshots.lab[0].rows = db.snapshots.lab[0].rows.filter(r=>r.batch!=='G1');`);
ok(sr.rows.find(r => r.batch === 'BX').rateFrom === 'report', 'a batch with a printed rate uses the report’s own');

console.log('— the report reads the snapshot, and says so —');
sec = ev(`stockSection('lab','2026-02-01','daily')`);
ok(/Expiry bucket/.test(sec), 'buckets now print');
ok(/batch report as on/.test(sec), 'and the section names the report and its date');
ok(!/data-expup/.test(sec), 'the upload prompt is gone');
ok(/Bhagavan/.test(sec), 'and who uploaded it');

console.log('— an older report still covers a later date —');
ok(J(`snapshotFor('lab','2026-06-01')`).id === 's1', 'a date after the report uses the most recent one on or before it');
ok(J(`snapshotFor('lab','2026-01-15')`) === null, 'a date BEFORE any report has none — nothing is back-dated onto it');
const early = ev(`stockSection('lab','2026-01-15','daily')`);
ok(!/Expiry bucket/.test(early), 'so that report asks for an upload instead of crashing on a report that does not cover it');
ok(/data-expup/.test(early), 'and offers the upload');
ev(`db.snapshots.lab.push({id:'s2', asOf:'2026-03-01', fileName:'later.xlsx', by:'Lalitha', at:2, rows:[
  {name:'Alpha', batch:'BX', expiry:'2026-03', qty:5, nr:12, mrp:25}]});`);
ok(J(`snapshotFor('lab','2026-06-01')`).id === 's2', 'a newer report supersedes for later dates');
ok(J(`snapshotFor('lab','2026-02-15')`).id === 's1', 'but an earlier date still reads the report that covered it');

console.log('— shelf vs books: the gap is the finding —');
const R = J(`snapReconcile('lab','2026-02-01')`);
ok(near(R.ourValue, 1000), 'our books: 100 opening × 10 = 1,000', R.ourValue);
ok(near(R.theirValue, 40 * 12 + 55 * 14 + 10 * 10), 'the shelf report: 1,350', R.theirValue);
ok(R.mismatched.length === 1 && R.mismatched[0].key === 'alpha', 'Alpha is flagged: our books say 100, the shelf says 95');
ok(R.mismatched[0].gap === 5, 'and the gap is quantified (+5 on our books)', R.mismatched[0].gap);
ok(R.notOnOurBooks.includes('beta'), 'Beta is on the report but not on our books');
ok(R.withExpiry === 2 && R.withBatch === 3, 'the coverage of the report itself is reported', R.withExpiry + '/' + R.withBatch);
// the snapshot NEVER moves the valuation
ok(near(J(`stockAsOf('lab','2026-02-01')`).valueNr, 1000), 'the snapshot does NOT change our stock valuation — the two stay independent', J(`stockAsOf('lab','2026-02-01')`).valueNr);

console.log('— the inventory tab —');
ev(`state.hospital='lab'; state.view='hospital'; state.hospTab='inventory'; state.inv={mode:'asof', asOf:'2026-02-01', start:'2026-01-01', end:'2026-02-01', interval:'daily'}; state.invFilter='all'; state.invQuery=''; state.invOpen=null; renderHospitalWorkspace();`);
await tick(400);
let body = doc.querySelector('#invBody').textContent;
ok(/Expiry risk/.test(body), 'expiry risk renders from the snapshot');
ok(/Shelf vs books/.test(body), 'the shelf-vs-books reconciliation is on the tab');
ok(/1,350/.test(body) && /1,000/.test(body), 'showing both totals', body.slice(0, 40));
ok(!doc.querySelector('#invExpiry'), 'the Inventory tab carries NO upload — the import lives in Data Entry → Report sections');
// batch detail in the row expansion
doc.querySelector('[data-invexp]').click(); await tick(300);
const exp = doc.querySelector('#invBody').textContent;
ok(/Purchase lots — our cost record/.test(exp), 'the row shows our purchase lots');
ok(/Batches on the shelf/.test(exp), 'AND the shelf batches from the report');
ok(/BX/.test(exp) && /2026-03/.test(exp), 'with the batch number and expiry');
ok(/the two systems agree|Difference/.test(exp), 'and reconciles the two per item');

console.log('— no snapshot: the tab says so and offers the upload —');
ev(`db.snapshots.lab = []; state.invOpen=null; renderHospitalWorkspace();`); await tick(400);
body = doc.querySelector('#invBody').textContent;
ok(!/No stock data imported/.test(body), 'the tab does not nag about the missing report — the import lives in Data Entry');
ok(!/Selling below cost/.test(body), 'and carries no selling-below-cost section');
ok(!/never touches the margin baseline/.test(body), 'nor the potential-margin explainer — the KPI label carries it');
ok(/Potential Margin in Stock \(unrealized\)/.test(body), 'the KPI still says "unrealized" — the label was the part that mattered');
ok(!/write-off candidates/.test(body) && !/Shelf vs books/.test(body), 'and no expiry sections — the words "Expiry risk" now only appear in the prompt explaining what is missing');
ok(/Stock value \(at NR\)/.test(body) && /Potential Margin in Stock \(unrealized\)/.test(body), 'but valuation is untouched');
ok(!doc.querySelector('[data-invf="expiring"]'), 'and no Expiring filter');

console.log('— weekly Stock Position never shows expiry, even when a report exists —');
ev(`db.snapshots.lab = [{id:'w1', asOf:'2026-02-01', fileName:'marg.xlsx', by:'Bhagavan', at:1, rows:[
  {name:'Alpha', batch:'BX', expiry:'2026-03', qty:40, nr:12, mrp:25}]}];`);
const wkSec = ev(`stockSection('lab','2026-02-01','weekly','2026-01-26', true)`);
ok(!/Expiry bucket/.test(wkSec), 'weekly carries no expiry buckets — expiry is a monthly section');
ok(!/data-expup/.test(wkSec), 'and never asks for the batch report');
ok(/Stock value \(at NR\)/.test(wkSec) && /Stock value \(at MRP\)/.test(wkSec), 'but both valuation bases are there');
ok(/Potential Margin in Stock \(unrealized\)/.test(wkSec), 'and the potential margin, still labelled unrealized');
ok(/Computed from the inventory ledger/.test(wkSec), 'and it says it derives from the inventory ledger');
ok(/Movement/.test(wkSec), 'and the movement block is untouched');
const moSec = ev(`stockSection('lab','2026-02-01','monthly','2026-01-01')`);
ok(/Expiry bucket/.test(moSec), 'monthly still gets the expiry buckets');
ok(ev(`REPORT_SECTIONS.weekly.find(s=>s.id===6).needsExpiry`) === undefined, 'the weekly section no longer declares needsExpiry');
ok(ev(`REPORT_SECTIONS.monthly.filter(s=>s.needsExpiry).map(s=>s.id).join()`) === '8,19', 'only the monthly sections do', ev(`REPORT_SECTIONS.monthly.filter(s=>s.needsExpiry).map(s=>s.id).join()`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
