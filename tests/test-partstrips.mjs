/* Tests: opening stock AND sales accept FULL STRIPS + LOOSE TABLETS together
   (10 strips + 3 loose of a 10s = 10.3), as well as a plain tablet count
   (103 = 10.3) — additive, never an either/or rejection. Per-tablet rates are
   derived for display only. Live-HTTP for the template/parse layer, DOM for
   the stock ledger (stockAsOf / FEFO), which is client-side computation. */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import XLSX from '../node_modules/xlsx/xlsx.js';

const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const near = (a, b, t = 0.001) => Math.abs(a - b) < t;
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));
const todayISO = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const T = todayISO();
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let cookie = '';
const req = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const tb = async k => Buffer.from(await (await fetch(B + '/template/' + k, { headers: { cookie } })).arrayBuffer());
const fillTpl = (buf, rows) => {
  const wb = XLSX.read(buf, { type: 'buffer' }); const sn = wb.SheetNames[0];
  const hdr = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 })[0];
  const out = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([hdr, ...rows]), sn);
  return XLSX.write(out, { type: 'buffer', bookType: 'xlsx' });
};
const post = async (path, buf, name) => {
  const fd = new FormData(); fd.append('file', new Blob([buf]), name);
  const rr = await fetch(B + path, { method: 'POST', headers: { cookie }, body: fd });
  return { status: rr.status, data: await rr.json().catch(() => ({})) };
};

await req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });

/* the worked example this whole feature is pinned against */
const NR = 759.25, MRP = 999, PACK = '10s';

console.log('— opening: 10+3 === 103 tablets === 10.3 strips, identical value at NR and MRP —');
{
  const openBuf = await tb('opening');
  // three equivalent ways to key the SAME 10.3-strip count
  const r = (await post('/parse/stock?hid=viraj', fillTpl(openBuf, [
    ['Combo A', PACK, 10, 3, '', NR, MRP],     // 10 full strips + 3 loose
    ['Combo B', PACK, '', 103, '', NR, MRP],   // 103 loose tablets alone
    ['Combo C', PACK, 10.3, '', '', NR, MRP]   // a plain strip count, already fractional
  ]), 'o.xlsx')).data;
  ok(r.source === 'template' && r.items.length === 3, 'all three rows read', JSON.stringify(r.items.map(i => i.qty)));
  const [a, b2, c] = ['Combo A', 'Combo B', 'Combo C'].map(n => r.items.find(i => i.name === n));
  ok(near(a.qty, 10.3) && near(b2.qty, 10.3) && near(c.qty, 10.3), 'all three resolve to EXACTLY 10.3 strips', JSON.stringify([a.qty, b2.qty, c.qty]));
  ok(a.unit === 'mixed' && a.srcStrips === 10 && a.srcLoose === 3, 'the mixed row keeps its strips+loose provenance', JSON.stringify(a));
  ok(b2.unit === 'tablets' && b2.srcStrips === 0 && b2.srcLoose === 103, 'the tablets-only row keeps its provenance too', JSON.stringify(b2));
  const valueNr = (r) => r.qty * r.nr, valueMrp = (r) => r.qty * r.mrp;
  ok(near(valueNr(a), 7820.275) && near(valueNr(b2), 7820.275) && near(valueNr(c), 7820.275), 'value at net rate agrees to the paisa: ₹7,820.275 for every input style', JSON.stringify([valueNr(a), valueNr(b2), valueNr(c)]));
  ok(near(valueMrp(a), 10289.7) && near(valueMrp(b2), 10289.7) && near(valueMrp(c), 10289.7), 'value at MRP agrees to the paisa: ₹10,289.700', JSON.stringify([valueMrp(a), valueMrp(b2), valueMrp(c)]));
}

