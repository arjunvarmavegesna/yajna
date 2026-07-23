/* Tests: the standard import receipt — every upload endpoint reports
   fileRows / imported / skipped[{row,name,reason}] / ignored, and
   fileRows === imported + skipped.length always. Each suite gets its OWN
   fresh database (runall.sh), so hospital/item names need no cross-suite
   uniqueness — only within this file. */
import XLSX from '../node_modules/xlsx/xlsx.js';

const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const todayISO = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const T = todayISO();

let cookie = '';
const req = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let data = {}; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
};
const post = async (path, buf, name, fields) => {
  const fd = new FormData();
  Object.entries(fields || {}).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', new Blob([buf]), name);
  const rr = await fetch(B + path, { method: 'POST', headers: { cookie }, body: fd });
  return { status: rr.status, data: await rr.json().catch(() => ({})) };
};
const sheet = (rows, name = 'Sheet1') => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
};
/* the invariant this whole feature exists for */
const invariant = (r, label) => ok(r.fileRows === r.imported + r.skipped.length,
  `${label}: fileRows(${r.fileRows}) === imported(${r.imported}) + skipped(${r.skipped.length})`, JSON.stringify(r));

await req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });

/* ============================== PURCHASE ============================== */
console.log('— purchase: the invariant on a clean file —');
const PHDR = ['Item', 'Pack size', 'Purchase Qty (strips)', 'Offer Qty', 'Rate', 'Vendor Disc %', 'GST %', 'MRP'];
let r = await post(`/parse/purchase?hid=viraj&date=${T}`, sheet([PHDR,
  ['Clean A', '10s', 10, 1, 85, 10, 12, 120],
  ['Clean B', '10s', 5, 0, 50, 0, 5, 80],
  ['Clean C', '10s', 8, 0, 30, 0, 5, 50]
]), 'p.xlsx', { vendor: 'Test Distributors' });
ok(r.status === 200, 'a clean purchase file parses', JSON.stringify(r.data).slice(0, 200));
invariant(r.data, 'purchase clean');
ok(r.data.fileRows === 3 && r.data.imported === 3 && r.data.skipped.length === 0, 'nothing dropped on a clean file', JSON.stringify(r.data.skipped));

console.log('— purchase: 10 rows, 3 negative rates — imported 7, skipped 3, each with a row + reason —');
const tenRows = [
  ['Item A', '10s', 10, 1, 85, 10, 12, 120],
  ['Item B', '10s', 5, 0, 50, 0, 5, 80],
  ['Item C', '10s', -2, 0, 40, 0, 12, 60],    // negative pqty
  ['Item D', '10s', 8, 0, 30, 0, 5, 50],
  ['Item E', '10s', 6, 0, -10, 0, 12, 45],    // negative rate
  ['Item F', '10s', 4, 0, 20, 0, 5, 35],
  ['Item G', '10s', 3, 0, 25, 0, 12, -5],     // negative mrp
  ['Item H', '10s', 7, 0, 60, 0, 18, 90],
  ['Item I', '10s', 2, 0, 15, 0, 5, 25],
  ['Item J', '10s', 9, 0, 45, 0, 12, 70]
];
const dirtyBuf = sheet([PHDR, ...tenRows]);
r = await post(`/parse/purchase?hid=viraj&date=${T}`, dirtyBuf, 'dirty.xlsx', { vendor: 'Test Distributors' });
ok(r.status === 200, 'the dirty file still parses (partial success, not a hard failure)');
invariant(r.data, 'purchase dirty');
ok(r.data.fileRows === 10, '10 rows in the file', r.data.fileRows);
ok(r.data.imported === 7, '7 imported', r.data.imported);
ok(r.data.skipped.length === 3, '3 not imported', r.data.skipped.length);
ok(r.data.skipped.every(s => typeof s.row === 'number' && s.name && /negative value/i.test(s.reason)), 'each names its row, item and the reason', JSON.stringify(r.data.skipped));
ok(new Set(r.data.skipped.map(s => s.name)).size === 3 &&
   ['Item C', 'Item E', 'Item G'].every(n => r.data.skipped.some(s => s.name === n)), 'exactly the three negative rows', JSON.stringify(r.data.skipped.map(s => s.name)));

