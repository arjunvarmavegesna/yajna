/* Tests: reorder planning — the reorder level IS the consumption.
   API (preferred vendor round-trip) + DOM (demo mode, deterministic maths). */
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

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }};
}

/* ── API: the preferred vendor is an item field, not a price ── */
const adm = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
let r = await adm.req('POST', '/items', { hid: 'viraj', name: 'Tab. Reorder Test', pack: '10s', nr: 10, mrp: 20 });
const itemId = r.data.item.id;
ok(r.data.item.preferredVendor === '', 'a new item has no preferred vendor');
r = await adm.req('PATCH', '/items/' + itemId, { preferredVendor: 'Zydus Healthcare' });
ok(r.status === 200 && r.data.item.preferredVendor === 'Zydus Healthcare', 'setting the preferred vendor is a plain edit — it moves no money', JSON.stringify(r.data));
r = await adm.req('PATCH', '/items/' + itemId, { preferredVendor: '' });
ok(r.status === 200 && r.data.item.preferredVendor === '', 'and clearing it falls back to the last-bought vendor');
ok((await adm.req('GET', '/bootstrap')).data.items.viraj.some(i => i.preferredVendor !== undefined), 'bootstrap carries the field');

/* ── DOM: deterministic consumption in demo mode ── */
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null;
    let clip = ''; w.navigator.clipboard = { writeText: async (t) => { clip = t; }, readText: async () => clip };
    w.__clip = () => clip;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const w = dom.window, doc = w.document;
await tick(400);
doc.querySelector('[data-quick="admin"]').click(); await tick(700);

/* Overwrite one hospital's world with a hand-built, fully deterministic one:
   one item, known opening stock, known sales — so every number below is arithmetic,
   not a fixture accident. */
w.eval(`
  const hid = 'viraj', T = todayISO();
  db.items[hid] = [{id:'ro1', name:'Tab. Rifaximin 550', key:nameKey('Tab. Rifaximin 550'), pack:'10s',
    nr:300, mrp:400, openingQty:100, preferredVendor:'', source:'demo', updatedAt:Date.now()}];
  db.hospitals[hid].stockDate = addDays(T, -9);          // counted 10 days ago
  db.adjustments[hid] = [];
  db.dailyData[hid] = {};
  // 10 days in the window: sold 4 strips/day for the last 10 days = rate 4/day
  for(let i=0;i<10;i++){
    const d = addDays(T, -i);
    db.dailyData[hid][d] = { savedAt: Date.now(), purchases: [], rtv: [], invoices: [],
      sales:{mrp:1600,cogs:1200,cash:1600,credit:0,cancels:0},
      cash:{opening:0,receipts:0,payments:0,actual:'',reason:''},
      itemSales:[{item:'Tab. Rifaximin 550', qty:4, amount:1600, nr:300, mrp:400, pack:'10s'}],
      audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[] };
  }
  // one purchase 5 days ago: 20 strips from Med Plus Agencies — the LAST vendor
  db.dailyData[hid][addDays(T,-5)].invoices = [{id:'inv1', vendor:'Med Plus Agencies', invoiceNo:'MP-1', date:addDays(T,-5),
    lines:[{item:'Tab. Rifaximin 550', pqty:20, oqty:0, rate:280, disc:0, gst:0, mrp:400}]}];
  db.vendors[hid] = [{id:'v1', name:'Med Plus Agencies', creditDays:30, openingBal:0, phone:'+91 90909 80808', addedOn:T}];
  openHospital(hid, 'inventory');
`);
await tick(500);

console.log('— the Reorder view —');
const seg = [...doc.querySelectorAll('[data-invm]')].map(b => b.dataset.invm);
ok(seg.includes('reorder'), 'Inventory has a Reorder mode', seg.join(','));
doc.querySelector('[data-invm="reorder"]').click(); await tick(400);
const txt = () => doc.querySelector('#invBody').textContent;
ok(/Use \/ day/.test(txt()) && /Suggest order/.test(txt()), 'the reorder table renders');

