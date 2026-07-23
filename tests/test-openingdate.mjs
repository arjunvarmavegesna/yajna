/* Tests: the opening-stock count date. It decides which movements land on top
   of the count — a wrong date double-counts or drops real activity — so it
   must never silently inherit an old value, and a past date needs an active
   confirm when real activity already exists on/after it. */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';

const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 200) => new Promise(r => setTimeout(r, ms));
const todayISO = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const T = todayISO();
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }};
}

const adm = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });

console.log('— the server refuses a missing/invalid date rather than defaulting —');
{
  // a hospital whose start_date is deliberately OLD, so a silent fallback would
  // be easy to spot if it happened
  const oldStart = addDays(T, -60);
  const h = (await adm.req('POST', '/hospitals', { name: 'Test Fallback Hosp', startDate: oldStart })).data.hospital;
  ok(h.startDate === oldStart, 'the hospital really does have an old start date on record', h.startDate);

  let r = await adm.req('POST', '/items/opening', { hid: h.id, rows: [{ name: 'X', qty: 5, nr: 10, mrp: 20 }] });
  ok(r.status === 400 && /date is required/i.test(r.data.error), 'no stockDate at all -> 400, not a silent fallback to start_date', r.data.error);

  r = await adm.req('POST', '/items/opening', { hid: h.id, stockDate: 'not-a-date', rows: [{ name: 'X', qty: 5, nr: 10, mrp: 20 }] });
  ok(r.status === 400 && /date is required/i.test(r.data.error), 'a malformed stockDate -> 400 too', r.data.error);

  r = await adm.req('POST', '/items/opening', { hid: h.id, stockDate: addDays(T, 3), rows: [{ name: 'X', qty: 5, nr: 10, mrp: 20 }] });
  ok(r.status === 400 && /future/i.test(r.data.error), 'a future date is still refused');

  const before = (await adm.req('GET', '/bootstrap')).data.hospitals[h.id].stockDate;
  ok(before === null, 'stock_date is still unset — none of the rejected calls wrote anything', before);
}

console.log('— saving with a real date sets "Counted from", and later movements adjust it —');
{
  const h = (await adm.req('POST', '/hospitals', { name: 'Test Real Count Hosp' })).data.hospital;
  const D = addDays(T, -10);
  let r = await adm.req('POST', '/items/opening', { hid: h.id, stockDate: D, rows: [{ name: 'Tab. Count Test', qty: 50, nr: 10, mrp: 20, pack: '10s' }] });
  ok(r.status === 200 && r.data.stockDate === D, 'saved with the chosen date', r.data.stockDate);
  let boot = (await adm.req('GET', '/bootstrap')).data;
  ok(boot.hospitals[h.id].stockDate === D, '"Counted from" reads exactly D', boot.hospitals[h.id].stockDate);

  // a movement dated ON D adjusts the count — the date is inclusive, not exclusive
  const entry = {
    purchases: [], rtv: [], invoices: [],
    sales: { mrp: 0, cogs: 0, cash: 0, credit: 0, cancels: 0 },
    cash: { opening: 0, receipts: 0, payments: 0, actual: '', reason: '' },
    audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [],
    itemSales: [{ item: 'Tab. Count Test', qty: 8, amount: 160, nr: 10, mrp: 20, pack: '10s' }],
  };
  await adm.req('PUT', `/entries/${h.id}/${D}`, { entry });
  boot = (await adm.req('GET', '/bootstrap')).data;
  ok(boot.items[h.id][0].openingQty === 50, 'opening_qty on the master stays the raw count, 50', boot.items[h.id][0].openingQty);
}

