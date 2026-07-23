/* Tests: the sales & margin template — known columns, read without AI, margin is a ratio */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import XLSX from '../node_modules/xlsx/xlsx.js';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';

const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const near = (a, b, t = 0.01) => Math.abs(a - b) < t;
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));
const T = (() => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); })();

let cookie = '';
const req = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const upload = async (rows, name = 's.xlsx', sheet = 'Sales') => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
  const fd = new FormData();
  fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), name);
  const r = await fetch(B + '/parse/gpreport?hid=viraj', { method: 'POST', headers: { cookie }, body: fd });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const HDR = ['Product name', 'Pack (10s / 15s)', 'Qty sold (strips)', 'Cost price / Net rate (incl. GST)', 'MRP'];

await req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });

console.log('— a blank template needs no login, real data always does —');
/* The file is a blank form: column headings, invented example rows, instructions.
   It reads nothing from the database, so gating it behind a session would only
   have broken demo mode for a document with nothing to protect. */
for (const k of ['sales', 'opening', 'items']) {
  const anon = await fetch(B + '/template/' + k);   // deliberately no cookie
  ok(anon.status === 200, `${k}: downloads with no session at all`, anon.status);
  const buf = Buffer.from(await anon.arrayBuffer());
  ok(buf.slice(0, 2).toString() === 'PK', `${k}: and it is a real XLSX`);
}
for (const path of ['/bootstrap', '/users', '/clear/preview?hid=viraj']) {
  const anon = await fetch(B + path);
  ok(anon.status === 401 || anon.status === 403, `anything reading real data is still locked: ${path}`, anon.status);
}

console.log('— the template itself —');
let res = await fetch(B + '/template/sales', { headers: { cookie } });
const tplBuf = Buffer.from(await res.arrayBuffer());
ok(res.status === 200, 'the template downloads');
ok(tplBuf.slice(0, 2).toString() === 'PK', 'as a real XLSX', tplBuf.slice(0, 4).toString('hex'));
ok(/spreadsheetml/.test(res.headers.get('content-type') || ''), 'with the right content type');
const tplWb = XLSX.read(tplBuf, { type: 'buffer' });
ok(tplWb.SheetNames.includes('Sales') && tplWb.SheetNames.includes('How to fill'), 'with a Sales sheet and instructions', tplWb.SheetNames.join(','));
const tplHdr = XLSX.utils.sheet_to_json(tplWb.Sheets.Sales, { header: 1 })[0];
ok(tplHdr.length === 13, 'thirteen columns — strips, loose tablets, and six read-only helpers (total strips + per-piece rates + margin figures)', tplHdr.join('|'));
ok(/product/i.test(tplHdr[0]) && /pack/i.test(tplHdr[1]) && /qty.*strips/i.test(tplHdr[2]) && /qty.*tablets/i.test(tplHdr[3]) && /total strips/i.test(tplHdr[4]) && /net rate/i.test(tplHdr[5]) && /mrp/i.test(tplHdr[6]),
   'product / pack / qty strips / qty tablets / » total strips / net rate / MRP', tplHdr.join(' | '));
ok(/auto — do not fill/i.test(tplHdr[4]), 'the total-strips helper says do not fill');
ok(/incl/i.test(tplHdr[5]), 'and the rate column says inclusive of GST', tplHdr[5]);
ok(tplHdr.slice(7).some(h => /margin %/i.test(h)) && tplHdr.slice(7).some(h => /cost of goods sold/i.test(h)), 'and the per-tablet + margin helpers ride after MRP', tplHdr.slice(7).join(' | '));
const notes = XLSX.utils.sheet_to_json(tplWb.Sheets['How to fill'], { header: 1 }).flat().join(' ');
ok(/ratio/i.test(notes) && /pack size never changes it/i.test(notes), 'the notes explain that margin is a ratio the pack does not change');
// the template it hands out must be readable by the reader it ships with
const tplFd = new FormData();
tplFd.append('file', new Blob([tplBuf]), 'tpl.xlsx');
let r = await (await fetch(B + '/parse/gpreport?hid=viraj', { method: 'POST', headers: { cookie }, body: tplFd })).json();
ok(r.source === 'template', 'and the blank template round-trips through its own reader', r.source);

