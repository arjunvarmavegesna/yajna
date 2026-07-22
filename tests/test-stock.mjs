/* Tests: batch-level stock valuation — two bases, as-of reconstruction, three modes */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';

const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 90) => new Promise(r => setTimeout(r, ms));
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

const adm = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });

console.log('— server: the batch lives on the purchase line —');
const D0 = addD(T, -20);
await adm.req('POST', '/items/opening', { hid: 'mithra', stockDate: D0, rows: [{ name: 'Tab. Stocky', qty: 100, nr: 10, mrp: 20 }] });
const day = (o = {}) => ({ purchases: [], rtv: [], itemSales: [], hv: [], invoices: o.invoices || [],
  sales: { mrp: 0, cogs: 0, cash: 0, credit: 0, cancels: 0 }, cash: {}, audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, ...o });

let r = await adm.req('PUT', `/entries/mithra/${addD(T, -10)}`, { entry: day({ invoices: [
  { id: 'i1', vendor: 'V', invoiceNo: '1', date: addD(T, -10), lines: [
    { item: 'Tab. Stocky', batch: 'B-ALPHA', exp: '2027-06', pqty: 10, oqty: 2, rate: 100, disc: 5, gst: 5, mrp: 150 }] }] }) });
ok(r.status === 200, 'invoice with a batch saves');
let boot = (await adm.req('GET', '/bootstrap')).data;
let line = boot.dailyData.mithra[addD(T, -10)].invoices[0].lines[0];
ok(line.batch === 'B-ALPHA' && line.exp === '2027-06', 'batch number and expiry round-trip', JSON.stringify({ b: line.batch, e: line.exp }));
ok(near(line.nr, 83.125), 'net rate is frozen from THIS line — 997.50 over 12 units', line.nr);
r = await adm.req('PUT', `/entries/mithra/${addD(T, -9)}`, { entry: day({ invoices: [
  { id: 'i2', vendor: 'V', invoiceNo: '2', date: addD(T, -9), lines: [{ item: 'X', batch: 'B', exp: '2027-13', pqty: 1, rate: 1, mrp: 2 }] }] }) });
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.dailyData.mithra[addD(T, -9)].invoices[0].lines[0].exp === '', 'a malformed expiry is rejected, not stored raw');
ok(boot.hospitals.mithra.issueMethod === 'fefo', 'FEFO is the shipped default', boot.hospitals.mithra.issueMethod);
ok(Array.isArray(boot.issueMethods) && boot.issueMethods.join() === 'fefo,fifo', 'both issue methods reach the client');
r = await adm.req('PATCH', '/hospitals/mithra', { issueMethod: 'fifo' });
ok(r.data.hospital.issueMethod === 'fifo', 'issue method is a hospital-level config');
r = await adm.req('PATCH', '/hospitals/mithra', { issueMethod: 'lifo' });
ok(r.data.hospital.issueMethod === 'fifo', 'an unknown issue method is refused');
await adm.req('PATCH', '/hospitals/mithra', { issueMethod: 'fefo' });

