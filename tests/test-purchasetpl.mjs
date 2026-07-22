/* Tests: the purchase upload template — one vendor per file, seven raw inputs,
   calcLine derives everything. Live HTTP like test-salestpl. */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import XLSX from '../node_modules/xlsx/xlsx.js';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';

const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 200) => new Promise(r => setTimeout(r, ms));
const todayISO = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const T = todayISO();

let cookie = '';
const req = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let data = {}; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
};
const tb = async k => Buffer.from(await (await fetch(B + '/template/' + k, { headers: { cookie } })).arrayBuffer());
const post = async (path, buf, name, fields) => {
  const fd = new FormData();
  Object.entries(fields || {}).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', new Blob([buf]), name);
  const rr = await fetch(B + path, { method: 'POST', headers: { cookie }, body: fd });
  return { status: rr.status, data: await rr.json().catch(() => ({})) };
};
/* fill the purchase template: find its header row (the branding band sits above
   it), keep everything above, replace the rows below */
const fillPurchase = (buf, rows) => {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sn = wb.SheetNames[0];
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: true });
  const h = grid.findIndex(r => (r || []).some(c => /purchase *qty/i.test(String(c || ''))));
  const out = XLSX.utils.aoa_to_sheet([...grid.slice(0, h + 1), ...rows]);
  const wb2 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2, out, sn);
  return Buffer.from(XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' }));
};

await req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });

console.log('— the template: seven inputs, a branding band, and NOTHING derived —');
const buf = await tb('purchase');
ok(buf.slice(0, 2).toString() === 'PK', 'GET /api/template/purchase returns a real xlsx');
const wb = XLSX.read(buf, { type: 'buffer' });
const grid = XLSX.utils.sheet_to_json(wb.Sheets['Purchase'], { header: 1, blankrows: true });
ok(/YAJNA PHARMA SOLUTIONS/.test(String(grid[0][0])), 'the YPS band is on top', grid[0][0]);
ok(/STRIPS/.test(String(grid[1][0])) && /0\/5\/12\/18/.test(String(grid[1][0])), 'the legend states the units and the validation rules');
const hIx = grid.findIndex(r => (r || []).some(c => /purchase *qty/i.test(String(c || ''))));
const hdr = grid[hIx].map(String);
ok(hdr.length === 7, 'seven input columns exactly', hdr.join(' | '));
ok(/^item/i.test(hdr[0]) && /strips/i.test(hdr[1]) && /offer/i.test(hdr[2]) && /^rate/i.test(hdr[3]) && /disc/i.test(hdr[4]) && /gst/i.test(hdr[5]) && /^mrp/i.test(hdr[6]), 'Item / Purchase Qty (strips) / Offer / Rate / Disc / GST / MRP', hdr.join(' | '));
ok(!hdr.some(h => /^vendor\s*$|vendor *name/i.test(h)), 'NO vendor column — the vendor is named at upload (Vendor Disc % is a discount, not a vendor)');
ok(!hdr.some(h => /net *rate|total|margin/i.test(h)), 'and NO calculated columns — the app derives those');
ok(grid[hIx + 1] && String(grid[hIx + 1][0]).length > 0, 'an example row follows the header');

console.log('— the parser refuses what the popup must supply —');
const five = [
  ['Tab. Rifaximin 550', 10, 1, 85, 10, 12, 120],
  ['Tab. Metformin 500', 20, 0, 9.5, 5, 5, 21],
  ['Cap. Omez 20', 15, 3, 40, 0, 12, 62],
  ['Syp. Cough Away', 6, 0, 55, 8, 18, 90],
  ['Inj. Pantoprazole 40', 12, 0, 38, 0, 12, 58]
];
let r = await post(`/parse/purchase?hid=viraj&date=${T}`, fillPurchase(buf, five), 'p.xlsx');
ok(r.status === 400 && /vendor/i.test(r.data.error), 'no vendor → rejected before any parsing', r.data.error);
r = await post(`/parse/purchase?hid=viraj&date=${T}`, Buffer.from('foo,bar\n1,2'), 'bad.csv', { vendor: 'Mankind Associates' });
ok(r.status === 400 && /header/i.test(r.data.error), 'a wrong-shaped file names the required headers', r.data.error);

console.log('— one vendor, five lines, calcLine is the only math —');
r = await post(`/parse/purchase?hid=viraj&date=${T}`, fillPurchase(buf, five), 'p.xlsx', { vendor: 'Mankind Associates', invoiceNo: 'MA-2041' });
ok(r.status === 200 && r.data.source === 'template', 'the filled template reads without AI', r.data.error);
const inv = r.data.invoice;
ok(inv.vendor === 'Mankind Associates' && inv.lines.length === 5, 'ONE invoice, five lines, all under the popup vendor', `${inv.vendor}/${inv.lines.length}`);
ok(inv.invoiceNo === 'MA-2041' && inv.date === T, 'the popup invoice number rides on the invoice, with the selected entry date', inv.invoiceNo);
ok(!('nr' in inv.lines[0]) && !('value' in inv.lines[0]), 'the stored lines are RAW inputs — no derived field is trusted from a sheet', JSON.stringify(inv.lines[0]));
const p0 = r.data.preview[0];
ok(p0.tqty === 11, 'preview: 10 + 1 free = 11 total qty', p0.tqty);
ok(p0.nr === 77.89, 'preview net rate 77.89 — billed 856.80 ÷ 11, straight from calcLine', p0.nr);
ok(p0.marginPct === 35.09, 'preview margin 35.09% against MRP 120', p0.marginPct);