console.log('— it is read by matching columns, not by AI —');
r = (await upload([HDR,
  ['Tab. Rifaximin 550', '10s', 12, 298, 412],
  ['Tab. Metformin 500', '15s', 5, 12, 21],
  ['Inj. Pantoprazole 40', 'vial', 8, 38, 58]])).data;
ok(r.source === 'template', 'the template path is taken — no API key needed', r.source);
ok(r.items.length === 3, 'all three rows read', r.items.length);
ok(near(r.salesMrp, 12 * 412 + 5 * 21 + 8 * 58), 'sales = Σ qty × MRP = 5,513', r.salesMrp);
ok(near(r.cogs, 12 * 298 + 5 * 12 + 8 * 38), 'COGS = Σ qty × net rate = 3,940', r.cogs);
ok(near(r.marginPct, (r.salesMrp - r.cogs) / r.salesMrp * 100), 'and the margin is (sales − COGS) ÷ sales', r.marginPct);
ok(near(r.grossProfit, r.salesMrp - r.cogs), 'gross profit agrees');
const rif = r.items.find(i => /Rifaximin/.test(i.item));
ok(near(rif.marginPct, (412 - 298) / 412 * 100), 'per-item margin = (MRP − NR) ÷ MRP = 27.67%', rif.marginPct);
ok(near(rif.amount, 12 * 412) && near(rif.cost, 12 * 298), 'per-item value and cost', rif.amount + '/' + rif.cost);
ok(rif.pack === '10s', 'the pack rides along', rif.pack);

console.log('— the pack size never enters the margin —');
// same margin ratio, different strip sizes: a 10s at 8/14 and a 15s at 12/21 are both 42.86%
r = (await upload([HDR, ['A 10s', '10s', 3, 8, 14], ['A 15s', '15s', 3, 12, 21]])).data;
const a10 = r.items.find(i => i.item === 'A 10s'), a15 = r.items.find(i => i.item === 'A 15s');
ok(near(a10.marginPct, a15.marginPct), 'a 10s and a 15s at the same ratio give the SAME margin %', a10.marginPct.toFixed(2) + ' vs ' + a15.marginPct.toFixed(2));
ok(near(a10.marginPct, 42.857, 0.01), 'both 42.86%', a10.marginPct);
ok(!near(a10.amount, a15.amount), 'while their VALUES differ — that is what the pack changes', a10.amount + ' vs ' + a15.amount);
// doubling only the qty leaves the margin alone
r = (await upload([HDR, ['X', '10s', 1, 60, 100], ['Y', '10s', 99, 60, 100]])).data;
ok(near(r.items[0].marginPct, r.items[1].marginPct), 'quantity does not move the margin either — it is a ratio', r.items[0].marginPct);
ok(near(r.marginPct, 40), 'and the day total is still 40%', r.marginPct);

console.log('— messy sheets still read —');
r = (await upload([['MRP', 'Qty', 'Item', 'Net Rate', 'Pack'], [412, 12, 'Tab. Rifaximin 550', 298, '10s']])).data;
ok(r.source === 'template' && r.items.length === 1, 'columns in any order, Marg-style headings', JSON.stringify(r.items));
ok(near(r.salesMrp, 4944), 'and the maths still lands', r.salesMrp);
r = (await upload([HDR, ['Real Item', '10s', 4, 10, 20], ['', '', '', '', ''], ['TOTAL', '', 4, '', ''], ['Grand Total', '', 4, '', '']])).data;
ok(r.items.length === 1, 'blank rows and TOTAL / Grand Total rows are skipped', r.items.length);
r = (await upload([['Some report title'], [], HDR, ['Late Header', '10s', 2, 5, 10]])).data;
ok(r.source === 'template' && r.items.length === 1, 'a header that is not on row 1 is still found');
r = (await upload([HDR, ['No Rate', '10s', 3, 0, 50]])).data;
ok(near(r.salesMrp, 150) && near(r.cogs, 0), 'a row with no cost price counts as zero cost, not as an error', r.salesMrp + '/' + r.cogs);
ok(/no cost price/i.test(r.note), 'and the note says so', r.note);
r = (await upload([HDR, ['Zero Qty', '10s', 0, 5, 10], ['Sold', '10s', 2, 5, 10]])).data;
ok(r.items.length === 1, 'rows with no quantity sold are left out', r.items.length);
r = (await upload([['Nothing', 'to'], ['see', 'here']])).data;
ok(r.source !== 'template', 'a file that is not our shape falls through to the AI reader', r.source);