console.log('— DOM —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {}; w.confirm = () => true;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const w = dom.window, doc = w.document;
await tick(300);
doc.querySelector('[data-quick="admin"]').click();
await tick(700);
const ev = s => w.eval(s);
const J = s => JSON.parse(w.eval(`JSON.stringify(${s})`));

/* a controlled hospital: two batches of one brand at different rates and MRPs */
ev(`
  db.hospitals.lab = {id:'lab', name:'Lab', doctor:'D', location:'', phone:'', startDate:'2026-01-01', stockDate:'2026-01-10', issueMethod:'fefo', active:true, base:1000};
  db.items.lab = [{id:'l1', name:'Alpha', key:'alpha', pack:'10s', nr:10, mrp:20, openingQty:100, source:'t', updatedAt:1}];
  db.adjustments.lab = []; db.dailyData.lab = {}; db.vendors.lab = []; db.payments.lab = []; db.receivables.lab = []; db.recvActions.lab = [];
  const mk = (d, o) => db.dailyData.lab[d] = Object.assign({purchases:[],rtv:[],invoices:[],itemSales:[],hv:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1}, o);
  // 20 Jan: 50 @ NR 12, MRP 25, expires 2027-06
  mk('2026-01-20', {invoices:[{id:'a', vendor:'V1', invoiceNo:'A', date:'2026-01-20', lines:[
    {item:'Alpha', batch:'BX', exp:'2027-06', pqty:50, oqty:0, rate:12, disc:0, gst:0, mrp:25}]}]});
  // 25 Jan: 40 @ NR 15, MRP 30, expires 2026-09 — EARLIER expiry, LATER receipt
  mk('2026-01-25', {invoices:[{id:'b', vendor:'V2', invoiceNo:'B', date:'2026-01-25', lines:[
    {item:'Alpha', batch:'BY', exp:'2026-09', pqty:40, oqty:0, rate:15, disc:0, gst:0, mrp:30}]}]});
`);

console.log('— PART 2: batch-level costing —');
let L = J(`stockLedger('lab')`);
ok(L.lots.length === 3, 'three lots: OPENING + two purchases', L.lots.length);
const opening = L.lots.find(l => l.batchNo === 'OPENING');
ok(opening && opening.synthetic === 'opening' && opening.exp === null, 'opening stock becomes a synthetic OPENING batch with no expiry', JSON.stringify(opening && { b: opening.batchNo, s: opening.synthetic, e: opening.exp }));
ok(opening.nr === 10 && opening.mrp === 20, 'valued from the opening load');
const bx = L.lots.find(l => l.batchNo === 'BX'), by = L.lots.find(l => l.batchNo === 'BY');
ok(bx.nr === 12 && bx.mrp === 25, 'batch BX froze its own net rate and MRP', bx.nr + '/' + bx.mrp);
ok(by.nr === 15 && by.mrp === 30, 'batch BY froze DIFFERENT ones — same brand, different batch', by.nr + '/' + by.mrp);

console.log('— PART 1: two bases, never conflated —');
let s = J(`stockAsOf('lab','2026-01-31')`);
// 100@10 + 50@12 + 40@15 = 1000 + 600 + 600 = 2200
ok(near(s.valueNr, 2200), 'stock value at NR = 2,200 — the sum of each batch at ITS OWN rate', s.valueNr);
// 100@20 + 50@25 + 40@30 = 2000 + 1250 + 1200 = 4450
ok(near(s.valueMrp, 4450), 'stock value at MRP = 4,450 — each batch at ITS OWN printed MRP', s.valueMrp);
ok(near(s.potentialRs, 2250), 'potential margin = 4,450 − 2,200 = 2,250', s.potentialRs);
ok(near(s.potentialPct, 2250 / 4450 * 100), 'potential margin % = margin ÷ MRP value', s.potentialPct);
// an item-level average would get this wrong
const avgNr = (10 + 12 + 15) / 3;
ok(!near(s.valueNr, 190 * avgNr), 'an item-level average rate would NOT reproduce this — batch costing matters', Math.round(190 * avgNr));

console.log('— PART 3: FEFO —');
ev(`db.dailyData.lab['2026-02-01'] = Object.assign({purchases:[],rtv:[],invoices:[],hv:[],
  sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1},
  {itemSales:[{item:'Alpha', qty:130, amount:0}]});`);
s = J(`stockAsOf('lab','2026-02-01')`);
const q = n => s.batches.find(b => b.batchNo === n).qty;
// FEFO: OPENING (undated = oldest on the shelf) 100, then BY (Sep 26) 30 of 40. BX (Jun 27) untouched.
ok(q('OPENING') === 0, 'FEFO drained the undated opening stock first — it is the oldest on the shelf', q('OPENING'));
ok(q('BY') === 10, 'then BY, which expires Sep 2026 — 30 of its 40 taken', q('BY'));
ok(q('BX') === 50, 'BX is untouched: it expires Jun 2027, so it goes out LAST despite arriving FIRST', q('BX'));
ok(near(s.valueNr, 10 * 15 + 50 * 12), 'and the value follows the batches that actually remain', s.valueNr);

ev(`db.hospitals.lab.issueMethod='fifo';`);
s = J(`stockAsOf('lab','2026-02-01')`);
const qf = n => s.batches.find(b => b.batchNo === n).qty;
ok(qf('OPENING') === 0 && qf('BX') === 20 && qf('BY') === 40, 'switched to FIFO: opening, then BX (received first), BY untouched', [qf('OPENING'), qf('BX'), qf('BY')].join('/'));
ok(J(`stockAsOf('lab','2026-02-01')`).method === 'fifo', 'the method is reported with the position');
ev(`db.hospitals.lab.issueMethod='fefo';`);

console.log('— PART 3: as-of comes from movement dates, never current stock —');
ok(J(`stockAsOf('lab','2026-01-15')`).valueNr === 1000, 'as-of 15 Jan: only opening exists — 1,000', J(`stockAsOf('lab','2026-01-15')`).valueNr);
ok(J(`stockAsOf('lab','2026-01-22')`).valueNr === 1600, 'as-of 22 Jan: BX has arrived — 1,600');
ok(near(J(`stockAsOf('lab','2026-01-31')`).valueNr, 2200), 'as-of 31 Jan: both batches — 2,200');
ok(near(J(`stockAsOf('lab','2026-02-01')`).valueNr, 750), 'as-of 1 Feb: after the sale — 750');
ok(J(`stockAsOf('lab','2026-01-15').batches.length`) === 1, 'a batch that had not arrived yet does not appear in an earlier position');
ok(J(`stockAsOf('lab','2026-01-05').valueNr`) === 0, 'before the opening load there is nothing');

console.log('— counted_from: pre-count values are unverified —');
ok(J(`stockAsOf('lab','2026-01-09')`).unverified === true, 'a date before the physical count is marked unverified');
ok(J(`stockAsOf('lab','2026-01-10')`).unverified === false, 'the count date itself is verified');
ok(J(`stockAsOf('lab','2026-02-01')`).unverified === false, 'and everything after it');
const secU = w.eval(`stockSection('lab','2026-01-09','daily')`);   // before the 10 Jan count
ok(/[Uu]nverified/.test(secU), 'the report marks it unverified');
ok(/reconstruction, not an audited figure/.test(secU), 'and says plainly it is not audited', /reconstruction/.test(secU));

console.log('— negative stock is a defect, never clamped —');
ev(`db.dailyData.lab['2026-02-02'] = Object.assign({purchases:[],rtv:[],invoices:[],hv:[],
  sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1},
  {itemSales:[{item:'Alpha', qty:100, amount:0}]});`);   // only 60 left — 40 short
s = J(`stockAsOf('lab','2026-02-02')`);
ok(s.items[0].stock === -40, 'selling 100 when 60 remain leaves −40 — NOT clamped to zero', s.items[0].stock);
ok(s.valueNr < 0, 'and the value goes negative with it', s.valueNr);
ok(s.negBatches.length > 0, 'the negative batch is surfaced');
ok(s.potentialRs === 0, 'potential margin EXCLUDES negative stock — a negative at MRP is nonsense', s.potentialRs);
ok(w.eval(`stockAsOf('lab','2026-02-02').items[0].potentialRs`) <= 0, 'the item rollup excludes it too');
const negSec = w.eval(`stockSection('lab','2026-02-02','daily')`);
ok(/negative stock/i.test(negSec), 'the report carries a data-integrity line');
ok(/excluded from potential margin/i.test(negSec), 'saying they are excluded from potential margin');

console.log('— bounces never touch the stock ledger —');
ev(`db.dailyData.lab['2026-02-03'] = Object.assign({purchases:[],rtv:[],invoices:[],itemSales:[],hv:[],
  sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, savedAt:1},
  {audit:{opening:0,actual:'',unbilled:false,bounces:[{brand:'Alpha', molecule:'A', qty:500, mrp:20, reason:'out_of_stock', action:'lost_sale', prescriber:'', department:'', remarks:''}]}});`);
const before = J(`stockAsOf('lab','2026-02-02')`).valueNr;
ok(near(J(`stockAsOf('lab','2026-02-03')`).valueNr, before), 'a 500-unit bounce moves NO stock — nothing was dispensed', J(`stockAsOf('lab','2026-02-03')`).valueNr);
ok(J(`stockLedger('lab').movements.filter(m=>m.type==='bounce').length`) === 0, 'and writes no movement to the ledger');

console.log('— RTV is an outward movement —');
ev(`db.dailyData.lab['2026-02-04'] = Object.assign({purchases:[],invoices:[],itemSales:[],hv:[],
  sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1},
  {rtv:[{drug:'Alpha', vendor:'V1', qty:5, value:0, reason:'Expiry', status:'Pending'}]});`);
const rtvMv = J(`stockLedger('lab').movements.filter(m=>m.type==='rtv')`);
ok(rtvMv.length > 0 && rtvMv.every(m => m.qty < 0), 'RTV writes a NEGATIVE movement', JSON.stringify(rtvMv.map(m => m.qty)));

console.log('— PART 4 MODE B: movement reconciles —');
ev(`delete db.dailyData.lab['2026-02-02']; delete db.dailyData.lab['2026-02-04'];`);
let m = J(`stockMovement('lab','2026-01-01','2026-02-01')`);
ok(near(m.opening, 0), 'opening at 1 Jan is nil — nothing had arrived', m.opening);
ok(near(m.closing, 750), 'closing at 1 Feb is 750', m.closing);
ok(near(m.purchases, 1200), 'purchases in range = 600 + 600 at net rate', m.purchases);
ok(near(m.sales, 1450), 'sales come out at NET RATE: 100×10 + 30×15 = 1,450', m.sales);
ok(m.reconciles && near(m.variance, 0), 'and it reconciles to the penny against the closing position', m.variance);
// a sale valued at MRP would be a category error
ok(!near(m.sales, 100 * 20 + 30 * 30), 'deducting sales at MRP (2,900) would be a category error — this is a cost ledger', m.sales);
m = J(`stockMovement('lab','2026-01-26','2026-02-01')`);
ok(near(m.opening, 2200), 'opening on 26 Jan = the close of 25 Jan, i.e. what you start the day with', m.opening);
ok(near(m.opening + m.openingLoads + m.purchases - m.sales - m.rtv - m.expiry + m.adjustments, m.closing), 'the block adds up');

console.log('— expiry write-offs are their own movement —');
ev(`db.adjustments.lab = [{id:'a1', key:'alpha', item:'Alpha', date:'2026-02-01', qty:-10, reason:'Expiry write-off', note:'past date', user:'Bhagavan'}];`);
m = J(`stockMovement('lab','2026-01-01','2026-02-01')`);
ok(m.expiry > 0, 'an Expiry write-off adjustment books as an expiry write-off, not a plain adjustment', m.expiry);
ok(m.expiryRows.length === 1 && m.expiryRows[0].by === 'Bhagavan', 'listed with its reason and who did it');
ok(near(m.adjustments, 0), 'and it does NOT double-count as an adjustment', m.adjustments);
ev(`db.adjustments.lab = [{id:'a2', key:'alpha', item:'Alpha', date:'2026-02-01', qty:-10, reason:'Damage / breakage', note:'', user:'Bhagavan'}];`);
m = J(`stockMovement('lab','2026-01-01','2026-02-01')`);
ok(m.adjustments < 0 && near(m.expiry, 0), 'a damage adjustment books as an adjustment, not an expiry');
ev(`db.adjustments.lab = [];`);

console.log('— PART 4 MODE C: snapshots, never sums —');
const ser = J(`stockSeries('lab','2026-01-15','2026-02-01','daily')`);
ok(ser.length === 18, '18 daily positions', ser.length);
ok(ser[0].valueNr === 1000 && ser[ser.length - 1].valueNr === 750, 'each point is the value ON that day', ser[0].valueNr + '..' + ser[ser.length - 1].valueNr);
const sum = ser.reduce((a, p) => a + p.valueNr, 0);
ok(sum > 20000 && ser[ser.length - 1].valueNr === 750, 'summing them would give ' + Math.round(sum) + ' — meaningless; the series is 18 balances');
const mser = J(`stockSeries('lab','2026-01-01','2026-02-28','monthly')`);
ok(mser.length === 2, 'a two-month range is 2 positions, not 2 totals', mser.length);
ok(mser[0].date === '2026-01-31', 'monthly points land on month ends', mser[0].date);
const wser = J(`stockSeries('lab','2026-01-05','2026-02-01','weekly')`);
ok(wser.every(p => p.date >= '2026-01-05' && p.date <= '2026-02-01'), 'weekly points stay inside the range');

/* PART 5 — expiry buckets now derive from the uploaded batch report, not from
   the purchase lines. That whole surface is covered in test-expiry.mjs. What
   belongs here is only that valuation does not depend on any of it. */
console.log('— expiry is not a valuation input —');
const noExpVal = J(`stockAsOf('lab','2026-02-01')`).valueNr;
ev(`db.snapshots.lab = [{id:'x1', asOf:'2026-02-01', fileName:'f', by:'B', at:1, rows:[
  {name:'Alpha', batch:'ANY', expiry:'2026-03', qty:9999, nr:999, mrp:9999}]}];`);
ok(near(J(`stockAsOf('lab','2026-02-01')`).valueNr, noExpVal),
   'uploading a batch report does NOT move the stock valuation — the two records stay independent', J(`stockAsOf('lab','2026-02-01')`).valueNr);
ok(near(J(`stockMovement('lab','2026-01-01','2026-02-01')`).closing, noExpVal), 'nor the movement block');
ev(`db.snapshots.lab = [];`);

console.log('— PART 6: the item table —');
s = J(`stockAsOf('lab','2026-02-01')`);
const alpha = s.items.find(i => i.key === 'alpha');
ok(alpha.batches.length >= 2, 'the item row rolls up its batches', alpha.batches.length);
ok(near(alpha.valueNr, 750) && near(alpha.valueMrp, 1550), 'with both bases — 10@30 + 50@25 = 1,550 at MRP', alpha.valueNr + '/' + alpha.valueMrp);
ok(alpha.nearestExp === '2026-09', 'nearest expiry across batches with stock', alpha.nearestExp);
ok(near(alpha.opening, 100) && near(alpha.purchased, 90) && near(alpha.sold, 130), 'opening / purchased / sold still roll up', [alpha.opening, alpha.purchased, alpha.sold].join('/'));
// negative margin: a batch whose MRP is at or below its net rate
ev(`db.dailyData.lab['2026-01-31'] = Object.assign({purchases:[],rtv:[],itemSales:[],hv:[],
  sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1},
  {invoices:[{id:'d', vendor:'V', invoiceNo:'D', date:'2026-01-31', lines:[{item:'Gamma', batch:'BAD', exp:'2028-01', pqty:5, oqty:0, rate:20, disc:0, gst:0, mrp:18}]}]});`);
s = J(`stockAsOf('lab','2026-02-01')`);
const bad = s.live.find(b => b.batchNo === 'BAD');
ok(bad.negMargin === true, 'a batch with MRP below net rate is flagged as negative margin');
ok(s.items.find(i => i.key === 'gamma').negMargin === true, 'and the item row carries the flag for the filter');
ok(s.live.find(b => b.batchNo === 'BX').negMargin === false, 'a healthy batch is not');

console.log('— PART 7: POSITION is never summed across days —');
const wk = w.eval(`stockSection('lab','2026-02-01','weekly','2026-01-26')`);
ok(/Position as on/.test(wk), 'the section states the date it is a position on');
ok(/Movement/.test(wk), 'weekly adds the movement block');
const mo = w.eval(`stockSection('lab','2026-02-01','monthly','2026-01-01')`);
ok(/Non-moving stock/.test(mo), 'monthly adds non-moving stock');
ok(/Negative margin/.test(mo), 'and the negative-margin list');
ok(/Expiry write-offs booked this month|No expiry write-offs/.test(mo), 'and expiry write-offs booked in the month');
const dly = w.eval(`stockSection('lab','2026-02-01','daily')`);
ok(!/Movement/.test(dly), 'daily carries no movement block');
ok(/Potential Margin in Stock \(unrealized\)/.test(dly), 'the label is exactly "Potential Margin in Stock (unrealized)"');
ok(/unrealized/.test(dly) && /never enters the margin baseline/.test(dly), 'and the report says it never enters the baseline');
// the value on the last day, not the sum of the week
const wkVal = J(`stockAsOf('lab','2026-02-01')`).valueNr;
const weekSum = ['2026-01-26','2026-01-27','2026-01-28','2026-01-29','2026-01-30','2026-01-31','2026-02-01']
  .reduce((a, d) => a + J(`stockAsOf('lab','${d}')`).valueNr, 0);
ok(wk.includes(fmtOf(wkVal)) && !wk.includes(fmtOf(weekSum)), 'the weekly section prints the LAST day’s value, not the seven-day sum', fmtOf(wkVal) + ' vs ' + fmtOf(weekSum));
function fmtOf(v) { return w.eval(`fmtRs(${v})`); }

console.log('— registry —');
ok(ev(`REPORT_SECTIONS.weekly.find(s=>s.id===6).kind`) === 'position', 'Stock Position is POSITION');
ok(ev(`REPORT_SECTIONS.weekly.find(s=>s.id===6).auto`) === true, 'and AUTO');
ok(ev(`PERIOD_EDITORS.weekly[6]`) === undefined, 'its weekly editor is GONE');
ok(ev(`PERIOD_EDITORS.monthly[8]`) === undefined, 'so is Expiry Watch — it derives from batch expiry now');
ok(ev(`PERIOD_EDITORS.monthly[9]`) === undefined, 'and Slow Moving — it derives from sale movements');
ok(ev(`['weekly','monthly'].every(t=>REPORT_SECTIONS[t].filter(s=>s.auto).every(s=>!PERIOD_EDITORS[t][s.id]))`), 'no auto section anywhere has an editor');
ok(ev(`REPORT_SECTIONS.monthly.find(s=>s.id===19).t`) === 'Stock Position', 'monthly gained a Stock Position section');
ok(ev(`REPORT_SECTIONS.daily.find(s=>s.id===7).t`) === 'Stock Position', 'so did daily');

console.log('— DOM: the inventory tab —');
ev(`db.snapshots.mithra = [{id:'m1', asOf: todayISO(), fileName:'marg.xlsx', by:'Bhagavan', at:1, rows:[
  {name:'Tab. Rifaximin 550', batch:'R1', expiry:'2026-09', qty:20, nr:298, mrp:412}]}];
  state.hospital='mithra'; state.view='hospital'; state.hospTab='inventory'; state.inv=null; state.invFilter='all'; state.invQuery='';`);
ev(`renderHospitalWorkspace()`); await tick(400);
ok(!!doc.querySelector('[data-invm="asof"]'), 'the three modes are on the tab');
ok(!!doc.querySelector('[data-invm="between"]') && !!doc.querySelector('[data-invm="trend"]'), 'as-of / between / trend');
ok(!!doc.querySelector('#invAsOf'), 'as-of is the default mode');
ok(doc.querySelectorAll('[data-invq]').length === 5, 'five quick picks', doc.querySelectorAll('[data-invq]').length);
let body = doc.querySelector('#invBody').textContent;
ok(/Stock value \(at NR\)/.test(body) && /Stock value \(at MRP\)/.test(body), 'both bases are shown');
ok(/Potential Margin in Stock \(unrealized\)/.test(body), 'labelled exactly, with the word Potential');
ok(/Expiry risk/.test(body), 'expiry risk buckets render');
ok(!!doc.querySelector('[data-invf="expiring"]'), 'filter: expiring');
['nonmoving', 'negmargin'].forEach(f => ok(!doc.querySelector(`[data-invf="${f}"]`), `the ${f} chip is gone — the lists live in the Reports, not the filter bar`));
ok(/Shelf vs books/.test(doc.querySelector('#invBody').textContent), 'and the shelf-vs-books reconciliation appears with the report');
ok(!!doc.querySelector('[data-invexp]'), 'rows expand to batch detail');
doc.querySelector('[data-invexp]').click(); await tick(250);
const bt = doc.querySelector('#invBody').textContent;
ok(/Net rate/.test(bt) && /Received/.test(bt), 'the batch table shows net rate and received date');
doc.querySelector('[data-invm="between"]').click(); await tick(300);
body = doc.querySelector('#invBody').textContent;
ok(/Opening stock value/.test(body) && /Closing stock value/.test(body), 'Mode B renders the movement');
ok(/Sales \(COGS at net rate\)/.test(body), 'and says sales come out at net rate');
ok(!!doc.querySelector('#invStart') && !!doc.querySelector('#invEnd'), 'with two date controls');
doc.querySelector('[data-invm="trend"]').click(); await tick(400);
ok(!!doc.querySelector('#invBody svg'), 'Mode C draws a chart');
ok(doc.querySelectorAll('#invBody svg path').length === 2, 'two series — NR and MRP', doc.querySelectorAll('#invBody svg path').length);
ok(!!doc.querySelector('#invInt'), 'with an interval picker');
body = doc.querySelector('#invBody').textContent;
ok(/snapshots, not totals/.test(body), 'and says plainly they are snapshots, not totals');

console.log('— batch and expiry are never keyed during a manual audit —');
ev(`state.hospTab='entry'; state.entryMode='daily'; state.date=todayISO(); state.entryTab=0; renderHospitalWorkspace();`); await tick(350);
ok(ev(`JSON.stringify(blankLine())`).includes('batch'), 'the field stays on the model — the pharmacy expiry report will stamp it on');
const invBtn = doc.querySelector('#invManualTop');
if (invBtn) { invBtn.click(); await tick(300); }
ok(!doc.querySelector('#lmBatch') && !doc.querySelector('#lmExp'), 'but the line dialog has NO batch or expiry input');
ok(!!doc.querySelector('#lmItem') && !!doc.querySelector('#lmRate'), 'it has the fields an audit can actually see on the invoice');
const modal = doc.querySelector('.modal').textContent;
ok(!/Batch/i.test(modal) && !/Expiry/i.test(modal), 'and never mentions either', modal.slice(0, 80));
w.eval('closeModal()'); await tick(120);

console.log('— expiry views appear only when a batch report covers the date —');
ok(w.eval(`hasExpiryData('lab')`) === false, 'purchase lines carrying an expiry are NOT an expiry source — only the uploaded report is');
ev(`db.hospitals.noexp = {id:'noexp', name:'NoExp', doctor:'D', location:'', phone:'', startDate:'2026-01-01', stockDate:'2026-01-10', issueMethod:'fefo', active:true, base:1000};
  db.items.noexp = [{id:'n1', name:'Alpha', key:'alpha', pack:'', nr:10, mrp:20, openingQty:50, source:'t', updatedAt:1}];
  db.adjustments.noexp = []; db.dailyData.noexp = {}; db.vendors.noexp = []; db.payments.noexp = []; db.receivables.noexp = []; db.recvActions.noexp = []; db.snapshots.noexp = [];
  db.dailyData.noexp['2026-01-20'] = {purchases:[],rtv:[],itemSales:[],hv:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1,
    invoices:[{id:'z', vendor:'V', invoiceNo:'Z', date:'2026-01-20', lines:[{item:'Alpha', batch:'', exp:'', pqty:20, oqty:0, rate:12, disc:0, gst:0, mrp:25}]}]};`);
ok(w.eval(`hasExpiryData('noexp')`) === false, 'a hospital with no uploaded report has no expiry data');
// valuation is completely unaffected
const ns = J(`stockAsOf('noexp','2026-01-31')`);
ok(near(ns.valueNr, 50 * 10 + 20 * 12), 'stock still values per lot at each lot’s own frozen rate — 740', ns.valueNr);
ok(near(ns.valueMrp, 50 * 20 + 20 * 25), 'both bases still work — 1,500 at MRP', ns.valueMrp);
ok(near(ns.potentialRs, 1500 - 740), 'and potential margin still computes', ns.potentialRs);
ok(J(`stockMovement('noexp','2026-01-01','2026-01-31')`).reconciles, 'and the movement still reconciles');
ok(ns.batches.length === 2, 'each purchase line is still its own lot without a batch number', ns.batches.length);
// the report asks for the report rather than showing an empty bucket table
const nsec = w.eval(`stockSection('noexp','2026-01-31','daily')`);
ok(!/Expiry bucket/.test(nsec), 'the report omits the expiry buckets entirely');
ok(/data-expup/.test(nsec), 'and offers the upload instead', /data-expup/.test(nsec));
ok(/Stock value \(at NR\)/.test(nsec), 'while still reporting the valuation');
ev(`db.snapshots.noexp = [{id:'ns1', asOf:'2026-01-31', fileName:'f', by:'B', at:1, rows:[
  {name:'Alpha', batch:'A1', expiry:'2026-02', qty:70, nr:11, mrp:22}]}];`);
ok(/Expiry bucket/.test(w.eval(`stockSection('noexp','2026-01-31','daily')`)), 'uploading the report lights the buckets up');
ev(`db.snapshots.noexp = [];`);

// with no expiry on the lines, FEFO and FIFO are the same thing — say so
ok(/receipt order/.test(w.eval(`issueMethodLabel('noexp')`)), 'the tab does not claim FEFO when no line carries an expiry', w.eval(`issueMethodLabel('noexp')`));

console.log('— the inventory tab follows the data —');
ev(`state.hospital='noexp'; state.hospTab='inventory'; state.inv=null; state.invFilter='all'; state.invQuery=''; renderHospitalWorkspace();`); await tick(350);
let nb = doc.querySelector('#invBody').textContent;
ok(!/write-off candidates/.test(nb), 'no expiry risk section without a batch report');
ok(/Stock value \(at NR\)/.test(nb) && /Potential Margin in Stock \(unrealized\)/.test(nb), 'but valuation and potential margin are all there');
ok(!doc.querySelector('[data-invf="expiring"]'), 'and no Expiring filter');
ok(!doc.querySelector('[data-invf="nonmoving"]'), 'no Non-moving chip here either — nonMoving() itself still feeds the monthly report');
ev(`state.invFilter='nonmoving'; renderHospitalWorkspace();`); await tick(300);
ok(doc.querySelectorAll('#invBody tbody tr td b').length > 0, 'a session remembering a removed filter falls back to All instead of an empty table');
ok(/expiry not tracked/.test(nb), 'the header says expiry is not tracked');
ev(`db.snapshots.lab = [{id:'s9', asOf:'2026-02-01', fileName:'f', by:'B', at:1, rows:[
  {name:'Alpha', batch:'BX', expiry:'2026-03', qty:10, nr:12, mrp:25}]}];
  state.hospital='lab'; state.inv={mode:'asof', asOf:'2026-02-01', start:'2026-01-01', end:'2026-02-01', interval:'daily'}; renderHospitalWorkspace();`); await tick(350);
nb = doc.querySelector('#invBody').textContent;
ok(/write-off candidates/.test(nb), 'the same tab shows expiry risk once a batch report is uploaded');
ok(!!doc.querySelector('[data-invf="expiring"]'), 'and the Expiring filter comes back');
ev(`db.snapshots.lab = [];`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