console.log('— saved through the ordinary entry path, the server re-derives —');
const entry = {
  purchases: [{ vendor: 'Mankind Associates', items: 5, value: 0, invId: inv.id }],
  rtv: [], sales: { mrp: 0, cogs: 0, cash: 0, credit: 0, cancels: 0 },
  cash: { opening: 0, receipts: 0, payments: 0, actual: '', reason: '' },
  audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [], itemSales: [],
  invoices: [inv]
};
r = await req('PUT', `/entries/viraj/${T}`, { entry });
ok(r.status === 200, 'the day saves', r.data.error);
let day = (await req('GET', '/bootstrap')).data.dailyData.viraj[T];
const l0 = day.invoices[0].lines[0];
ok(Math.abs(l0.nr - 77.89) < 0.01, 'the SERVER stamped net rate 77.89 — same calcLine, nothing can disagree', l0.nr);
ok(Math.abs(l0.value - 856.8) < 0.01, 'and the line value 856.80', l0.value);
ok(l0.qty === 11, 'and canonical qty = total qty including free goods', l0.qty);

console.log('— a second upload APPENDS, never overwrites —');
r = await post(`/parse/purchase?hid=viraj&date=${T}`, fillPurchase(buf, [['Tab. Extra 10', 5, 0, 10, 0, 5, 20]]), 'p2.xlsx', { vendor: 'Mankind Associates' });
const inv2 = r.data.invoice;
ok(inv2.id !== inv.id, 'the second file is a NEW invoice with its own id');
entry.invoices.push(inv2);
entry.purchases.push({ vendor: 'Mankind Associates', items: 1, value: 0, invId: inv2.id });
r = await req('PUT', `/entries/viraj/${T}`, { entry });
day = (await req('GET', '/bootstrap')).data.dailyData.viraj[T];
ok(day.invoices.length === 2, 'the day now carries BOTH invoices', day.invoices.length);
ok(day.invoices[0].lines.length === 5 && day.invoices[1].lines.length === 1, 'the first upload is untouched', `${day.invoices[0].lines.length}/${day.invoices[1].lines.length}`);

console.log('— DOM: the buttons, the popup, and the tablets converter —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const w = dom.window, doc = w.document;
await tick(400);
doc.querySelector('[data-quick="admin"]').click(); await tick(700);
w.eval(`openHospital('viraj','entry'); state.entryTab = 0; renderEntry();`); await tick(400);
ok(!doc.querySelector('#purTpl'), 'NO standalone template button on the main section — it lives inside the popup');
ok(!!doc.querySelector('#purUpl') && /Bulk upload of purchase/.test(doc.querySelector('#purUpl').textContent), 'the toolbar offers Bulk upload of purchase', doc.querySelector('#purUpl')?.textContent);
ok(!!doc.querySelector('#invManualTop'), 'Add invoice manually stands beside it, fully independent');
doc.querySelector('#invManualTop').click(); await tick(300);
ok(!!doc.querySelector('#lmItem'), 'manual entry still opens its own line dialog — untouched by the bulk path');
w.eval('closeModal()'); await tick(200);
doc.querySelector('#purUpl').click(); await tick(200);
ok(/live mode/i.test(doc.querySelector('#toastRoot')?.textContent || ''), 'demo mode says the upload needs live mode — it does not pretend');

// the purchase-aware converter: BOTH quantities divide, rate & mrp scale, rupees hold
w.eval(`db.items.viraj.push({id:'pu1', name:'Tab. Conv Test', key:nameKey('Tab. Conv Test'), pack:'10s', nr:85, mrp:120, openingQty:0, source:'demo', updatedAt:Date.now()})`);
const cv = w.eval(`JSON.parse(JSON.stringify(purchaseToStrips([
  {item:'Tab. Conv Test', pqty:100, oqty:10, rate:8.5, disc:10, gst:12, mrp:12},
  {item:'Unknown Syrup', pqty:3, oqty:0, rate:55, disc:0, gst:18, mrp:90}
], 'viraj')))`);
ok(cv.rows[0].pqty === 10 && cv.rows[0].oqty === 1, 'pqty AND oqty divide by the pack: 100+10 tablets → 10+1 strips', `${cv.rows[0].pqty}/${cv.rows[0].oqty}`);
ok(cv.rows[0].rate === 85 && cv.rows[0].mrp === 120, 'rate and MRP scale up by the pack', `${cv.rows[0].rate}/${cv.rows[0].mrp}`);
ok(cv.rows[0].disc === 10 && cv.rows[0].gst === 12, 'disc and GST are percentages — unit-proof, untouched');
const rupees = w.eval(`(()=>{ const a = calcLine({item:'x', pqty:100, oqty:10, rate:8.5, disc:10, gst:12, mrp:12});
  const b = calcLine({item:'x', pqty:10, oqty:1, rate:85, disc:10, gst:12, mrp:120});
  return [a.pamt, b.pamt, a.nr*a.tqty, b.nr*b.tqty]; })()`);
ok(Math.abs(rupees[0] - rupees[1]) < 0.001, 'the billed amount is identical either way — no rupee moves', `${rupees[0]} vs ${rupees[1]}`);
ok(cv.rows[1].pqty === 3 && cv.unknown.includes('Unknown Syrup'), 'no pack on the master → left as-is and named, never guessed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