console.log('— it reaches the entry, and survives a save —');
r = (await upload([HDR, ['Tab. Rifaximin 550', '10s', 12, 298, 412]])).data;
const day = { purchases: [], rtv: [], invoices: [], hv: [],
  sales: { mrp: r.salesMrp, cogs: r.cogs, cash: 0, credit: 0, cancels: 0 }, cash: {},
  audit: { opening: 0, actual: '', unbilled: false, bounces: [] },
  itemSales: r.items.map(i => ({ item: i.item, qty: i.qty, amount: i.amount, pack: i.pack, nr: i.nr, mrp: i.mrp, cost: i.cost })) };
let sr = await req('PUT', `/entries/viraj/${T}`, { entry: day });
ok(sr.status === 200, 'the day saves');
const boot = (await req('GET', '/bootstrap')).data;
const saved = boot.dailyData.viraj[T].itemSales[0];
ok(saved.nr === 298 && saved.mrp === 412 && saved.pack === '10s', 'net rate, MRP and pack survive the round trip', JSON.stringify(saved));
ok(near(boot.dailyData.viraj[T].sales.mrp, 4944) && near(boot.dailyData.viraj[T].sales.cogs, 3576), 'and the day totals are the template totals');

console.log('— the opening-stock template —');
const tb = async k => Buffer.from(await (await fetch(B + '/template/' + k, { headers: { cookie } })).arrayBuffer());
const upload2 = async (buf, rows) => {
  const fd = new FormData(); fd.append('file', new Blob([fillTpl(buf, rows)]), 's.xlsx');
  const rr = await fetch(B + '/parse/gpreport?hid=viraj', { method: 'POST', headers: { cookie }, body: fd });
  return { status: rr.status, data: await rr.json().catch(() => ({})) };
};
const fillTpl = (buf, rows) => { const wb = XLSX.read(buf, { type: 'buffer' }); const sn = wb.SheetNames[0];
  const hdr = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 })[0];
  const out = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([hdr, ...rows]), sn);
  return XLSX.write(out, { type: 'buffer', bookType: 'xlsx' }); };
const post = async (path, buf, name) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name);
  const rr = await fetch(B + path, { method: 'POST', headers: { cookie }, body: fd }); return { status: rr.status, data: await rr.json().catch(() => ({})) }; };

const openBuf = await tb('opening');
const openHdr = XLSX.utils.sheet_to_json(XLSX.read(openBuf, { type: 'buffer' }).Sheets['Opening stock'], { header: 1 })[0];
ok(/opening stock \(strips\)/i.test(openHdr[2]), 'the opening column says STRIPS', openHdr[2]);
ok(/opening stock \(tablets\)/i.test(openHdr[3]), 'with a tablets column beside it', openHdr[3]);
ok(/total strips/i.test(openHdr[4]), 'then the read-only helper', openHdr[4]);
ok(/single strip/i.test(openHdr[5]) && /incl/i.test(openHdr[5]), 'the net rate says single strip, inclusive of GST', openHdr[5]);
ok(/single strip/i.test(openHdr[6]), 'and so does the MRP', openHdr[6]);
r = (await post('/parse/stock?hid=viraj', fillTpl(openBuf, [['Tab. Rifaximin 550', '10s', 120, '', '', 298, 412], ['Tab. Metformin 500', '15s', 300, '', '', 12, 21]]), 'o.xlsx')).data;
ok(r.source === 'template', 'a filled opening template is read without AI', r.source);
ok(r.items.length === 2 && r.items[0].qty === 120 && r.items[0].pack === '10s', 'strips and pack read', JSON.stringify(r.items[0]));