console.log('— purchase: a blank-name row is reported, not silently dropped —');
r = await post(`/parse/purchase?hid=viraj&date=${T}`, sheet([PHDR,
  ['', '10s', 5, 0, 50, 0, 5, 80],
  ['Named Row', '10s', 5, 0, 50, 0, 5, 80]
]), 'blank.xlsx', { vendor: 'Test Distributors' });
invariant(r.data, 'purchase blank-name');
ok(r.data.fileRows === 2 && r.data.imported === 1 && r.data.skipped.length === 1, 'one row in, one blank dropped WITH a reason', JSON.stringify(r.data));
ok(/no product name/i.test(r.data.skipped[0].reason), 'the reason says so', r.data.skipped[0].reason);

console.log('— purchase: a total row is `ignored`, not an error —');
r = await post(`/parse/purchase?hid=viraj&date=${T}`, sheet([PHDR,
  ['Real Row', '10s', 5, 0, 50, 0, 5, 80],
  ['Grand Total', '', '', '', '', '', '', '']
]), 'total.xlsx', { vendor: 'Test Distributors' });
invariant(r.data, 'purchase total-row');
ok(r.data.imported === 1 && r.data.skipped.length === 1 && r.data.ignored === 1, 'the total row is counted separately as ignored', JSON.stringify(r.data));
ok(/total row/i.test(r.data.skipped.find(s => s.name === 'Grand Total').reason), 'and named for what it is', JSON.stringify(r.data.skipped));

console.log('— purchase: wrong headers → the clear "no sheet matched" receipt, no AI fallback exists —');
r = await post(`/parse/purchase?hid=viraj&date=${T}`, sheet([['Foo', 'Bar'], ['x', 'y']]), 'wrong.xlsx', { vendor: 'Test Distributors' });
ok(r.status === 400 && /no sheet matched/i.test(r.data.error), 'the refusal names the problem', r.data.error);
ok(Array.isArray(r.data.expected) && r.data.expected.some(h => /item|product/i.test(h)), 'and lists the headers it expected', JSON.stringify(r.data.expected));
ok(r.data.fileRows === 0 && r.data.imported === 0 && Array.isArray(r.data.skipped), 'still receipt-shaped, not a bare error', JSON.stringify(r.data));

