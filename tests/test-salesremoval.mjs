/* Tests: removing a day's sales. Uploading a corrected file already replaces
   the old one cleanly (see test-salesimpact.mjs) — the actual gap is that
   there was no way to clear a day's sales and leave it empty, and no
   guarantee the top-of-tab totals (MRP, COGS) stayed in step with the item
   rows underneath them. This suite proves:
   - MRP/COGS are DERIVED from the item rows when rows are present, so a file
     that carries new rows but a stale/wrong header total cannot leave the two
     disagreeing (the actual bug: a 30-item corrected file landing while an
     old 43-item COGS figure stays sitting in the box).
   - A day already carrying sales warns, before a new upload, that it will be
     REPLACED, not added to.
   - Remove clears rows + totals together, stock corrects itself (re-derived,
     nothing cached), and it is blocked by the same past-day lock rule as any
     other edit.
   - Every removal is written down: who, when, how much, from what file —
     queryable per hospital, newest first — because a margin figure that
     changes after a correction has to be provable, not just asserted. */
import { JSDOM } from 'jsdom';
import fs from 'fs';

const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const USER_PW = process.env.SEED_USER_PW || 'Test@User#1';
const B = 'http://127.0.0.1:3061/api';

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));
const todayISO = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const T = todayISO();

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }};
}

const salesDay = (itemName, over = {}) => ({
  purchases: [], rtv: [], invoices: [], hv: [],
  audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, cash: {},
  sales: { mrp: 600, cogs: 300, cash: 400, credit: 200, cancels: 1, fileName: 'viraj-sales.xlsx' },
  itemSales: [
    { item: itemName, qty: 10, amount: 200, pack: '10s', nr: 10, mrp: 20, cost: 100 },
    { item: itemName + ' B', qty: 10, amount: 200, pack: '10s', nr: 10, mrp: 20, cost: 100 },
    { item: itemName + ' C', qty: 10, amount: 200, pack: '10s', nr: 10, mrp: 20, cost: 100 }
  ],
  ...over
});

console.log('— fileName rides through cleanEntry, unstripped —');
{
  const adm = jar();
  await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
  const d = addDays(T, -1);
  const put = await adm.req('PUT', `/entries/viraj/${d}`, { entry: salesDay('Tab. Removal Fixture') });
  ok(put.status === 200, 'the day saves', JSON.stringify(put.data));
  const boot = await adm.req('GET', '/bootstrap');
  const e = boot.data.dailyData.viraj[d];
  ok(e.sales.fileName === 'viraj-sales.xlsx', 'fileName is not a recognized-and-dropped key — it comes back exactly as sent', e.sales.fileName);
  ok(e.itemSales.length === 3, 'the three item rows came back too', e.itemSales.length);
}

console.log('— remove-sales clears rows + MRP/COGS + fileName, leaves cash/credit/cancels untouched —');
let removedDate, removalRecord;
{
  const adm = jar();
  await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
  removedDate = addDays(T, -2);
  await adm.req('PUT', `/entries/viraj/${removedDate}`, { entry: salesDay('Tab. Removal Main') });
  const r = await adm.req('POST', `/entries/viraj/${removedDate}/remove-sales`);
  ok(r.status === 200, 'the removal succeeds', JSON.stringify(r.data));
  removalRecord = r.data.removal;
  ok(removalRecord.itemsCount === 3 && removalRecord.stripsCount === 30 && removalRecord.costValue === 300 && removalRecord.mrpValue === 600,
    'the removal record carries the EXACT numbers that were on the day — itemsCount 3, strips 30, cost 300, mrp 600', JSON.stringify(removalRecord));
  ok(removalRecord.fileName === 'viraj-sales.xlsx', 'and the filename that was there before removal', removalRecord.fileName);
  ok(removalRecord.removedBy === 'Bhagavan', 'and who did it', removalRecord.removedBy);

  const boot = await adm.req('GET', '/bootstrap');
  const e = boot.data.dailyData.viraj[removedDate];
  ok(e.itemSales.length === 0, 'item rows are gone', e.itemSales.length);
  ok(e.sales.mrp === 0 && e.sales.cogs === 0, 'MRP and COGS are zeroed — the two totals the bug was about', JSON.stringify(e.sales));
  ok(e.sales.fileName === '', 'fileName is cleared too — nothing claims a file is still loaded', e.sales.fileName);
  ok(e.sales.cash === 400 && e.sales.credit === 200 && e.sales.cancels === 1, 'cash / credit / cancellations are manual entries, untouched by removing the FILE-derived totals', JSON.stringify(e.sales));
}