// and it drives the whole inventory valuation
let sv = await req('POST', '/items/opening', { hid: 'viraj', stockDate: T, rows: r.items });
ok(sv.status === 200, 'the opening stock saves');
let bt = (await req('GET', '/bootstrap')).data;
const opRif = bt.items.viraj.find(i => /Rifaximin/.test(i.name));
ok(opRif && opRif.openingQty === 120 && opRif.nr === 298 && opRif.mrp === 412, 'the item carries its opening strips and per-strip rates', JSON.stringify(opRif && { q: opRif.openingQty, nr: opRif.nr, mrp: opRif.mrp }));
ok(bt.hospitals.viraj.stockDate === T, 'and the counted-from date is anchored');

console.log('— the item-master template —');
const itemBuf = await tb('items');
const itemHdr = XLSX.utils.sheet_to_json(XLSX.read(itemBuf, { type: 'buffer' }).Sheets['Item master'], { header: 1 })[0];
ok(itemHdr.length === 5, 'five columns — no quantity, the master is prices', itemHdr.join('|'));
ok(/product/i.test(itemHdr[0]) && /molecule/i.test(itemHdr[1]) && /pack size/i.test(itemHdr[2]) && /single strip/i.test(itemHdr[3]) && /single strip/i.test(itemHdr[4]),
   'Product name / Molecule / Pack size / Net rate single strip / MRP single strip', itemHdr.join(' | '));
r = (await post('/parse/items?hid=viraj', fillTpl(itemBuf, [['Zeta Brand New', 'Zetamol 500mg', '10s', 40, 90], ['Bad Priced', '', '10s', 90, 40]]), 'i.xlsx')).data;
ok(r.source === 'template' && r.rows.length === 2, 'a filled master template reads', JSON.stringify(r.rows));
ok(r.rows[0].nr === 40 && r.rows[0].mrp === 90 && r.rows[0].pack === '10s', 'per-strip rates and pack come through');
ok(r.rows[0].molecule === 'Zetamol 500mg', 'and the molecule, which is what makes it comparable across hospitals', r.rows[0].molecule);
sv = await req('POST', '/items/bulk', { hid: 'viraj', items: r.rows });
bt = (await req('GET', '/bootstrap')).data;
ok(bt.items.viraj.some(i => i.name === 'Zeta Brand New'), 'a good row imports');
ok(!bt.items.viraj.some(i => i.name === 'Bad Priced'), 'a net rate ABOVE the MRP is refused — that would sell at a loss');
r = (await post('/parse/items?hid=viraj', fillTpl(await tb('sales'), [['X', '10s', 1, 2, 3]]), 'wrong.xlsx'));
ok(r.status === 200 || r.status === 400, 'the wrong template is handled, not crashed', r.status);