console.log('— the maths is arithmetic, not opinion —');
// on hand = 100 opening + 20 bought − 40 sold = 80; rate = 40/10 = 4/day
const R = w.eval('JSON.parse(JSON.stringify(reorderData("viraj", 15).rows.find(r=>r.key===nameKey("Tab. Rifaximin 550"))))');
ok(R.onHand === 80, 'on hand = opening + purchases − sales = 80', R.onHand);
ok(Math.abs(R.rate - 4) < 0.01, 'use per day = strips sold ÷ window days = 4', R.rate);
ok(Math.abs(R.daysLeft - 20) < 0.1, 'days left = on hand ÷ rate = 20', R.daysLeft);
ok(R.need === 60, '15-day need = rate × 15 = 60', R.need);
ok(R.suggest === 0, 'suggest = need − on hand → nothing needed for 15 days', R.suggest);
const R30 = w.eval('JSON.parse(JSON.stringify(reorderData("viraj", 30).rows[0]))');
ok(R30.need === 120 && R30.suggest === 40, '30-day cover: need 120, so order 40', `${R30.need}/${R30.suggest}`);
const R45 = w.eval('JSON.parse(JSON.stringify(reorderData("viraj", 45).rows[0]))');
ok(R45.suggest === 100, 'custom 45 days: 180 − 80 = 100', R45.suggest);
ok(R.orderValue === 0 && R30.orderValue === 40 * 300, 'the order is valued at the master net rate', R30.orderValue);

console.log('— the vendor column —');
ok(R.lastVendor && R.lastVendor.name === 'Med Plus Agencies', 'the last-procured vendor comes from the actual invoice', JSON.stringify(R.lastVendor));
ok(R.lastVendor.nr === 280, 'with the rate it was last bought at', R.lastVendor.nr);
ok(R.vendorName === 'Med Plus Agencies', 'with no preference set, the last vendor IS the vendor');
ok(R.vendorMeta && R.vendorMeta.phone === '+91 90909 80808', 'and their phone rides along from the vendor book', JSON.stringify(R.vendorMeta));

console.log('— switching the vendor —');
w.eval('invState().cover = 30; invState().roNeedOnly = true; renderInventory()'); await tick(300);
ok([...doc.querySelectorAll('[data-rovend]')].length === 1, 'the row offers Set vendor');
doc.querySelector('[data-rovend]').click(); await tick(250);
ok(!!doc.querySelector('#rvName'), 'the vendor dialog opens');
w.eval('$("#rvName").value = "Zydus Healthcare"; $("#rvGo").click()'); await tick(300);
const R2 = w.eval('JSON.parse(JSON.stringify(reorderData("viraj", 30).rows[0]))');
ok(R2.preferred === 'Zydus Healthcare' && R2.vendorName === 'Zydus Healthcare', 'the preference now leads', JSON.stringify({ p: R2.preferred, v: R2.vendorName }));
ok(R2.lastVendor.name === 'Med Plus Agencies', 'but who it was LAST bought from is not rewritten — a switch stays visible');
ok(/preferred/.test(doc.querySelector('#invBody').textContent), 'and the table marks the preference');
// clearing goes back
doc.querySelector('[data-rovend]').click(); await tick(250);
w.eval('$("#rvClear").click()'); await tick(300);
ok(w.eval('reorderData("viraj", 30).rows[0].vendorName') === 'Med Plus Agencies', 'clearing the preference falls back to the last vendor');

console.log('— cover controls and filters —');
ok(!!doc.querySelector('[data-rocov="15"]') && !!doc.querySelector('[data-rocov="30"]') && !!doc.querySelector('[data-rocov="custom"]'), '15 / 30 / custom cover choices');
doc.querySelector('[data-rocov="custom"]').click(); await tick(300);
ok(!!doc.querySelector('#roDays'), 'custom opens a days input');
w.eval('$("#roDays").value = "45"; $("#roDays").onchange()'); await tick(300);
ok(/Need \(45d\)/.test(doc.querySelector('#invBody').textContent), 'the table re-plans for the entered days');
doc.querySelector('[data-rocov="15"]').click(); await tick(300);
ok(/Nothing needs ordering/.test(doc.querySelector('#invBody').textContent), 'at 15 days the shelf covers it and the filtered view says so');
w.eval('$("#roNeed").checked = false; $("#roNeed").onchange({target:{checked:false}})'); await tick(300);
ok([...doc.querySelectorAll('#invBody tbody tr')].length === 1, 'untick the filter and everything shows');

console.log('— the order list is WhatsApp-ready —');
w.eval('invState().cover = 30; renderInventory()'); await tick(300);
doc.querySelector('#roCopy').click(); await tick(200);
const clip = w.eval('__clip()');
ok(/Order list/.test(clip) && /Med Plus Agencies/.test(clip), 'the copied list is grouped by vendor', clip.slice(0, 60));
ok(/Tab\. Rifaximin 550 \(10s\) — 40 strips/.test(clip), 'with the exact suggested strips', clip);

console.log('— a data-entry user never sees any of it —');
w.eval('state.user = {...state.user, role:"user"}; openHospital("viraj", "inventory")'); await tick(300);
ok(w.eval('state.hospTab') === 'entry', 'the inventory tab itself is admin-only, reorder included — a user is bounced to entry', w.eval('state.hospTab'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