console.log('— nothing to remove twice, and no entry means no removal —');
{
  const adm = jar();
  await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
  const again = await adm.req('POST', `/entries/viraj/${removedDate}/remove-sales`);
  ok(again.status === 400, 'removing an already-empty day is refused, not a silent no-op success', JSON.stringify(again.data));

  const neverSaved = addDays(T, -40);
  const none = await adm.req('POST', `/entries/viraj/${neverSaved}/remove-sales`);
  ok(none.status === 404, 'a day with no entry at all is 404, not 400 — a different, correctly-named failure', JSON.stringify(none.data));
}

console.log('— the removal is written down, queryable per hospital, newest first —');
{
  const adm = jar();
  await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
  const d2 = addDays(T, -3);
  await adm.req('PUT', `/entries/viraj/${d2}`, { entry: salesDay('Tab. Removal Second') });
  await adm.req('POST', `/entries/viraj/${d2}/remove-sales`);

  const list = await adm.req('GET', '/sales-removals?hid=viraj');
  ok(list.status === 200 && list.data.removals.length === 2, 'both removals for this hospital are listed', list.data.removals?.length);
  ok(list.data.removals[0].date === d2, 'newest removal first', JSON.stringify(list.data.removals.map(r => r.date)));
  ok(list.data.removals[1].date === removedDate, 'and the earlier one still there, in order', JSON.stringify(list.data.removals.map(r => r.date)));
}

console.log('— locked exactly like any other past-day edit: admin can, a data-entry user cannot, except on today —');
{
  const adm = jar();
  await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
  const pastMithra = addDays(T, -1);
  await adm.req('PUT', `/entries/mithra/${pastMithra}`, { entry: salesDay('Tab. Mithra Lock Test') });

  const usr = jar();
  const login = await usr.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });
  ok(login.status === 200, 'the data-entry user logs in', JSON.stringify(login.data));

  const blocked = await usr.req('POST', `/entries/mithra/${pastMithra}/remove-sales`);
  ok(blocked.status === 403, 'a non-admin cannot remove a PAST day\'s sales', JSON.stringify(blocked.data));

  // today's own entry: a data-entry user may both create and remove it
  await usr.req('PUT', `/entries/mithra/${T}`, { entry: salesDay('Tab. Mithra Today Test') });
  const allowed = await usr.req('POST', `/entries/mithra/${T}/remove-sales`);
  ok(allowed.status === 200, 'but TODAY\'s own entry, the same user may remove', JSON.stringify(allowed.data));
  ok(allowed.data.removal.removedBy === 'Lakshmi D', 'and the record names the actual data-entry user, not an admin', allowed.data.removal.removedBy);
}

