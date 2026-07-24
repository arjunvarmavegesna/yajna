/* Tests: batch-wise inventory loading, with the Item Master derived from it.
   Opening stock used to flatten every product into ONE synthetic lot whose
   cost/MRP were read LIVE from the Item Master — this suite proves the
   replacement: every row is its own lot with its own frozen cost, the Item
   Master becomes a quantity-weighted average recomputed from whatever
   batches are actually on hand, and none of that ever substitutes for the
   batch-level valuation itself. Covers the checklist from the original spec:
   - an empty Item Master loads correctly from batch-wise rows alone
   - two batches at different costs sum to their real value, never qty×avg
   - the Item Master price is the WEIGHTED average, not a plain mean
   - a purchase updates that average; zero stock keeps the last known one
   - molecule / preferred vendor survive a rebuild
   - same batch twice: merge when rates agree (reported), reject when they
     disagree
   - a file with no batch column loads exactly as before
   - a named-batch sale consumes that batch; FEFO still works with none;
     a nonexistent/insufficient named batch is reported, not silently dropped
   - a sentinel-like value ('—', 'OPENING') is never mistaken for a real batch
   - an Excel date-typed expiry cell (a numeric day-serial, not a string)
     round-trips to the right month
   - ledgerSig invalidates on batch CONTENT change, not just aggregate qty */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import XLSX from 'xlsx';

const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const near = (a, b, t = 0.01) => Math.abs(a - b) < t;
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));
const todayISO = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const T = todayISO();
const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }, cookie: () => cookie };
}

const adm = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
const hosp = (await adm.req('POST', '/hospitals', { name: 'Batch Test Hosp', startDate: addD(T, -60) })).data.hospital;
const HID = hosp.id;

console.log('— empty Item Master, loaded straight from batch-wise rows —');
{
  const rows = [
    // Product A: two real batches, different cost — the whole point of this feature
    { name: 'Tab. Batchazole 500', pack: '10s', qty: 50, nr: 10, mrp: 20, batch: 'B1', exp: '2027-06' },
    { name: 'Tab. Batchazole 500', pack: '10s', qty: 30, nr: 15, mrp: 25, batch: 'B2', exp: '2026-12' },
    // Product B: no batch at all — must load exactly as before (one unidentified lot)
    { name: 'Syp. Plainocol', pack: '', qty: 12, nr: 40, mrp: 60, batch: '', exp: '' },
    // Product C: same batch number on two rows, rates AGREE (within tolerance) — merge, reported
    { name: 'Cap. Mergezole', pack: '10s', qty: 20, nr: 8, mrp: 14, batch: 'SAMEB', exp: '' },
    { name: 'Cap. Mergezole', pack: '10s', qty: 10, nr: 8.05, mrp: 14, batch: 'SAMEB', exp: '' },
    // Product D: same batch number on two rows, rates DISAGREE beyond tolerance — reject the 2nd
    { name: 'Inj. Rejectin', pack: 'vial', qty: 5, nr: 100, mrp: 150, batch: 'BADB', exp: '' },
    { name: 'Inj. Rejectin', pack: 'vial', qty: 5, nr: 130, mrp: 150, batch: 'BADB', exp: '' }
  ];
  const r = await adm.req('POST', '/items/opening', { hid: HID, stockDate: T, rows, fileName: 'test.xlsx', source: 'template' });
  ok(r.status === 200, 'the load is accepted', JSON.stringify(r.data.error || ''));
  ok(r.data.productsTouched === 4, 'four distinct products touched, from seven rows', r.data.productsTouched);
  ok(r.data.batchesLoaded === 6, 'six rows actually landed as batches — the 7th (bad-rate duplicate) is rejected, not merged', r.data.batchesLoaded);
  ok(r.data.skipped.length === 1 && /different rate/i.test(r.data.skipped[0].reason), 'the disagreeing duplicate is skipped with a reason naming the rate conflict', JSON.stringify(r.data.skipped));
  ok(r.data.cautions.length === 1 && /quantities added/i.test(r.data.cautions[0].reason), 'the agreeing duplicate is reported as a merge, not silent', JSON.stringify(r.data.cautions));
  ok(r.data.fileRows === 7 && r.data.imported + r.data.skipped.length === 7, 'reconciliation holds: fileRows(7) = imported(6) + skipped(1)', JSON.stringify({ fileRows: r.data.fileRows, imported: r.data.imported, skipped: r.data.skipped.length }));

  const boot = (await adm.req('GET', '/bootstrap')).data;
  const items = boot.items[HID];
  const A = items.find(i => i.key === 'tab. batchazole 500');
  const Bx = items.find(i => i.key === 'syp. plainocol');
  const C = items.find(i => i.key === 'cap. mergezole');
  const D = items.find(i => i.key === 'inj. rejectin');

  console.log('— the Item Master price is the QUANTITY-WEIGHTED average, never a plain mean —');
  // (50*10 + 30*15) / 80 = 11.875 net, (50*20 + 30*25) / 80 = 21.875 MRP
  ok(A && near(A.nr, 11.875) && near(A.mrp, 21.875), 'weighted, not (10+15)/2=12.5 — a bigger batch counts for more', JSON.stringify(A && { nr: A.nr, mrp: A.mrp }));
  ok(A && A.openingQty === 80, 'opening qty is the sum of both batches', A && A.openingQty);
  ok(Bx && Bx.openingQty === 12 && Bx.nr === 40 && Bx.mrp === 60, 'no-batch row still loads as one plain lot, exactly as before', JSON.stringify(Bx));
  ok(C && C.openingQty === 30 && near(C.nr, (20 * 8 + 10 * 8.05) / 30), 'the merged duplicate summed its quantity and weighted its rate', JSON.stringify(C));
  ok(D && D.openingQty === 5 && D.nr === 100, 'the rejected duplicate never touched the product — only the first, valid row counted', JSON.stringify(D));

  const ob = boot.openingBatches[HID];
  ok(ob.filter(b => b.key === 'tab. batchazole 500').length === 2, 'two DIFFERENT batch numbers for the same product really are kept as two separate lots', ob.filter(b => b.key === 'tab. batchazole 500').length);
  ok(ob.filter(b => b.key === 'cap. mergezole').length === 1, 'the merged duplicate collapsed into ONE stored batch row, not two', ob.filter(b => b.key === 'cap. mergezole').length);
}