console.log('— per-row tablets: the other unit is derived, never stored —');
{
  // fill through the REAL template so the layout is the shipped one
  const oBuf = await tb('opening');
  // 4500 tablets of a 15s -> 300 strips; a strips row rides beside it untouched
  let rr = (await post('/parse/stock?hid=viraj', fillTpl(oBuf, [
    ['Tab. Metformin 500', '15s', '', 4500, 999999, 12, 21],   // helper column filled with garbage — must be IGNORED
    ['Tab. Rifaximin 550', '10s', 120, '', '', 298, 412]
  ]), 'o2.xlsx')).data;
  ok(rr.source === 'template' && rr.items.length === 2, 'a mixed strips/tablets sheet reads', JSON.stringify(rr.rejected));
  const met = rr.items.find(x => /metformin/i.test(x.name));
  ok(met.qty === 300 && met.unit === 'tablets' && met.srcLoose === 4500, '4500 tablets of a 15s = 300 strips, provenance kept', JSON.stringify(met));
  ok(rr.items.find(x => /rifaximin/i.test(x.name)).qty === 120, 'the strips row is untouched');
  ok(met.nr === 12 && met.mrp === 21, 'RATES ARE NOT SCALED — both rate columns are per single strip whichever unit counted the quantity', `${met.nr}/${met.mrp}`);
  ok(rr.tabletsCol === true, 'the response says the sheet has its own tablets column — the client kills the file-level toggle');

  // identical row entered both ways yields identical everything
  const sBuf = await tb('sales');
  const a1 = (await upload2(sBuf, [['Tab. Rifaximin 550', '10s', 120, '', '', 298, 412]])).data;
  const a2 = (await upload2(sBuf, [['Tab. Rifaximin 550', '10s', '', 1200, '', 298, 412]])).data;
  ok(a1.items[0].qty === 120 && a2.items[0].qty === 120, '120 strips ≡ 1200 tablets (10s)', `${a1.items[0].qty}/${a2.items[0].qty}`);
  ok(a1.items[0].nr === a2.items[0].nr && a1.items[0].mrp === a2.items[0].mrp, 'same nr and mrp either way');
  ok(a1.salesMrp === a2.salesMrp && a1.cogs === a2.cogs, 'and the same sale value and COGS — the unit changes nothing but the counting', `${a1.salesMrp}/${a2.salesMrp}`);
  // 75 tablets of a 15s
  const a3 = (await upload2(sBuf, [['Tab. Metformin 500', '15s', '', 75, '', 12, 21]])).data;
  ok(a3.items[0].qty === 5, '75 tablets of a 15s = 5 strips', a3.items[0].qty);

  // both filled is now the PRIMARY intended input — strips + loose ADD UP,
  // never rejected as ambiguous
  const a4 = (await upload2(sBuf, [
    ['Tab. Rifaximin 550', '10s', 12, 3, '', 298, 412],
    ['Tab. Metformin 500', '15s', 5, '', '', 12, 21]
  ])).data;
  ok(a4.items.length === 2, 'both rows import — filling both columns is summed, not rejected', JSON.stringify(a4.items.map(i => i.item)));
  const rifMixed = a4.items.find(i => /rifaximin/i.test(i.item));
  ok(rifMixed.qty === 12.3 && rifMixed.unit === 'mixed' && rifMixed.srcStrips === 12 && rifMixed.srcLoose === 3, '12 strips + 3 loose (10s) = 12.3 strips total', JSON.stringify(rifMixed));
  ok((a4.cautions || []).length === 0, 'a small loose amount alongside strips raises no caution', JSON.stringify(a4.cautions));

  // tablets on a vial: nothing to divide by — rejected, never guessed
  const a5 = (await upload2(sBuf, [['Inj. Pantoprazole 40', 'vial', '', 30, '', 38, 58]])).data;
  ok(a5.items.length === 0 && a5.rejected.length === 1 && /pack size needed/i.test(a5.rejected[0].reason), 'tablets with a vial pack are rejected, not divided', JSON.stringify(a5.rejected));

  // a sheet WITHOUT the tablets column behaves exactly as before
  const legacy = (await upload([HDR,
    ['Tab. Rifaximin 550', '10s', 12, 298, 412]])).data;
  ok(legacy.source === 'template' && legacy.items[0].qty === 12 && legacy.tabletsCol === false, 'a legacy five-column sheet still reads as today', JSON.stringify({ q: legacy.items[0]?.qty, t: legacy.tabletsCol }));

  // the helper header is claimed by NO column matcher — a sheet of only helper+name parses to nothing
  const trap = (await upload([[ 'Product name', '» Total strips (auto — do not fill)', 'MRP — single strip' ],
    ['Tab. Rifaximin 550', 999, 412]])).data;
  ok(trap.source !== 'template' || !trap.items || !trap.items.length || !trap.items[0].qty, 'the helper column is invisible to the matchers — its numbers can never become quantities', trap.source);
}