console.log('— against the real server: removing a day\'s sales actually gives the stock back —');
{
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  let domCookie = '';
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null; w.confirm = () => true;
      w.fetch = async (url, opts = {}) => {
        const r = await fetch(new URL(url, 'http://127.0.0.1:3061'), { ...opts, headers: { ...(opts.headers || {}), ...(domCookie ? { cookie: domCookie } : {}) } });
        const sc = r.headers.get('set-cookie'); if (sc) domCookie = sc.split(';')[0];
        return r;
      }; } });
  const w = dom.window, doc = w.document;
  await tick(400);
  doc.querySelector('#loginEmail').value = 'bhagavan@yajnapharma.in';
  doc.querySelector('#loginPw').value = ADMIN_PW;
  doc.querySelector('#loginBtn').click(); await tick(900);

  const req = async (m, p, b) => {
    const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(domCookie ? { cookie: domCookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) domCookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  const openDate = addDays(T, -20), saleDate = addDays(T, -1);
  await req('POST', '/items/opening', { hid: 'viraj', stockDate: openDate, rows: [{ name: 'Tab. Stock Revert Test', qty: 100, nr: 10, mrp: 20, pack: '10s' }] });
  await req('PUT', `/entries/viraj/${saleDate}`, { entry: {
    purchases: [], rtv: [], invoices: [], hv: [], cash: {}, audit: { opening: 0, actual: '', unbilled: false, bounces: [] },
    sales: { mrp: 400, cogs: 200, cash: 400, credit: 0, cancels: 0, fileName: 'revert-test.xlsx' },
    itemSales: [{ item: 'Tab. Stock Revert Test', qty: 20, amount: 400, pack: '10s', nr: 10, mrp: 20, cost: 200 }]
  } });

  const loadStock = async () => {
    const boot = (await req('GET', '/bootstrap')).data;
    w.eval(`
      db.items.viraj = ${JSON.stringify(boot.items.viraj)};
      db.hospitals.viraj = ${JSON.stringify(boot.hospitals.viraj)};
      db.dailyData.viraj = ${JSON.stringify(boot.dailyData.viraj)};
      db.adjustments.viraj = ${JSON.stringify(boot.adjustments.viraj || [])};
    `);
    return w.eval(`stockAsOf('viraj', todayISO()).items.find(i=>i.key===nameKey('Tab. Stock Revert Test')).stock`);
  };

  const afterSale = await loadStock();
  ok(afterSale === 80, '100 opening − 20 sold = 80, before any removal', afterSale);

  await req('POST', `/entries/viraj/${saleDate}/remove-sales`);
  const afterRemove = await loadStock();
  ok(afterRemove === 100, 'removing the sale gives the 20 back — 100 again, with nothing else to do', afterRemove);
}

console.log('— the UI: totals derive from rows (cannot disagree), an overwrite warning, and a Remove button that works —');
{
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // a REAL logged-in session, not the demo quick-login — the Remove button's
  // click handler makes a genuine network call, and a demo/401-stubbed fetch
  // would trip the 401->hardLogout path the moment ANY background call (e.g.
  // saveImportReceipt) hits it, wiping state.user out from under the test
  let domCookie = '';
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null; w.confirm = () => true;
      w.fetch = async (url, opts = {}) => {
        const r = await fetch(new URL(url, 'http://127.0.0.1:3061'), { ...opts, headers: { ...(opts.headers || {}), ...(domCookie ? { cookie: domCookie } : {}) } });
        const sc = r.headers.get('set-cookie'); if (sc) domCookie = sc.split(';')[0];
        return r;
      }; } });
  const w = dom.window, doc = w.document;
  await tick(400);
  doc.querySelector('#loginEmail').value = 'bhagavan@yajnapharma.in';
  doc.querySelector('#loginPw').value = ADMIN_PW;
  doc.querySelector('#loginBtn').click(); await tick(900);
  doc.querySelector('[data-open2="viraj"]').click(); await tick(250);
  w.eval(`state.date=todayISO(); state.entryTab=1; state.entryMode="daily"; renderHospitalWorkspace();`); await tick(200);

  // seed a STALE state exactly like the bug: an old, larger set of rows and an
  // old COGS figure that must NOT survive into the new totals
  w.eval(`
    const e = getDraft();
    e.itemSales = [
      {item:'Old Row A', qty:5, amount:100, pack:'10s', nr:10, mrp:20, cost:50},
      {item:'Old Row B', qty:5, amount:100, pack:'10s', nr:10, mrp:20, cost:50}
    ];
    e.sales.mrp = 9999; e.sales.cogs = 8888; e.sales.fileName = 'old-file.xlsx';
    renderEntry();
  `);
  let body = doc.querySelector('#entryBody').textContent;
  ok(/2 rows loaded/.test(body) && /old-file\.xlsx/.test(body), 'the stale upload shows what is actually loaded, by name', body.slice(0, 300));
  ok(doc.querySelector('[data-s="mrp"]').disabled, 'MRP is read-only while rows are loaded — it is derived, not independently editable', null);
  ok(doc.querySelector('[data-s="cogs"]').disabled, 'so is COGS, for the same reason', null);

  doc.querySelector('#gpBtn').click(); await tick(200);
  const openBody = doc.querySelector('.modal').textContent;
  ok(/already has 2 rows loaded/.test(openBody) && /old-file\.xlsx/.test(openBody), 'opening the upload modal on a loaded day warns before any file is even chosen', openBody.slice(0, 300));
  ok(/replace them, not add to them/i.test(openBody), 'and says plainly that a new upload replaces rather than adds');

  // a corrected file: fewer rows, and a header COGS that is DELIBERATELY WRONG —
  // proves the totals come from the rows themselves, not the file's own header
  w.eval(`
    window.__realApiUpload = apiUpload;
    window.apiUpload = async () => ({
      source:'template', sheet:'Sales', salesMrp: 888888, cogs: 999999, cash:0, credit:0,
      tabletsCol:true, fileName:'corrected-30.xlsx', fileRows:2, parsed:2, imported:2, skipped:[], ignored:0, cautions:[],
      note:'Read 2 rows',
      items:[
        {row:1, item:'New Row X', pack:'10s', qty:10, nr:10, mrp:20, unit:'strips', srcStrips:10, srcLoose:0, amount:200, cost:100, marginPct:50},
        {row:2, item:'New Row Y', pack:'10s', qty:15, nr:10, mrp:20, unit:'strips', srcStrips:15, srcLoose:0, amount:300, cost:150, marginPct:50}
      ]
    });
  `);
  const fakeFile = new w.File(['dummy'], 'corrected-30.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  Object.defineProperty(doc.querySelector('#gpFile'), 'files', { value: [fakeFile], configurable: true });
  doc.querySelector('#gpParse').click(); await tick(300);
  doc.querySelector('#gpApply').click(); await tick(200);
  doc.querySelector('#gpContinue')?.click(); await tick(200);

  const draft = w.eval(`JSON.parse(JSON.stringify(getDraft()))`);
  ok(draft.itemSales.length === 2 && draft.itemSales.every(r => r.item.startsWith('New Row')), 'the OLD rows are gone entirely, replaced by the new file\'s rows', JSON.stringify(draft.itemSales.map(r => r.item)));
  ok(draft.sales.cogs === 250, 'COGS is the SUM OF THE ROWS (100+150=250) — not the stale 8888, and not the file header\'s wrong 999999', draft.sales.cogs);
  ok(draft.sales.mrp === 500, 'same for MRP: sum of the rows (200+300=500), not the stale 9999 or the header\'s wrong 888888', draft.sales.mrp);
  ok(draft.sales.fileName === 'corrected-30.xlsx', 'and the new filename is on record', draft.sales.fileName);
  w.eval(`window.apiUpload = window.__realApiUpload;`);

  // persist for real, exactly as a user would before coming back to remove it
  doc.querySelector('#saveBtn').click(); await tick(800);
  const savedDate = w.eval('state.date');
  const bootAfterSave = await (await fetch(`${B}/bootstrap`, { headers: { cookie: domCookie } })).json();
  const savedEntry = bootAfterSave.dailyData.viraj[savedDate];
  ok(savedEntry && savedEntry.itemSales.length === 2 && savedEntry.sales.cogs === 250, 'the corrected upload is genuinely persisted on the server before removal is tested', JSON.stringify(savedEntry?.sales));

  console.log('— Remove: shows what comes back before it happens, then actually clears both rows and totals, on the server too —');
  body = doc.querySelector('#entryBody').textContent;
  ok(/2 rows loaded/.test(body) && /corrected-30\.xlsx/.test(body), 'the tab now shows the NEW file, not the old one', body.slice(0, 300));
  doc.querySelector('#gpRemoveBtn').click(); await tick(200);
  const confirmBody = doc.querySelector('.modal').textContent;
  ok(/This will return/.test(confirmBody) && /250/.test(confirmBody) && /2 item/.test(confirmBody), 'the confirm dialog states the reverse of the upload preview — what comes back, before it happens', confirmBody.slice(0, 300));
  doc.querySelector('#gpRemoveConfirm').click(); await tick(700);
  ok(!doc.querySelector('.modal'), 'the modal closes on completion');
  const afterRemoveDraft = w.eval(`JSON.parse(JSON.stringify(getDraft()))`);
  ok(afterRemoveDraft.itemSales.length === 0, 'rows are gone from the local draft', afterRemoveDraft.itemSales.length);
  ok(afterRemoveDraft.sales.mrp === 0 && afterRemoveDraft.sales.cogs === 0 && afterRemoveDraft.sales.fileName === '', 'and both totals are cleared with them, atomically', JSON.stringify(afterRemoveDraft.sales));
  body = doc.querySelector('#entryBody').textContent;
  ok(!/rows loaded/.test(body), 'and the tab no longer claims any file is loaded');
  ok(!doc.querySelector('#gpRemoveBtn'), 'no Remove button left to click — nothing left to remove');

  const bootAfterRemove = await (await fetch(`${B}/bootstrap`, { headers: { cookie: domCookie } })).json();
  const removedEntry = bootAfterRemove.dailyData.viraj[savedDate];
  ok(removedEntry.itemSales.length === 0 && removedEntry.sales.cogs === 0 && removedEntry.sales.mrp === 0, 'the REAL click, through the REAL button, against the REAL server, actually cleared it — not just the in-memory draft', JSON.stringify(removedEntry.sales));

  const removalsList = await (await fetch(`${B}/sales-removals?hid=viraj`, { headers: { cookie: domCookie } })).json();
  ok(removalsList.removals.some(r => r.date === savedDate && r.itemsCount === 2 && r.costValue === 250), 'and that click left its own record in the removals log, same as the raw-HTTP removal did earlier', JSON.stringify(removalsList.removals.find(r => r.date === savedDate)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