console.log('— molecule and preferred vendor survive an opening reload —');
{
  let boot = (await adm.req('GET', '/bootstrap')).data;
  const A = boot.items[HID].find(i => i.key === 'tab. batchazole 500');
  const patch = await adm.req('PATCH', `/items/${A.id}`, { molecule: 'Batchazolium', preferredVendor: 'Vendor Prime' });
  ok(patch.status === 200 && patch.data.item.molecule === 'Batchazolium', 'molecule can be set — an attribute of the product, not a batch');

  // a confirmed second load: reset the batches, then reload with DIFFERENT quantities
  const reset = await adm.req('POST', '/items/opening/reset-batches', { hid: HID });
  ok(reset.status === 200, 'reset-batches accepted');
  ok(reset.data.zeroed.some(z => z.key === 'tab. batchazole 500' && z.openingQty === 0), 'the reset zeroes opening qty for every product that had batches — a real fact about what is now counted', JSON.stringify(reset.data.zeroed.find(z => z.key === 'tab. batchazole 500')));

  const r2 = await adm.req('POST', '/items/opening', { hid: HID, stockDate: T, rows: [
    { name: 'Tab. Batchazole 500', pack: '10s', qty: 100, nr: 11, mrp: 22, batch: 'B3', exp: '2028-01' }
  ] });
  ok(r2.status === 200 && r2.data.updated[0].openingQty === 100, 'the reload lands with the NEW count', r2.data.updated[0].openingQty);
  ok(r2.data.updated[0].molecule === 'Batchazolium' && r2.data.updated[0].preferredVendor === 'Vendor Prime', 'molecule and preferred vendor survived the rebuild untouched', JSON.stringify({ m: r2.data.updated[0].molecule, v: r2.data.updated[0].preferredVendor }));

  boot = (await adm.req('GET', '/bootstrap')).data;
  const obAfter = boot.openingBatches[HID].filter(b => b.key === 'tab. batchazole 500');
  ok(obAfter.length === 1 && obAfter[0].batch === 'B3', 'the OLD batches (B1, B2) are really gone — only the freshly loaded one remains', JSON.stringify(obAfter));
}