console.log('— every template is per STRIP, and says so —');
for (const k of ['sales', 'opening', 'items']) {
  const wb = XLSX.read(await tb(k), { type: 'buffer' });
  const notes = XLSX.utils.sheet_to_json(wb.Sheets['How to fill'], { header: 1 }).flat().join(' ');
  ok(/per STRIP/i.test(notes), `${k}: the notes state the unit is a strip`);
  ok(/ratio/i.test(notes) && /pack size never changes it/i.test(notes), `${k}: and that the pack size never changes the margin`);
}
r = await fetch(B + '/template/nonsense', { headers: { cookie } });
ok(r.status === 404, 'an unknown template 404s', r.status);

console.log('— DOM —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
let ck2 = '';
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {};
    w.URL.createObjectURL = () => 'blob:x';
    w.fetch = async (u, o = {}) => { const res = await fetch(new URL(u, 'http://127.0.0.1:3061'), { method: o.method || 'GET', headers: { ...(o.headers || {}), ...(ck2 ? { cookie: ck2 } : {}) }, body: o.body });
      const sc = res.headers.get('set-cookie'); if (sc) ck2 = sc.split(';')[0]; return res; }; } });
const w = dom.window, doc = w.document;
await tick(400);
// a real login — the upload is a live-mode feature, demo mode refuses it on purpose
doc.querySelector('#loginEmail').value = 'bhagavan@yajnapharma.in';
doc.querySelector('#loginPw').value = ADMIN_PW;
doc.querySelector('#loginBtn').click(); await tick(900);
doc.querySelector('[data-open2]').click(); await tick(250);
w.eval('state.date=todayISO(); state.entryTab=1; state.entryMode="daily"; renderHospitalWorkspace();'); await tick(350);
ok(!!doc.querySelector('#gpBtn'), 'the Sales tab has an upload button');
doc.querySelector('#gpBtn').click(); await tick(300);
ok(!!doc.querySelector('.modal'), 'and it opens the upload modal');
ok(!!doc.querySelector('#gpTpl'), 'the modal offers the template download');
const modal = doc.querySelector('.modal').textContent;
ok(/qty in strips/i.test(modal), 'and says the qty is in strips', modal.slice(0, 100));
ok(/cost price including GST/i.test(modal), 'and that the cost price includes GST');
ok(!!doc.querySelector('#gpFile') && !!doc.querySelector('#gpApply'), 'with a file picker and an apply button');
ok(doc.querySelector('#gpApply').disabled, 'apply is disabled until something is read');
ok(doc.querySelector('.modal').classList.contains('modal-lg'), 'the upload modals ask for the wider modal size');
w.eval('closeModal()'); await tick(120);