/* ============================== DOWNLOAD NOT-IMPORTED ROWS (round trip) ============================== */
console.log('— the not-imported XLSX re-uploads cleanly once its rows are corrected —');
r = await post(`/parse/purchase?hid=viraj&date=${T}`, dirtyBuf, 'dirty2.xlsx', { vendor: 'Test Distributors' });
const dirtySkipped = r.data.skipped;
ok(dirtySkipped.length === 3, 'three rows to fix', dirtySkipped.length);
const ndRes = await fetch(B + '/import-receipts/not-imported', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ kind: 'purchase', skipped: dirtySkipped }) });
ok(ndRes.status === 200, 'the not-imported sheet builds', ndRes.status);
ok(/spreadsheetml/.test(ndRes.headers.get('content-type') || ''), 'as a real xlsx');
const ndBuf = Buffer.from(await ndRes.arrayBuffer());
const ndGrid = XLSX.utils.sheet_to_json(XLSX.read(ndBuf, { type: 'buffer' }).Sheets['Purchase'], { header: 1 });
const ndHdr = ndGrid[0];
ok(ndHdr.some(h => /reason/i.test(h)) && ndHdr.some(h => /row in the original file/i.test(h)), 'carries a Reason column and the original row number', ndHdr.join(' | '));
ok(ndGrid.length - 1 === 3, 'one row per skipped item, pre-filled', ndGrid.length - 1);
const idx = re => ndHdr.findIndex(h => re.test(String(h || '')));
const iItem = idx(/^item/i), iPqty = idx(/purchase *qty/i), iRate = idx(/^rate/i), iMrp = idx(/^mrp/i);
ok(iItem >= 0 && iPqty >= 0 && iRate >= 0 && iMrp >= 0, 'the same template columns are all present', ndHdr.join(' | '));
for (let i = 1; i < ndGrid.length; i++) {
  const row = ndGrid[i];
  if (row[iItem] === 'Item C') row[iPqty] = 2;      // was -2
  if (row[iItem] === 'Item E') row[iRate] = 10;     // was -10
  if (row[iItem] === 'Item G') row[iMrp] = 5;       // was -5
}
const fixedBuf = sheet(ndGrid, 'Purchase');
const reRes = await post(`/parse/purchase?hid=viraj&date=${T}`, fixedBuf, 'fixed.xlsx', { vendor: 'Test Distributors' });
invariant(reRes.data, 'purchase re-upload of the fixed sheet');
ok(reRes.data.imported === 3 && reRes.data.skipped.length === 0, 'all three corrected rows import cleanly now', JSON.stringify(reRes.data));

/* ============================== ITEMS (master) ============================== */
console.log('— items: the invariant, blank name, total row —');
const IHDR = ['Product name', 'Molecule / salt', 'Pack size', 'Net rate', 'MRP'];
r = await post('/parse/items?hid=viraj', sheet([IHDR,
  ['IR Item One', 'Mol One', '10s', 40, 90],
  ['', 'Some Mol', '10s', 40, 90],                        // blank name
  ['Grand Total', '', '', '', '']
]), 'items.xlsx');
invariant(r.data, 'items clean+dirty mix');
ok(r.data.fileRows === 3 && r.data.parsed === 1 && r.data.skipped.length === 2 && r.data.ignored === 1, 'one real row, a blank and a total both accounted for', JSON.stringify(r.data));
ok(r.data.skipped.some(s => /no product name/i.test(s.reason)) && r.data.skipped.some(s => /total row/i.test(s.reason)), 'each with its own reason', JSON.stringify(r.data.skipped));

console.log('— items: wrong headers → no sheet matched (items has no AI fallback either) —');
r = await post('/parse/items?hid=viraj', sheet([['Nope', 'Nothing']]), 'wrong.xlsx');
ok(r.status === 400 && /no sheet matched/i.test(r.data.error), 'refused with the clear reason', r.data.error);

console.log('— items: a row that PARSES fine can still fail to SAVE — /items/bulk reports why —');
await req('POST', '/items', { hid: 'mithra', name: 'IR Existing Item', nr: 20, mrp: 30 });
r = await req('POST', '/items/bulk', { hid: 'mithra', items: [
  { row: 1, name: 'IR New Item', nr: 15, mrp: 25 },              // creates
  { row: 2, name: 'Bad Price Item', nr: 100, mrp: 50 },           // nr>mrp — parses, fails to save
  { row: 3, name: 'IR Existing Item', nr: 20, mrp: 30 },          // genuine no-op duplicate — nothing to fill
  { row: 4, name: '', nr: 5, mrp: 10 }                            // blank — parses as a "row" but never a real item
] });
ok(r.status === 200, '/items/bulk accepts the full unfiltered set', JSON.stringify(r.data).slice(0, 200));
ok(r.data.created.length === 1 && r.data.created[0].name === 'IR New Item', 'exactly the new item is created', JSON.stringify(r.data.created));
ok(r.data.skipped.length === 3, 'the other three are all accounted for in skipped', JSON.stringify(r.data.skipped));
ok(r.data.skipped.some(s => s.name === 'Bad Price Item' && /positive|exceed/i.test(s.reason)), 'bad price names the reason', JSON.stringify(r.data.skipped));
ok(r.data.skipped.some(s => s.name === 'IR Existing Item' && /nothing new/i.test(s.reason)), 'a harmless duplicate says so, not silently ignored', JSON.stringify(r.data.skipped));
ok(r.data.skipped.some(s => s.row === 4 && /no product name/i.test(s.reason)), 'the blank row is caught too, at the save stage', JSON.stringify(r.data.skipped));
ok(r.data.imported === 1 && r.data.parsed === 4 && r.data.parsed === r.data.imported + r.data.skipped.length, 'the invariant holds through the SAVE stage too', JSON.stringify(r.data));