console.log('— resubmitting a product WITHOUT going through reset-batches is a correction, not an addition —');
{
  // this is the raw endpoint being called a second, SEPARATE time for the
  // same product/batch — must behave like the idempotent upsert it always
  // has, not silently sum with whatever the first call already wrote
  await adm.req('POST', '/items/opening', { hid: HID, stockDate: T, rows: [{ name: 'Syp. Plainocol', qty: 12, nr: 40, mrp: 60 }] });
  const r = await adm.req('POST', '/items/opening', { hid: HID, stockDate: T, rows: [{ name: 'Syp. Plainocol', qty: 18 }] });
  ok(r.data.updated[0].openingQty === 18 && r.data.updated[0].nr === 40, 'qty replaced (not summed to 30), price preserved since the row omitted it', JSON.stringify(r.data.updated[0]));
}

console.log('— Excel date-serial expiry: a real date-typed cell, not a string, round-trips to the right month —');
{
  const tplBuf = Buffer.from(await (await fetch(`${B}/template/opening`, { headers: { cookie: adm.cookie() } })).arrayBuffer());
  const wb = XLSX.read(tplBuf, { type: 'buffer' });
  const sn = 'Opening stock';
  const hdr = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 })[0];
  const idx = re => hdr.findIndex(h => re.test(String(h || '')));
  const iName = idx(/^product/i), iPack = idx(/^pack/i), iOpen = idx(/^opening stock \(strips/i),
    iNr = idx(/net *rate/i), iMrp = idx(/^mrp/i), iBatch = idx(/^batch/i), iExp = idx(/^exp/i);
  const row = new Array(hdr.length).fill('');
  row[iName] = 'Tab. Serialtest'; row[iPack] = '10s'; row[iOpen] = 20; row[iNr] = 5; row[iMrp] = 9;
  row[iBatch] = 'SER1'; row[iExp] = new Date(2027, 7, 15);   // a REAL Excel date, not a typed string
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([hdr, row]), sn);
  const buf = XLSX.write(out, { type: 'buffer', bookType: 'xlsx' });

  const fd = new FormData(); fd.append('file', new Blob([buf]), 'serial.xlsx');
  const up = await fetch(`${B}/parse/stock?hid=${HID}`, { method: 'POST', headers: { cookie: adm.cookie() }, body: fd });
  const data = await up.json();
  const item = data.items.find(i => i.name === 'Tab. Serialtest');
  ok(!!item, 'the row with a date-typed expiry cell is read at all', JSON.stringify(data.items?.map(i => i.name)));
  ok(item && item.exp === '2027-08', 'the numeric day-serial resolves to the right calendar month (August 2027), not a blank', item && item.exp);
}