console.log('— product names are checked against the Item Master, and a mismatch is highlighted —');
w.eval(`db.items.viraj = (db.items.viraj||[]).concat([{id:'mm1', name:'Tab. Master Item', key:nameKey('Tab. Master Item'), pack:'10s', nr:10, mrp:20, openingQty:0, source:'demo', updatedAt:Date.now()}])`);
const allMatched = w.eval(`masterMatchBanner('viraj', ['Tab. Master Item'])`);
ok(/All 1 product name/i.test(allMatched) && /matched the Item Master/i.test(allMatched), 'a fully-matched set says so plainly', allMatched);
const someUnmatched = w.eval(`masterMatchBanner('viraj', ['Tab. Master Item', 'Totally Unknown Drug'])`);
ok(/1 of 2/.test(someUnmatched) && /Totally Unknown Drug/.test(someUnmatched), 'an unmatched name is called out by name in the summary', someUnmatched);
ok(w.eval(`masterMatchBanner('viraj', [])`) === '', 'nothing to say when there are no names at all');
ok(w.eval(`unmatchedRowStyle('viraj', 'Tab. Master Item')`) === '', 'a matched row gets no highlight');
ok(/amber-light/.test(w.eval(`unmatchedRowStyle('viraj', 'Totally Unknown Drug')`)), 'an unmatched row is visually highlighted, not just chipped');
// the other two templates are downloadable where their import lives
w.eval('openingStockModal(state.hospital)'); await tick(250);
ok(!!doc.querySelector('#osTpl'), 'the opening-stock modal offers its template');
ok(/counts are in STRIPS/i.test(doc.querySelector('.modal').textContent), 'and says counts are in strips');
w.eval('closeModal(); itemImportModal(state.hospital)'); await tick(250);
ok(!!doc.querySelector('#itmTpl'), 'the item-master modal offers its template');
ok(/both rates are for ONE strip/i.test(doc.querySelector('.modal').textContent), 'and says both rates are per single strip');
w.eval('closeModal(); state.hospTab="items"; renderHospitalWorkspace()'); await tick(300);
let hdrs = [...doc.querySelectorAll('#content thead th')].map(t => t.textContent.trim()).join(' | ');
ok(/Net rate \/ strip/.test(hdrs) && /MRP \/ strip/.test(hdrs), 'the Item Master table names its columns per strip', hdrs);
ok(/Product name/.test(hdrs) && /Pack size/.test(hdrs), 'and uses the same wording as the template', hdrs);
// demo mode refuses it — there is no server to read the file
w.eval('closeModal(); state.demo = true;');
w.eval('gpUploadModal(getDraft(), false)'); await tick(150);
ok(!doc.querySelector('#gpTpl'), 'demo mode refuses the UPLOAD — there is no server to read the file');
// but the template download must work in demo: it is a blank form, not data
w.eval('closeModal(); state.demo = true; state.hospTab="items"; renderHospitalWorkspace()'); await tick(300);
ok(!!doc.querySelector('#itmTplTop'), 'the Template button is still there in demo mode');
doc.querySelectorAll('#toastRoot .toast').forEach(x => x.remove());
doc.querySelector('#itmTplTop').click(); await tick(500);
const demoToast = [...doc.querySelectorAll('#toastRoot .toast')].map(t => t.textContent).join(' | ');
ok(/downloaded/.test(demoToast), 'and it DOWNLOADS in demo mode rather than asking for live mode', demoToast);
w.eval('state.demo = false;');
w.eval('state.demo = false;');

console.log('— the Inventory table carries the template columns —');
w.eval(`
  db.hospitals.lab={id:'lab',name:'Lab',doctor:'D',location:'',phone:'',startDate:'2026-01-01',stockDate:'2026-01-10',issueMethod:'fefo',active:true,base:1000};
  db.items.lab=[{id:'l1',name:'Alpha',key:'alpha',pack:'10s',nr:10,mrp:20,openingQty:100,source:'t',updatedAt:1}];
  db.adjustments.lab=[];db.dailyData.lab={};db.vendors.lab=[];db.payments.lab=[];db.receivables.lab=[];db.recvActions.lab=[];db.snapshots.lab=[];
  db.dailyData.lab['2026-01-20']={purchases:[],rtv:[],itemSales:[],hv:[],sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0},cash:{},audit:{opening:0,actual:'',unbilled:false,bounces:[]},savedAt:1,
    invoices:[{id:'a',vendor:'V',invoiceNo:'A',date:'2026-01-20',lines:[{item:'Alpha',batch:'BX',exp:'',pqty:300,oqty:0,rate:20,disc:0,gst:0,mrp:40}]}]};
`);
const invIt = JSON.parse(w.eval('JSON.stringify(stockAsOf("lab","2026-01-31").items[0])'));
// 100 strips at 10 + 300 at 20 → weighted 17.50, NOT the plain mean of 15
ok(near(invIt.nrStrip, 17.5), 'net rate per strip is WEIGHTED by the strips on hand, not a plain mean', invIt.nrStrip);
ok(!near(invIt.nrStrip, 15), 'a naive average of the lot rates would say 15 — that would misprice the stock');
ok(near(invIt.mrpStrip, 35), 'MRP per strip is weighted the same way', invIt.mrpStrip);
ok(near(invIt.nrStrip * invIt.stock, invIt.valueNr), 'and rate × strips reproduces the stock value exactly', invIt.nrStrip * invIt.stock);
ok(invIt.mixedRate === true, 'lots at different rates are flagged, so the average is never mistaken for a single price');