console.log('— the movements-after check the modal relies on —');
{
  const h = (await adm.req('POST', '/hospitals', { name: 'Test Movements Hosp' })).data.hospital;
  const past = addDays(T, -5);
  ok((await adm.req('GET', `/items/opening/movements-after?hid=${h.id}&date=${past}`)).data.count === 0, 'nothing entered yet -> zero');

  const entry = {
    purchases: [], rtv: [], invoices: [],
    sales: { mrp: 100, cogs: 60, cash: 100, credit: 0, cancels: 0 },
    cash: { opening: 0, receipts: 0, payments: 0, actual: '', reason: '' },
    audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [], itemSales: [],
  };
  await adm.req('PUT', `/entries/${h.id}/${T}`, { entry });
  await adm.req('PUT', `/entries/${h.id}/${addDays(T, -1)}`, { entry });

  let r = await adm.req('GET', `/items/opening/movements-after?hid=${h.id}&date=${past}`);
  ok(r.data.count === 2, 'both saved days on/after the past date are counted', r.data.count);
  r = await adm.req('GET', `/items/opening/movements-after?hid=${h.id}&date=${T}`);
  ok(r.data.count === 1, 'a later date only counts what is on/after IT', r.data.count);
  r = await adm.req('GET', `/items/opening/movements-after?hid=${h.id}&date=${addDays(T, 1)}`);
  ok(r.data.count === 0, 'a date after everything counts zero');
  ok((await adm.req('GET', `/items/opening/movements-after?hid=${h.id}&date=bad`)).status === 400, 'a bad date is rejected, not treated as zero');

  // a data-entry user has no business here — this is the admin-only opening flow
  const stf = jar();
  await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: process.env.SEED_USER_PW || 'Test@User#1' });
  ok((await stf.req('GET', `/items/opening/movements-after?hid=${h.id}&date=${past}`)).status === 403, 'a data-entry user cannot check it');
}

/* ── DOM: the modal itself ── */
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
let domCookie = '';
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null;
    w.__confirmCalls = [];
    w.confirm = (msg) => { w.__confirmCalls.push(msg); return w.__confirmAnswer !== false; };
    // jsdom's fetch carries no cookie jar of its own — thread the session cookie
    // through by hand, the same way the live-console probes in this repo do
    w.fetch = async (url, opts = {}) => {
      const r = await fetch(new URL(url, 'http://127.0.0.1:3061'), { ...opts, headers: { ...(opts.headers || {}), ...(domCookie ? { cookie: domCookie } : {}) } });
      const sc = r.headers.get('set-cookie'); if (sc) domCookie = sc.split(';')[0];
      return r;
    };
  } });
const w = dom.window, doc = w.document;
await tick(400);
await w.eval(`loginReal('bhagavan@yajnapharma.in', ${JSON.stringify(ADMIN_PW)})`);
await tick(900);

/* Create the hospital through the REAL /hospitals API — the same call
   hospModal makes — so it exists server-side too. A client-only fabricated
   hospital would make every server round-trip in the modal (movements-after,
   the save itself) 400 with "Unknown hospital", silently defeating the very
   checks these tests exist to pin. */
async function mkHospital(name, startDate) {
  return await w.eval(`(async ()=>{
    const r = await api('/hospitals', {method:'POST', body:{name:${JSON.stringify(name)}${startDate ? `, startDate:${JSON.stringify(startDate)}` : ''}}});
    const nh = r.hospital;
    db.hospitals[nh.id] = nh;
    db.dailyData[nh.id]={}; db.vendors[nh.id]=[]; db.payments[nh.id]=[]; db.hvTracked[nh.id]=[]; db.reportPrefs[nh.id]={};
    db.items[nh.id]=[]; db.adjustments[nh.id]=[]; db.offers[nh.id]=[]; db.offerActions[nh.id]=[]; db.pendingItems[nh.id]=[]; db.aliases[nh.id]=[];
    db.receivables[nh.id]=[]; db.recvActions[nh.id]=[]; db.snapshots[nh.id]=[]; db.periodData[nh.id]={weekly:{},monthly:{}};
    return nh.id;
  })()`);
}

