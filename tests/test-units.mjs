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

console.log('— the Inventory table shows tablets without doubling the columns —');
w.eval(`openHospital('viraj','inventory'); invState().mode='asof'; invState().qtyView='both'; renderInventory();`); await tick(400);
ok([...doc.querySelectorAll('[data-invqv]')].map(b=>b.dataset.invqv).join() === 'strips,tablets,both', 'a Strips / Tablets / Both view seg', [...doc.querySelectorAll('[data-invqv]')].length);
// stock is 8.5 strips of a 10s from the earlier world → 85 tabs on the subline
ok(/85 tabs/.test(doc.querySelector('#invBody').textContent), 'Both: the grey subline carries the tablet equivalent (8.5 strips → 85 tabs)');
doc.querySelector('[data-invqv="strips"]').click(); await tick(300);
ok(!/tabs/.test(doc.querySelector('#invBody').textContent), 'Strips: the sublines disappear');
doc.querySelector('[data-invqv="tablets"]').click(); await tick(300);
ok(/8\.5 strips/.test(doc.querySelector('#invBody').textContent), 'Tablets: tabs lead and strips move to the subline — the ledger number is never hidden');
w.eval(`invState().qtyView='both'`);

console.log('— the default follows the FILE SHAPE, remembered per hospital —');
ok(w.eval(`fileUnits('viraj','template')`) === 'strips', 'our template asks for strips, so template files default to strips');
ok(w.eval(`fileUnits('viraj','ai')`) === 'tablets', 'a free-form Marg export counts loose — it defaults to TABLETS');
ok(w.eval(`fileUnits('viraj')`) === 'tablets', 'no source known = free-form = tablets');
w.eval(`setFileUnits('viraj','ai','strips')`);
ok(w.eval(`fileUnits('viraj','ai')`) === 'strips', 'a choice is remembered for that hospital and file shape');
ok(w.eval(`fileUnits('siri','ai')`) === 'tablets', 'without leaking to another hospital');
ok(w.eval(`fileUnits('viraj','template')`) === 'strips', 'and template files keep their own memory');
w.eval(`setFileUnits('viraj','ai','tablets')`);
ok(/Tablets \(loose\)/.test(w.eval(`unitsSeg('x','strips')`)), 'the seg offers Strips | Tablets');
ok(/1\.5 strips/.test(w.eval(`unitsSeg('x','tablets')`)), 'and in tablets mode it states the arithmetic in plain words');

console.log('— toggling re-scales qty and rates TOGETHER: values do not move —');
{
  const rows = [{name:'Tab. Unit Test', qty:150, nr:30, mrp:40, pack:'10s'}];
  const conv = w.eval(`JSON.parse(JSON.stringify(tabletsToStrips(${JSON.stringify(rows)}, 'viraj', 'name').rows[0]))`);
  const rawNr = 150*30, rawMrp = 150*40;
  ok(Math.abs(conv.qty*conv.nr - rawNr) < 0.001, 'VALUE (NR) identical in both modes: 150×30 ≡ 15×300', conv.qty*conv.nr);
  ok(Math.abs(conv.qty*conv.mrp - rawMrp) < 0.001, 'MRP VALUE identical too', conv.qty*conv.mrp);
  ok(conv.srcQty === 150 && conv.packU === 10, 'the preview annotation carries "150 → 15 strips (10s)"', `${conv.srcQty}/${conv.packU}`);
}

console.log('— importing 15 tablets ≡ entering 1.5 strips directly, to the rupee —');
{
  const asTabs = w.eval(`(()=>{ const r = tabletsToStrips([{item:'Tab. Unit Test', qty:15, nr:30, mrp:40, pack:'10s'}],'viraj','item').rows[0]; return r.qty*r.nr; })()`);
  ok(Math.abs(asTabs - 1.5*300) < 0.001, '15 tablets @ ₹30 lands as exactly what 1.5 strips @ ₹300 would', asTabs);
}