console.log('— sales: 2+5 === 25 tablets === 2.5 strips, identical COGS, sale value, margin — margin % unchanged —');
{
  const salesBuf = await tb('sales');
  const r = (await post('/parse/gpreport?hid=viraj', fillTpl(salesBuf, [
    ['Combo A', PACK, 2, 5, '', NR, MRP],
    ['Combo B', PACK, '', 25, '', NR, MRP],
    ['Combo C', PACK, 2.5, '', '', NR, MRP]
  ]), 's.xlsx')).data;
  ok(r.source === 'template' && r.items.length === 3, 'all three rows read', JSON.stringify(r.items.map(i => i.qty)));
  const [a, b2, c] = ['Combo A', 'Combo B', 'Combo C'].map(n => r.items.find(i => i.item === n));
  ok(near(a.qty, 2.5) && near(b2.qty, 2.5) && near(c.qty, 2.5), 'all three resolve to EXACTLY 2.5 strips', JSON.stringify([a.qty, b2.qty, c.qty]));
  ok(a.unit === 'mixed' && a.srcStrips === 2 && a.srcLoose === 5, 'provenance kept on the mixed row', JSON.stringify(a));
  // the server rounds cost/amount to paisa (2dp) for display, so 1898.125 lands
  // as 1898.13 either way — the invariant that matters is that every input
  // style rounds to the exact SAME paisa, not a third-decimal coincidence
  ok(near(a.cost, 1898.125, 0.01) && near(a.cost, b2.cost) && near(a.cost, c.cost), 'COGS agrees to the paisa: ≈₹1,898.13, identical across every input style', JSON.stringify([a.cost, b2.cost, c.cost]));
  ok(near(a.amount, 2497.5) && near(b2.amount, 2497.5) && near(c.amount, 2497.5), 'sale value agrees to the paisa: ₹2,497.500', JSON.stringify([a.amount, b2.amount, c.amount]));
  const marginRs = (r) => r.amount - r.cost;
  ok(near(marginRs(a), 599.375, 0.01) && near(marginRs(a), marginRs(b2)) && near(marginRs(a), marginRs(c)), 'margin ₹ agrees to the paisa: ≈₹599.37, identical across every input style', JSON.stringify([marginRs(a), marginRs(b2), marginRs(c)]));
  ok(near(a.marginPct, 24.0, 0.01) && near(a.marginPct, b2.marginPct) && near(a.marginPct, c.marginPct), 'margin % is the SAME ratio (≈24.0%) across every input style — part strips never move it', JSON.stringify([a.marginPct, b2.marginPct, c.marginPct]));
}

console.log('— 4500 loose tablets of a 15s -> 300 strips (both kinds) —');
{
  const r1 = (await post('/parse/stock?hid=viraj', fillTpl(await tb('opening'), [['Bulk Open', '15s', '', 4500, '', 12, 21]]), 'o2.xlsx')).data;
  ok(near(r1.items[0].qty, 300), 'opening: 4500/15 = 300', r1.items[0].qty);
  const r2 = (await post('/parse/gpreport?hid=viraj', fillTpl(await tb('sales'), [['Bulk Sale', '15s', '', 4500, '', 12, 21]]), 's2.xlsx')).data;
  ok(near(r2.items[0].qty, 300), 'sales: 4500/15 = 300', r2.items[0].qty);
}

console.log('— loose tablets on a vial item -> rejected with the pack-size reason (both kinds) —');
{
  const r1 = (await post('/parse/stock?hid=viraj', fillTpl(await tb('opening'), [['Vial Open', 'vial', '', 10, '', 38, 58]]), 'o3.xlsx')).data;
  ok(r1.items.length === 0 && r1.skipped.length === 1 && /pack size needed/i.test(r1.skipped[0].reason), 'opening: rejected, never guessed', JSON.stringify(r1.skipped));
  const r2 = (await post('/parse/gpreport?hid=viraj', fillTpl(await tb('sales'), [['Vial Sale', 'vial', '', 10, '', 38, 58]]), 's3.xlsx')).data;
  ok(r2.items.length === 0 && r2.skipped.length === 1 && /pack size needed/i.test(r2.skipped[0].reason), 'sales: rejected, never guessed', JSON.stringify(r2.skipped));
}

