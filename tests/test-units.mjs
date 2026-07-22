/* Tests: tablets → strips at the door. The ledger's unit is a STRIP; the
   pharmacy software counts loose tablets; the conversion divides qty by the
   pack and multiplies the rates by it, so every rupee stays exactly put. */
import { JSDOM } from 'jsdom';
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 200) => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const w = dom.window, doc = w.document;
await tick(400);
doc.querySelector('[data-quick="admin"]').click(); await tick(700);

console.log('— packUnits reads the strip size out of whatever the pack column says —');
for (const [pack, want] of [['10s', 10], ['15s', 15], ['10', 10], ['1x15', 1], ['Strip of 10', 10], ['vial', null], ['btl', null], ['', null]])
  ok(w.eval(`JSON.stringify(packUnits(${JSON.stringify(pack)}))`) === JSON.stringify(want), `packUnits('${pack}') = ${want}`, w.eval(`packUnits(${JSON.stringify(pack)})`));

console.log('— the conversion: qty ÷ pack, rates × pack —');
w.eval(`db.items.viraj = [{id:'u1', name:'Tab. Unit Test', key:nameKey('Tab. Unit Test'), pack:'10s', nr:300, mrp:400, openingQty:0, source:'demo', updatedAt:Date.now()}]`);
const cv = w.eval(`JSON.parse(JSON.stringify(tabletsToStrips([
  {item:'Tab. Unit Test', qty:15, nr:30, mrp:40, amount:600, pack:'10s'},
  {item:'Syrup NoPack',  qty:3,  nr:90, mrp:120, amount:360, pack:''},
  {item:'Tab. Unit Test', qty:7, nr:30, mrp:40, amount:280, pack:''}
], 'viraj', 'item')))`);
ok(cv.rows[0].qty === 1.5, '15 tablets of a 10s = 1.5 strips — the exact case Arjun gave', cv.rows[0].qty);
ok(cv.rows[0].nr === 300 && cv.rows[0].mrp === 400, 'per-tablet rates become per-strip rates (× pack)', `${cv.rows[0].nr}/${cv.rows[0].mrp}`);
ok(Math.abs(cv.rows[0].qty * cv.rows[0].nr - 15 * 30) < 0.001, 'the rupees do not move: 1.5 × 300 ≡ 15 × 30', cv.rows[0].qty * cv.rows[0].nr);
ok(cv.rows[2].qty === 0.7, 'a row with no pack of its own borrows the pack from the Item Master', cv.rows[2].qty);
ok(cv.rows[1].qty === 3 && cv.unknown.includes('Syrup NoPack'), 'no pack anywhere → left untouched and NAMED, never silently divided', JSON.stringify(cv.unknown));
ok(cv.rows[0].amount === 600, 'the sale amount is a rupee figure — conversion never touches it');

console.log('— margin % is unit-proof, the master tally is not — that is why conversion matters —');
const before = w.eval(`(40-30)/40*100`), after = w.eval(`(400-300)/400*100`);
ok(before === after, 'the margin ratio is identical in tablets and strips — 25% either way');
ok(w.eval(`lineStatus('viraj', {item:'Tab. Unit Test', pqty:1, oqty:0, rate:300, disc:0, gst:0, mrp:400}).status`) === 'match',
   'converted per-strip rates tally against the master', 'converted → match');
ok(w.eval(`lineStatus('viraj', {item:'Tab. Unit Test', pqty:1, oqty:0, rate:30, disc:0, gst:0, mrp:40}).status`) === 'match',
   'and so do unconverted ones — the tally is a RATIO and cannot catch a unit error, which is exactly why the ledger needs the conversion');

console.log('— the stock ledger sees strips after conversion —');
w.eval(`
  const T = todayISO();
  db.hospitals.viraj.stockDate = addDays(T,-1);
  db.items.viraj[0].openingQty = 10;
  db.adjustments.viraj = []; db.dailyData.viraj = {};
  const conv = tabletsToStrips([{item:'Tab. Unit Test', qty:15, nr:30, mrp:40, amount:600, pack:'10s'}], 'viraj', 'item');
  db.dailyData.viraj[T] = { savedAt:Date.now(), purchases:[], rtv:[], invoices:[],
    sales:{mrp:600,cogs:450,cash:600,credit:0,cancels:0},
    cash:{opening:0,receipts:0,payments:0,actual:'',reason:''},
    itemSales: conv.rows.map(r=>({item:r.item, qty:r.qty, amount:r.amount, pack:r.pack, nr:r.nr, mrp:r.mrp})),
    audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[] };
`);
const stock = w.eval(`stockAsOf('viraj', todayISO()).items.find(m=>m.key===nameKey('Tab. Unit Test')).stock`);
ok(Math.abs(stock - 8.5) < 0.001, 'stock = 10 opening − 1.5 strips sold = 8.5 — not 10 − 15 = −5', stock);
const soldRow = w.eval(`stockAsOf('viraj', todayISO()).items.find(m=>m.key===nameKey('Tab. Unit Test')).sold`);
ok(Math.abs(soldRow - 1.5) < 0.001, 'and the Sold column reads 1.5 strips', soldRow);

console.log('— the choice is remembered and offered on both doors —');
ok(w.eval(`typeof fileUnits`) === 'function' && w.eval(`fileUnits()`) === 'strips', 'strips is the default — the template asks for strips');
w.eval(`setFileUnits('tablets')`);
ok(w.eval(`fileUnits()`) === 'tablets', 'the tablets choice is remembered for next time');
w.eval(`setFileUnits('strips')`);
ok(/Tablets \(loose\)/.test(w.eval(`unitsSeg('x','strips')`)), 'the seg offers Strips | Tablets');
ok(/1\.5 strips/.test(w.eval(`unitsSeg('x','tablets')`)), 'and in tablets mode it states the arithmetic in plain words');
// the opening-stock door carries the same seg
w.eval(`openHospital('viraj','inventory')`); await tick(300);
w.eval(`openingStockModal('viraj')`); await tick(250);
w.eval(`$('#osPaste').value = 'Tab. Unit Test,15,30,40,10s'; $('#osRead').click()`); await tick(300);
ok(!!doc.querySelector('[data-osu="tablets"]'), 'the opening import offers the units choice');
doc.querySelector('[data-osu="tablets"]').click(); await tick(250);
ok(/1\.5/.test(doc.querySelector('#osPrev').textContent), 'switch to tablets and 15 becomes 1.5 strips in the preview', doc.querySelector('#osPrev').textContent.slice(0, 120));
w.eval(`setFileUnits('strips'); closeModal()`); await tick(150);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