console.log('— the snapshot reconciles strips to strips —');
w.eval(`
  const T = todayISO();
  db.hospitals.viraj.stockDate = addDays(T,-1);
  db.items.viraj = [{id:'u1', name:'Tab. Unit Test', key:nameKey('Tab. Unit Test'), pack:'10s', nr:300, mrp:400, openingQty:2, source:'demo', updatedAt:Date.now()}];
  db.adjustments.viraj = []; db.dailyData.viraj = {};
  // the modal converts BEFORE saving — a 20-tablet shelf row becomes 2 strips
  const conv = tabletsToStrips([{name:'Tab. Unit Test', batch:'B1', expiry:'2099-01', qty:20, nr:30, mrp:40}], 'viraj', 'name')
    .rows.map(({srcQty, packU, ...rest})=> rest);
  db.snapshots.viraj = [{id:'snap1', asOf:T, fileName:'t.xlsx', rows:conv, by:'Test', at:Date.now()}];
`);
const rec = w.eval(`JSON.parse(JSON.stringify(snapReconcile('viraj', todayISO())))`);
ok(rec.mismatched.length === 0, 'their 20 tablets vs our 2 strips reconciles with ZERO gap', JSON.stringify(rec.mismatched));
ok(Math.abs(rec.theirValue - 600) < 0.001 && Math.abs(rec.ourValue - 600) < 0.001, 'and both sides value at ₹600', `${rec.theirValue}/${rec.ourValue}`);

console.log('— RTV: 20 tablets typed in the helper leaves as 2 strips —');
w.eval(`state.date = todayISO(); openHospital('viraj','entry'); state.entryTab = 0; renderEntry();`); await tick(400);
w.eval(`$('#addRtv').click()`); await tick(250);
ok(!!doc.querySelector('[data-rtabs="0"]'), 'the RTV row carries a loose-tablets box beside the strips qty');
ok(/Qty \(strips\)/.test(doc.body.textContent), 'and the column heading says STRIPS');
w.eval(`
  const drug = document.querySelector('[data-r="0:drug"]');
  drug.value = 'Tab. Unit Test'; drug.oninput();
  const tb = document.querySelector('[data-rtabs="0"]');
  tb.value = '20'; tb.oninput();
`); await tick(200);
ok(w.eval(`num(document.querySelector('[data-r="0:qty"]').value)`) === 2, 'qty resolves to 2 strips, not 20', w.eval(`document.querySelector('[data-r="0:qty"]').value`));
ok(/20 tablets = 2 strips \(10s\)/.test(doc.body.textContent), 'with the conversion spelled out live');
const entryStock = w.eval(`(()=>{ const e = db.dailyData.viraj[todayISO()] || {savedAt:Date.now(), purchases:[], invoices:[], sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{opening:0,receipts:0,payments:0,actual:'',reason:''}, itemSales:[], audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[], rtv:[]};
  e.rtv = [{drug:'Tab. Unit Test', vendor:'X', qty:2, value:600, reason:'Expiry', status:'Pending'}]; e.savedAt = Date.now();
  db.dailyData.viraj[todayISO()] = e;
  return stockAsOf('viraj', todayISO()).items.find(m=>m.key===nameKey('Tab. Unit Test')).stock; })()`);
ok(entryStock === 0, 'the ledger drops by 2 strips: 2 opening − 2 RTV = 0, never 2 − 20 = −18', entryStock);

console.log('— a vial is never divided, even with the toggle on tablets —');
w.eval(`db.items.viraj.push({id:'u2', name:'Inj. Vial Test', key:nameKey('Inj. Vial Test'), pack:'vial', nr:50, mrp:80, openingQty:1, source:'demo', updatedAt:Date.now()})`);
const vconv = w.eval(`JSON.parse(JSON.stringify(tabletsToStrips([{item:'Inj. Vial Test', qty:3, nr:50, mrp:80, pack:'vial'}],'viraj','item')))`);
ok(vconv.rows[0].qty === 3 && vconv.unknown.includes('Inj. Vial Test'), '3 vials stay 3 — 1 unit = 1 strip where there is no pack integer');