/* ============================== SALES (gpreport, template branch) ============================== */
console.log('— sales: the invariant, blank name, total row (template path — no AI needed) —');
const SHDR = ['Product name', 'Pack (10s / 15s)', 'Qty sold (strips)', 'Cost price / Net rate (incl. GST)', 'MRP'];
r = await post('/parse/gpreport?hid=viraj', sheet([SHDR,
  ['Sale Item One', '10s', 12, 298, 412],
  ['', '10s', 5, 12, 21],
  ['Total', '', '', '', '']
]), 'sales.xlsx');
ok(r.data.source === 'template', 'read by the template, not AI', r.data.source);
invariant(r.data, 'sales clean+dirty mix');
ok(r.data.fileRows === 3 && r.data.imported === 1 && r.data.skipped.length === 2 && r.data.ignored === 1, 'one real sale, one blank, one total', JSON.stringify(r.data));

console.log('— sales: a zero-qty row is a real skip, not silently zero —');
r = await post('/parse/gpreport?hid=viraj', sheet([SHDR, ['Zero Qty Item', '10s', 0, 10, 20]]), 'zero.xlsx');
invariant(r.data, 'sales zero-qty');
ok(r.data.imported === 0 && r.data.skipped.length === 1 && /no quantity sold/i.test(r.data.skipped[0].reason), 'named, not just missing', JSON.stringify(r.data.skipped));

/* ============================== OPENING (stock, template branch + the SAVE step) ============================== */
console.log('— opening: the invariant, blank name, total row (template path) —');
const OHDR = ['Product name', 'Pack', 'Opening stock (strips)', 'Net rate', 'MRP'];
r = await post('/parse/stock?hid=viraj', sheet([OHDR,
  ['Open Item One', '10s', 100, 20, 30],
  ['', '10s', 50, 10, 15],
  ['Sub Total', '', '', '', '']
]), 'open.xlsx');
ok(r.data.source === 'template', 'read by the template, not AI', r.data.source);
invariant(r.data, 'opening clean+dirty mix');
ok(r.data.fileRows === 3 && r.data.imported === 1 && r.data.skipped.length === 2 && r.data.ignored === 1, 'one real row, one blank, one subtotal', JSON.stringify(r.data));

console.log('— opening: a row that PARSES fine can still fail to SAVE — /items/opening reports why —');
await req('POST', '/items', { hid: 'siri', name: 'IR Opening Existing', nr: 20, mrp: 30 });
r = await req('POST', '/items/opening', { hid: 'siri', stockDate: T, rows: [
  { row: 1, name: 'IR Opening New', qty: 10, nr: 8, mrp: 12 },              // creates fine
  { row: 2, name: 'IR Opening Existing', qty: 5, nr: 999, mrp: 1 },         // would push nr above mrp — save-stage reject
  { row: 3, name: '', qty: 5, nr: 8, mrp: 12 }                             // blank — never even a candidate
] });
ok(r.status === 200, '/items/opening accepts the full set', JSON.stringify(r.data).slice(0, 200));
ok(r.data.created.length === 1 && r.data.created[0].name === 'IR Opening New', 'the good row lands', JSON.stringify(r.data.created));
ok(r.data.skipped.length === 2, 'the other two are accounted for', JSON.stringify(r.data.skipped));
ok(r.data.skipped.some(s => s.name === 'IR Opening Existing' && /exceed|mrp/i.test(s.reason)), 'the price conflict names the reason, the master is left as it was', JSON.stringify(r.data.skipped));
ok(r.data.skipped.some(s => s.row === 3 && /no product name/i.test(s.reason)), 'the blank row is caught too', JSON.stringify(r.data.skipped));
const bootSiri = (await req('GET', '/bootstrap')).data;
ok(bootSiri.items.siri.find(i => i.name === 'IR Opening Existing').nr === 20, 'and its price really was left untouched', bootSiri.items.siri.find(i => i.name === 'IR Opening Existing').nr);