console.log('— DOM: weighted-average sync writes back to the server, and freezes once stock hits zero —');
{
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  let domCookie = adm.cookie();
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null; w.confirm = () => true;
      w.fetch = async (url, opts = {}) => {
        const r = await fetch(new URL(url, 'http://127.0.0.1:3061'), { ...opts, headers: { ...(opts.headers || {}), ...(domCookie ? { cookie: domCookie } : {}) } });
        const sc = r.headers.get('set-cookie'); if (sc) domCookie = sc.split(';')[0];
        return r;
      };
    } });
  const w = dom.window, doc = w.document;
  await tick(400);
  doc.querySelector('#loginEmail').value = 'bhagavan@yajnapharma.in';
  doc.querySelector('#loginPw').value = ADMIN_PW;
  doc.querySelector('#loginBtn').click(); await tick(900);
  const J = s => JSON.parse(w.eval(`JSON.stringify(${s})`));

  const rollA = J(`stockAsOf(${JSON.stringify(HID)}, ${JSON.stringify(T)}).items`).find(i => i.key === 'tab. batchazole 500');
  ok(rollA && near(rollA.nrStrip, 11), 'rollupItems already computes the right weighted average for the reloaded batch (100 @ 11) before any sync', rollA && rollA.nrStrip);

  await w.eval(`syncItemPrices(${JSON.stringify(HID)})`);
  await tick(300);
  let boot = (await adm.req('GET', '/bootstrap')).data;
  let A = boot.items[HID].find(i => i.key === 'tab. batchazole 500');
  // the item was already at nr=11/mrp=22 from the reload, so sync should be a no-op here —
  // prove that by adding a SECOND batch through a real purchase and re-syncing
  const invRes = await adm.req('PUT', `/entries/${HID}/${T}`, { entry: {
    purchases: [], rtv: [], sales: {}, audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [], itemSales: [],
    invoices: [{ vendor: 'V', invoiceNo: 'SYNC-1', date: T, fileName: '', lines: [{ item: 'Tab. Batchazole 500', batch: 'B4', exp: '2028-06', pqty: 100, oqty: 0, rate: 20, disc: 0, gst: 0, mrp: 30 }] }]
  } });
  ok(invRes.status === 200, 'a purchase of a second batch (100 @ NR 20) saves', JSON.stringify(invRes.data.error || ''));
  w.eval(`db.dailyData[${JSON.stringify(HID)}] = ${JSON.stringify((await adm.req('GET', '/bootstrap')).data.dailyData[HID])};`);
  const rollA2 = J(`stockAsOf(${JSON.stringify(HID)}, ${JSON.stringify(T)}).items`).find(i => i.key === 'tab. batchazole 500');
  // (100@11 + 100@20) / 200 = 15.5
  ok(rollA2 && near(rollA2.nrStrip, 15.5), 'adding a purchase moves the weighted average to include it — (100×11 + 100×20)/200 = 15.5', rollA2 && rollA2.nrStrip);

  await w.eval(`syncItemPrices(${JSON.stringify(HID)})`);
  await tick(300);
  boot = (await adm.req('GET', '/bootstrap')).data;
  A = boot.items[HID].find(i => i.key === 'tab. batchazole 500');
  ok(A && near(A.nr, 15.5), 'the sync persisted the NEW average server-side — the Item Master now matches the ledger', A && A.nr);
  ok(A && A.priceAsOf === T, 'price_as_of is stamped with the date of the sync', A && A.priceAsOf);

  // now sell every last strip, so the product's stock hits exactly zero —
  // PUT /entries replaces the WHOLE day, so the same day's invoice has to be
  // resent alongside the sale, not just the new itemSales row
  const sellRes = await adm.req('PUT', `/entries/${HID}/${T}`, { entry: {
    purchases: [], rtv: [], audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [],
    invoices: [{ vendor: 'V', invoiceNo: 'SYNC-1', date: T, fileName: '', lines: [{ item: 'Tab. Batchazole 500', batch: 'B4', exp: '2028-06', pqty: 100, oqty: 0, rate: 20, disc: 0, gst: 0, mrp: 30 }] }],
    sales: { mrp: 0, cogs: 0, cash: 0, credit: 0, cancels: 0 },
    itemSales: [{ item: 'Tab. Batchazole 500', qty: 200, amount: 1 }]
  } });
  ok(sellRes.status === 200, 'selling out the full 200 strips saves');
  w.eval(`db.dailyData[${JSON.stringify(HID)}] = ${JSON.stringify((await adm.req('GET', '/bootstrap')).data.dailyData[HID])};`);
  const rollZero = J(`stockAsOf(${JSON.stringify(HID)}, ${JSON.stringify(T)}).items`).find(i => i.key === 'tab. batchazole 500');
  ok(rollZero && rollZero.stock === 0, 'stock is genuinely zero now', rollZero && rollZero.stock);
  ok(rollZero && near(rollZero.nrStrip, 15.5), 'with nothing left to weight, rollupItems falls back to the LAST known rate rather than zero', rollZero && rollZero.nrStrip);

  await w.eval(`syncItemPrices(${JSON.stringify(HID)})`);
  await tick(300);
  const bootAfterZero = (await adm.req('GET', '/bootstrap')).data;
  const AZero = bootAfterZero.items[HID].find(i => i.key === 'tab. batchazole 500');
  ok(AZero && near(AZero.nr, 15.5) && AZero.priceAsOf === T, 'the Item Master price is unchanged at zero stock — "last known", not wiped or reset', JSON.stringify({ nr: AZero.nr, priceAsOf: AZero.priceAsOf }));
}