console.log('— the adjust dialog converts too —');
w.eval(`openHospital('viraj','inventory'); invState().mode='asof'; renderInventory();`); await tick(400);
w.eval(`adjustModal('viraj', nameKey('Tab. Unit Test'))`); await tick(300);
ok(!!doc.querySelector('#adjTabs'), 'a 10s item gets the loose-tablets converter');
w.eval(`$('#adjTabs').value = '35'; $('#adjTabs').oninput()`); await tick(150);
ok(w.eval(`num($('#adjCount').value)`) === 3.5, '35 tablets counts as 3.5 strips', w.eval(`$('#adjCount').value`));
ok(/35 tablets = 3\.5 strips \(10s\)/.test(doc.body.textContent), 'spelled out before anything is recorded');
w.eval(`closeModal(); adjustModal('viraj', nameKey('Inj. Vial Test'))`); await tick(300);
ok(!doc.querySelector('#adjTabs'), 'a vial item gets NO converter — nothing to divide by');
ok(/no strip size/i.test(doc.querySelector('.modal-body').textContent), 'and says so instead of guessing');
w.eval(`closeModal()`); await tick(150);

console.log('— unit-suspect: flagged for review, never corrected —');
w.eval(`
  const T = todayISO();
  // peer items so a median exists; the suspect sold 150 (clean ×10) and dwarfs them
  db.items.viraj = [
    {id:'s1', name:'Tab. Suspect', key:nameKey('Tab. Suspect'), pack:'10s', nr:100, mrp:150, openingQty:200, source:'demo', updatedAt:Date.now()},
    {id:'p1', name:'Tab. Peer A', key:nameKey('Tab. Peer A'), pack:'10s', nr:10, mrp:20, openingQty:7, source:'demo', updatedAt:Date.now()},
    {id:'p2', name:'Tab. Peer B', key:nameKey('Tab. Peer B'), pack:'10s', nr:10, mrp:20, openingQty:9, source:'demo', updatedAt:Date.now()},
    {id:'p3', name:'Tab. Peer C', key:nameKey('Tab. Peer C'), pack:'10s', nr:10, mrp:20, openingQty:11, source:'demo', updatedAt:Date.now()}];
  db.adjustments.viraj = []; db.snapshots.viraj = []; db.dailyData.viraj = {};
  db.dailyData.viraj[T] = { savedAt:Date.now(), purchases:[], rtv:[], invoices:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{opening:0,receipts:0,payments:0,actual:'',reason:''},
    itemSales:[{item:'Tab. Suspect', qty:150, amount:22500, nr:100, mrp:150, pack:'10s'}],
    audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[] };
  invState().mode='asof'; renderInventory();
`); await tick(400);
ok(!!doc.querySelector('[data-invf="suspect"]'), 'the Inventory filters include Unit-suspect');
ok(/units\?/.test(doc.querySelector('#invBody').textContent), 'the row wears a "units?" flag', 'flag present');
doc.querySelector('[data-invf="suspect"]').click(); await tick(300);
const srows = [...doc.querySelectorAll('#invBody tbody tr')].filter(tr=> tr.querySelector('td b'));
ok(srows.length === 1 && /Suspect/.test(srows[0].textContent), 'the filter shows exactly the suspect row', srows.length);
ok(w.eval(`stockAsOf('viraj', todayISO()).items.find(m=>m.key===nameKey('Tab. Suspect')).sold`) === 150, 'and the DATA is untouched — surfaced, never auto-corrected');
w.eval(`state.invFilter='all'`);

console.log('— quantity cells audit their strip basis on hover —');
const stockCell = [...doc.querySelectorAll('#invBody td[title*="strips"]')];
ok(stockCell.length > 0, 'quantity cells carry a "= N strips (pack Xs)" title', stockCell.length);
ok(stockCell.some(td=> /pack 10s/.test(td.title) && /tablets/.test(td.title)), 'including the tablet equivalent for packed items', stockCell[0] && stockCell[0].title);
// the opening-stock door carries the same seg
w.eval(`openHospital('viraj','inventory')`); await tick(300);
w.eval(`openingStockModal('viraj')`); await tick(250);
w.eval(`$('#osPaste').value = 'Tab. Unit Test,15,30,40,10s'; $('#osRead').click()`); await tick(300);
ok(!!doc.querySelector('[data-osu="tablets"]'), 'the opening import offers the units choice');
doc.querySelector('[data-osu="tablets"]').click(); await tick(250);
ok(/1\.5/.test(doc.querySelector('#osPrev').textContent), 'switch to tablets and 15 becomes 1.5 strips in the preview', doc.querySelector('#osPrev').textContent.slice(0, 120));
w.eval(`setFileUnits('viraj','template','strips'); closeModal()`); await tick(150);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