console.log('— the modal defaults to TODAY, never to the hospital start date —');
{
  const oldStart = addDays(T, -90);
  const hid = await mkHospital('DOM Test Hosp', oldStart);
  w.eval(`openingStockModal(${JSON.stringify(hid)})`); await tick(300);
  ok(doc.querySelector('#osDate').value === T, 'the date field is defaulted to today, not to the 90-day-old start date', doc.querySelector('#osDate').value);
  ok(/Everything entered on or after this date/.test(doc.querySelector('.modal-body').textContent), 'and the consequence is spelled out beside the field');
  w.eval('closeModal()'); await tick(150);
}

console.log('— a past date with existing activity triggers the confirm —');
{
  const hid = await mkHospital('DOM Movements Hosp');
  // a REAL saved day, through the real save path, so the server-side check has
  // something genuine to find
  await adm.req('PUT', `/entries/${hid}/${T}`, { entry: {
    purchases: [], rtv: [], invoices: [], sales: { mrp: 50, cogs: 30, cash: 50, credit: 0, cancels: 0 },
    cash: { opening: 0, receipts: 0, payments: 0, actual: '', reason: '' },
    audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [], itemSales: [] } });

  w.eval(`openingStockModal(${JSON.stringify(hid)})`); await tick(300);
  w.eval(`$('#osPaste').value = 'Tab. Confirm Test,10,5,8,10s'; $('#osRead').click()`); await tick(300);
  const past = addDays(T, -3);
  const dateInp = doc.querySelector('#osDate');
  dateInp.value = past; dateInp.dispatchEvent(new w.Event('change'));
  await tick(250);
  ok(new RegExp(w.eval(`fmtDateShort(${JSON.stringify(past)})`)).test(doc.querySelector('#osPrev').textContent), 'the preview re-reads the corrected date on change');

  w.__confirmAnswer = false;   // decline the confirm — nothing should be saved
  const beforeSD = w.eval(`db.hospitals[${JSON.stringify(hid)}].stockDate`);
  await w.eval(`$('#osGo').click()`);
  await tick(400);
  ok(w.__confirmCalls.length === 1, 'a blocking confirm fired before saving', w.__confirmCalls.length);
  ok(/1 day of movements already exist/.test(w.__confirmCalls[0]), 'naming the count and the date', w.__confirmCalls[0]);
  ok(/before that activity/.test(w.__confirmCalls[0]), 'and asking for an active confirmation, not a passive OK');
  ok(w.eval(`db.hospitals[${JSON.stringify(hid)}].stockDate`) === beforeSD, 'declining the confirm saves nothing', w.eval(`db.hospitals[${JSON.stringify(hid)}].stockDate`));

  w.__confirmAnswer = true; w.__confirmCalls.length = 0;
  await w.eval(`$('#osGo').click()`);
  await tick(500);
  ok(w.__confirmCalls.length === 1, 'confirming proceeds with exactly one prompt');
  ok(w.eval(`db.hospitals[${JSON.stringify(hid)}].stockDate`) === past, 'and the count now saves with the confirmed date', w.eval(`db.hospitals[${JSON.stringify(hid)}].stockDate`));
}

console.log('— a future-dated hospital or a same-day count never prompts at all —');
{
  const hid = await mkHospital('DOM No Prompt Hosp');
  w.eval(`openingStockModal(${JSON.stringify(hid)})`); await tick(300);
  w.eval(`$('#osPaste').value = 'Tab. Today Test,10,5,8,10s'; $('#osRead').click()`); await tick(300);
  w.__confirmCalls.length = 0;
  await w.eval(`$('#osGo').click()`);
  await tick(400);
  ok(w.__confirmCalls.length === 0, 'counting AS OF TODAY never needs a confirm, even with a fresh hospital', w.__confirmCalls.length);
  ok(w.eval(`db.hospitals[${JSON.stringify(hid)}].stockDate`) === T, 'and it saved straight through');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