console.log('— full strips 10 + loose 103 on a 10s -> imports as 20.3 AND raises the caution (both kinds) —');
{
  const r1 = (await post('/parse/stock?hid=viraj', fillTpl(await tb('opening'), [['Caution Open', PACK, 10, 103, '', NR, MRP]]), 'o4.xlsx')).data;
  ok(near(r1.items[0].qty, 20.3), 'opening: 10 + 103/10 = 20.3, imported — not rejected', r1.items[0].qty);
  ok(r1.cautions.length === 1 && r1.cautions[0].name === 'Caution Open', 'and a caution names the row', JSON.stringify(r1.cautions));
  const r2 = (await post('/parse/gpreport?hid=viraj', fillTpl(await tb('sales'), [['Caution Sale', PACK, 10, 103, '', NR, MRP]]), 's4.xlsx')).data;
  ok(near(r2.items[0].qty, 20.3), 'sales: 10 + 103/10 = 20.3, imported', r2.items[0].qty);
  ok(r2.cautions.length === 1 && r2.cautions[0].name === 'Caution Sale', 'and a caution names the row', JSON.stringify(r2.cautions));
  // the invariant holds even with a caution present — a caution is not a skip
  ok(r1.fileRows === r1.imported + r1.skipped.length, 'receipt invariant holds through a caution (opening)', JSON.stringify(r1));
  ok(r2.fileRows === r2.imported + r2.skipped.length, 'receipt invariant holds through a caution (sales)', JSON.stringify(r2));
}

console.log('— a small loose amount alongside strips raises NO caution — only a full-strip-or-more does —');
{
  const r1 = (await post('/parse/stock?hid=viraj', fillTpl(await tb('opening'), [['No Caution', PACK, 10, 3, '', NR, MRP]]), 'o5.xlsx')).data;
  ok((r1.cautions || []).length === 0, 'opening: 3 loose (< 1 pack) is unremarkable', JSON.stringify(r1.cautions));
}

console.log('— import receipt still balances with a genuine mix of clean, rejected and cautioned rows —');
{
  const r = (await post('/parse/gpreport?hid=viraj', fillTpl(await tb('sales'), [
    ['Clean', PACK, 2, 5, '', NR, MRP],
    ['', PACK, 2, '', '', NR, MRP],                    // blank name
    ['Vial Bad', 'vial', '', 10, '', 38, 58],          // loose on a vial
    ['Total', '', '', '', '', '', ''],                 // total row
    ['Caution Row', PACK, 10, 103, '', NR, MRP]        // caution, but imports
  ]), 'mix.xlsx')).data;
  ok(r.fileRows === 5, 'five rows in the file', r.fileRows);
  ok(r.imported === 2, 'two import (Clean + Caution Row)', r.imported);
  ok(r.skipped.length === 3, 'three do not (blank name, vial-loose, total row)', JSON.stringify(r.skipped.map(s => s.reason)));
  ok(r.ignored === 1, 'exactly one of those is the total row, tallied separately', r.ignored);
  ok(r.cautions.length === 1 && r.cautions[0].name === 'Caution Row', 'and one caution rides with an IMPORTED row, not a skipped one', JSON.stringify(r.cautions));
  ok(r.fileRows === r.imported + r.skipped.length, 'the invariant holds through the whole mix', JSON.stringify(r));
}

console.log('— the » helper headers are claimed by NO column matcher, in either template —');
{
  for (const kind of ['opening', 'sales']) {
    const buf = await tb(kind);
    const sheetName = kind === 'opening' ? 'Opening stock' : 'Sales';
    const hdr = XLSX.utils.sheet_to_json(XLSX.read(buf, { type: 'buffer' }).Sheets[sheetName], { header: 1 })[0];
    const helperCols = hdr.map((h, i) => ({ h, i })).filter(x => /^»/.test(String(x.h || '')));
    ok(helperCols.length >= 5, `${kind}: at least five » helper columns are shipped`, helperCols.map(x => x.h).join(' | '));
    /* a REAL, valid row (name + the real quantity/rate columns, small distinct
       values) PLUS every » helper column filled with a large decoy value. If
       any helper were wrongly claimed by a real COL matcher — stealing the
       assignment from the genuine column, or being read as qty/nr/mrp itself
       — the resolved row would show the decoy (999999) instead of the real
       number. This is a stronger proof than "a helpers-only sheet parses to
       nothing", which would pass even if a collision existed. */
    const qtyHdr = kind === 'opening' ? 'Opening stock (strips)' : 'Qty sold (strips)';
    const trapHdr = ['Product name', qtyHdr, 'Net rate — single strip (incl. GST)', 'MRP — single strip', ...helperCols.map(x => x.h)];
    const trapRow = ['Trap Item', 5, 12, 21, ...helperCols.map(() => 999999)];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([trapHdr, trapRow]), 'Sheet1');
    const trapBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const path = kind === 'opening' ? '/parse/stock?hid=viraj' : '/parse/gpreport?hid=viraj';
    const r = (await post(path, trapBuf, 'trap.xlsx')).data;
    ok(r.source === 'template' && r.items.length === 1, `${kind}: the real row still reads`, JSON.stringify(r).slice(0, 200));
    const it = r.items[0];
    ok(near(it.qty, 5) && near(it.nr, 12) && near(it.mrp, 21) && (it.pack ?? '') === '', `${kind}: every helper's decoy (999999) is invisible — the real qty/nr/mrp/pack come through untouched`, JSON.stringify(it));
  }
}