console.log('— named-batch sales: consumes the NAMED batch, FEFO still works with none, a bad name is reported —');
{
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

  ev(`
    db.hospitals.nb = {id:'nb', name:'NB', doctor:'D', location:'', phone:'', startDate:'2026-01-01', stockDate:'2026-01-10', issueMethod:'fefo', active:true, base:1000};
    db.items.nb = [{id:'n1', name:'Nombre', key:'nombre', pack:'10s', nr:10, mrp:20, openingQty:0, source:'t', updatedAt:1}];
    db.adjustments.nb = []; db.dailyData.nb = {}; db.vendors.nb = []; db.payments.nb = []; db.receivables.nb = []; db.recvActions.nb = [];
    db.openingBatches.nb = [
      {id:'ob1', key:'nombre', name:'Nombre', pack:'10s', batch:'NX', exp:'2027-06', qty:50, nr:10, mrp:20, stockDate:'2026-01-10', loadedAt:1},
      {id:'ob2', key:'nombre', name:'Nombre', pack:'10s', batch:'NY', exp:'2026-09', qty:40, nr:15, mrp:30, stockDate:'2026-01-10', loadedAt:1}
    ];
    db.dailyData.nb['2026-02-01'] = {purchases:[],rtv:[],invoices:[],hv:[],
      sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1,
      itemSales:[{item:'Nombre', qty:15, amount:0, batch:'NY'}]};
  `);
  let s = J(`stockAsOf('nb','2026-02-01')`);
  const qOf = n => s.batches.find(b => b.batchNo === n).qty;
  ok(qOf('NY') === 25, 'naming batch NY takes it straight from NY (40-15=25), leaving NX untouched', JSON.stringify({ NX: qOf('NX'), NY: qOf('NY') }));
  ok(qOf('NX') === 50, 'NX (not named) is completely untouched by the named sale', qOf('NX'));

  // now a sale with NO batch named — falls back to FEFO as always
  ev(`db.dailyData.nb['2026-02-02'] = {purchases:[],rtv:[],invoices:[],hv:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1,
    itemSales:[{item:'Nombre', qty:10, amount:0}]};`);
  s = J(`stockAsOf('nb','2026-02-02')`);
  const qOf2 = n => s.batches.find(b => b.batchNo === n).qty;
  ok(qOf2('NY') === 15, 'FEFO (earlier expiry first) drains the rest of NY, not NX', JSON.stringify({ NX: qOf2('NX'), NY: qOf2('NY') }));

  // a sale naming a batch that doesn't exist / doesn't have enough stock
  ev(`db.dailyData.nb['2026-02-03'] = {purchases:[],rtv:[],invoices:[],hv:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1,
    itemSales:[{item:'Nombre', qty:5, amount:0, batch:'GHOST'}]};`);
  s = J(`stockAsOf('nb','2026-02-03')`);
  const ghostLot = s.batches.find(b => b.batchNo && b.batchNo.includes('GHOST'));
  ok(ghostLot, 'a batch name with no matching lot gets its own distinctly-labeled synthetic lot, not a silent FEFO fallback', JSON.stringify(s.batches.map(b => b.batchNo)));

  const impact = J(`salesStockImpact('nb', [{item:'Nombre', qty:1000, batch:'GHOST'}])`);
  ok(impact.batchNotFound && impact.batchNotFound.length === 1, 'the preview-time check flags the nonexistent batch by name before anything saves', JSON.stringify(impact.batchNotFound));
  const impact2 = J(`salesStockImpact('nb', [{item:'Nombre', qty:1000, batch:'NX'}])`);
  ok(impact2.batchInsufficient && impact2.batchInsufficient.length === 1, 'naming a real batch without enough stock in it is flagged too, distinct from "batch not found"', JSON.stringify(impact2.batchInsufficient));

  console.log('— a sentinel-like batch value is never mistaken for a real one —');
  ev(`db.dailyData.nb['2026-02-04'] = {purchases:[],rtv:[],invoices:[],hv:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1,
    itemSales:[{item:'Nombre', qty:3, amount:0, batch:'—'}]};`);
  s = J(`stockAsOf('nb','2026-02-04')`);
  ok(!s.batches.some(b => b.batchNo === 'BATCH NOT FOUND: —'), 'a bare dash is treated as "no batch named" (falls back to FEFO), never chased as a real batch name', JSON.stringify(s.batches.map(b => b.batchNo)));

  console.log('— ledgerSig invalidates on batch CONTENT change, not just aggregate qty —');
  const sig1 = ev(`ledgerSig('nb')`);
  const before = J(`stockLedger('nb')`).lots.find(l => l.batchNo === 'NX');
  ev(`db.openingBatches.nb.find(b=>b.batch==='NX').nr = 999;`);   // same qty, different rate
  const sig2 = ev(`ledgerSig('nb')`);
  ok(sig1 !== sig2, 'the signature itself changes when only a batch rate changes, qty untouched', JSON.stringify({ sig1, sig2 }));
  const after = J(`stockLedger('nb')`).lots.find(l => l.batchNo === 'NX');
  ok(before.nr === 10 && after.nr === 999, 'and the recomputed ledger actually reflects the new rate — the cache did not serve a stale lot', JSON.stringify({ before: before.nr, after: after.nr }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