/* ============================== EXPIRY (AI-only preview; the SAVE step is fully testable) ============================== */
console.log('— expiry: /parse/expiry is AI-only (no template, no key in this test env) — the SAVE step (/snapshots) is where the invariant is checked —');
r = await req('POST', '/snapshots', { hid: 'siri', asOf: T, fileName: 'batch.xlsx', rows: [
  { name: 'Batch Item One', batch: 'B100', expiry: '2027-01', qty: 20, nr: 10, mrp: 15 },
  { name: '', batch: 'B200', expiry: '2027-02', qty: 5, nr: 5, mrp: 8 }
] });
ok(r.status === 200, 'the snapshot saves', JSON.stringify(r.data).slice(0, 200));
invariant(r.data, 'expiry snapshot save');
ok(r.data.fileRows === 2 && r.data.imported === 1 && r.data.skipped.length === 1, 'the blank-name batch row is dropped WITH a reason, not silently', JSON.stringify(r.data));
ok(/no product name/i.test(r.data.skipped[0].reason), 'named', r.data.skipped[0].reason);
ok(r.data.snapshot.rows.length === 1, 'and only the real row lands in the snapshot itself', r.data.snapshot.rows.length);

/* ============================== INVOICE ============================== */
console.log('— invoice: 100% AI (PDF/photo), no template — only the guardrails are testable without a live API key —');
r = await req('GET', '/parse/invoice');   // wrong method entirely — proves the route exists and is gated
ok(r.status === 401 || r.status === 404, 'unauthenticated/wrong-method access does not silently succeed', r.status);
const anonFd = new FormData();
anonFd.append('file', new Blob(['not a real file']), 'x.pdf');
const anonRes = await fetch(B + '/parse/invoice?hid=viraj', { method: 'POST', body: anonFd });
ok(anonRes.status === 401, 'the endpoint requires a session', anonRes.status);

/* ============================== PERSISTENCE ============================== */
console.log('— the receipt is persisted, so a drop stays auditable after the dialog closes —');
r = await req('POST', '/import-receipts', { hid: 'siri', kind: 'items', fileName: 'audit-test.xlsx', sheet: 'Item master',
  fileRows: 5, parsed: 5, imported: 3, skipped: [{ row: 2, name: 'X', reason: 'bad price' }, { row: 4, name: 'Y', reason: 'no product name' }], ignored: 0, source: 'template' });
ok(r.status === 200 && r.data.receipt.imported === 3 && r.data.receipt.skipped.length === 2, 'the receipt round-trips', JSON.stringify(r.data));
r = await req('GET', '/import-receipts?hid=siri');
ok(r.status === 200 && r.data.receipts.length >= 1, 'and lists back for that hospital', r.data.receipts.length);
ok(r.data.receipts[0].kind === 'items' && r.data.receipts[0].fileName === 'audit-test.xlsx', 'newest first, with what was uploaded', JSON.stringify(r.data.receipts[0]));
r = await req('GET', '/import-receipts?hid=mithra');
ok(!r.data.receipts.some(x => x.fileName === 'audit-test.xlsx'), 'scoped per hospital — it does not leak into another one', JSON.stringify(r.data.receipts));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