/* ============================== THE STOCK LEDGER: fractional qty + FEFO ============================== */
console.log('— fractional quantities survive stockAsOf and a part strip consumes across lots proportionally (FEFO) —');
{
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null;
      w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
  const w = dom.window, doc = w.document;
  await tick(400);
  doc.querySelector('[data-quick="admin"]').click(); await tick(700);

  const d1 = addDays(T, -5), d2 = addDays(T, -4), d3 = addDays(T, -1);
  w.eval(`
    db.items.viraj = [{id:'ft1', name:'Tab. Frac Test', key:nameKey('Tab. Frac Test'), pack:'10s', nr:0, mrp:0, openingQty:0, source:'demo', updatedAt:Date.now()}];
    db.hospitals.viraj.stockDate = '${addDays(T, -10)}';
    db.adjustments.viraj = []; db.dailyData.viraj = {};
    const blankDay = () => ({ savedAt:Date.now(), purchases:[], rtv:[], itemSales:[], audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[],
      sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, invoices:[] });
    // EARLY-expiring lot (5 strips) and a LATER-expiring lot (10 strips) —
    // FEFO must draw the earlier-expiring one first, and fully, before touching the other
    db.dailyData.viraj['${d1}'] = { ...blankDay(), invoices:[{id:'i1', vendor:'V', invoiceNo:'1', date:'${d1}', fileName:'', lines:[
      {item:'Tab. Frac Test', batch:'EARLY', exp:'2026-08', pqty:5, oqty:0, rate:70, disc:0, gst:0, mrp:100}
    ]}] };
    db.dailyData.viraj['${d2}'] = { ...blankDay(), invoices:[{id:'i2', vendor:'V', invoiceNo:'2', date:'${d2}', fileName:'', lines:[
      {item:'Tab. Frac Test', batch:'LATE', exp:'2026-10', pqty:10, oqty:0, rate:80, disc:0, gst:0, mrp:100}
    ]}] };
    // a FRACTIONAL sale — 7.3 strips, more than the first lot alone can cover
    db.dailyData.viraj['${d3}'] = { ...blankDay(),
      sales:{mrp:730,cogs:5*70+2.3*80,cash:730,credit:0,cancels:0},
      itemSales:[{item:'Tab. Frac Test', qty:7.3, amount:730, pack:'10s', nr:80, mrp:100, cost:5*70+2.3*80}] };
  `);
  const stock = w.eval(`stockAsOf('viraj', todayISO()).items.find(m=>m.key===nameKey('Tab. Frac Test')).stock`);
  ok(near(stock, 7.7), 'stock = (5+10 received) − 7.3 sold = 7.7, not rounded away', stock);
  const valueNr = w.eval(`stockAsOf('viraj', todayISO()).items.find(m=>m.key===nameKey('Tab. Frac Test')).valueNr`);
  ok(near(valueNr, 7.7 * 80), 'value at net rate follows the REMAINING lot only (0 × 70 + 7.7 × 80 = ₹616) — proportional, not averaged', valueNr);
  const batches = w.eval(`JSON.parse(JSON.stringify(stockAsOf('viraj', todayISO()).batches.filter(b=>b.key===nameKey('Tab. Frac Test'))))`);
  const early = batches.find(b => b.batchNo === 'EARLY'), late = batches.find(b => b.batchNo === 'LATE');
  ok(near(early.qty, 0), 'FEFO drained the EARLIER-expiring lot completely first', early.qty);
  ok(near(late.qty, 7.7), 'and the fractional remainder sits in the LATER lot — a part strip consumes across lots, proportionally', late.qty);
  const sold = w.eval(`stockAsOf('viraj', todayISO()).items.find(m=>m.key===nameKey('Tab. Frac Test')).sold`);
  ok(near(sold, 7.3), 'the Sold column reads the exact fractional figure, 7.3', sold);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