w.eval('state.hospital="lab"; state.view="hospital"; state.hospTab="inventory"; state.inv={mode:"asof",asOf:"2026-01-31",start:"2026-01-01",end:"2026-01-31",interval:"daily"}; state.invFilter="all"; state.invQuery=""; state.invOpen=null; renderHospitalWorkspace();');
await tick(400);
const invHdrs = [...doc.querySelectorAll('#invBody thead th')].map(t => t.textContent.trim()).filter(Boolean);
ok(invHdrs[0] === 'Product name' && invHdrs[1] === 'Pack size', 'the table opens with Product name and Pack size', invHdrs.slice(0, 2).join('|'));
ok(/Net rate \/ strip/.test(invHdrs[2]), 'then Net rate / strip', invHdrs[2]);
ok(/MRP \/ strip/.test(invHdrs[3]), 'then MRP / strip', invHdrs[3]);
ok(invHdrs.includes('Opening / strip'), 'opening strips are still there — now labelled / strip');
['In stock / strip', 'Value (NR)', 'MRP value', 'Pot. margin ₹', 'Pot. margin %'].forEach(h =>
  ok(invHdrs.includes(h), `and everything derived is untouched: ${h}`));
const cells = [...doc.querySelector('#invBody tbody tr').querySelectorAll('td')].map(t => t.textContent.trim());
ok(/17\.50/.test(cells[2]), 'the row shows the weighted net rate', cells[2]);
ok(/avg/.test(cells[2]), 'marked as an average because the lots differ', cells[2]);
ok(/35\.00/.test(cells[3]), 'and the weighted MRP', cells[3]);
// a single-lot item is NOT marked as an average
// savedAt must move, exactly as a real save moves it — the ledger cache keys off it
w.eval(`db.dailyData.lab['2026-01-20'].invoices[0].lines[0].rate = 10; db.dailyData.lab['2026-01-20'].invoices[0].lines[0].mrp = 20; db.dailyData.lab['2026-01-20'].savedAt = 2; renderHospitalWorkspace();`);
await tick(350);
ok(!/avg/.test([...doc.querySelector('#invBody tbody tr').querySelectorAll('td')][2].textContent), 'lots at the SAME rate are not marked as an average');

console.log('— templates are reachable from the tabs, not only the modals —');
ok(!!doc.querySelector('#invTpl'), 'the Inventory toolbar has a Template button');
w.eval('state.hospTab="items"; renderHospitalWorkspace()'); await tick(300);
ok(!!doc.querySelector('#itmTplTop'), 'so does the Item Master toolbar');
ok(!!doc.querySelector('#itmImport'), 'beside its Import button');
w.eval('state.hospTab="entry"; state.entryMode="daily"; state.entryTab=1; renderHospitalWorkspace()'); await tick(350);
ok(!!doc.querySelector('#gpBtn'), 'and Sales & Margin keeps its upload button');
ok(!!doc.querySelector('#gpTplTop'), 'with a Template button beside it — all three screens offer it the same way');
// it must fetch the SALES template, not one of the others
let tplUrl = '';
const realFetch = w.fetch;
w.fetch = async (u, o) => { if (String(u).includes('/template/')) tplUrl = String(u); return realFetch(u, o); };
doc.querySelector('#gpTplTop').click(); await tick(400);
ok(tplUrl === '/api/template/sales', 'and it downloads the sales template specifically', tplUrl);
w.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
