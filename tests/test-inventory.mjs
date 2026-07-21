/* Tests: inventory tab — opening stock, auto-adjust from purchases/sales/RTV, ledger */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const USER_PW = process.env.SEED_USER_PW || 'Test@User#1';

const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 90) => new Promise(r => setTimeout(r, ms));

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }};
}
const todayIST = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const T = todayIST(), D1 = addD(T, -3), D0 = addD(T, -5), BEFORE = addD(T, -9);

const adm = jar(), stf = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });

console.log('— opening stock API —');
let r = await stf.req('POST', '/items/opening', { hid: 'mithra', stockDate: D0, rows: [{ name: 'X', qty: 1 }] });
ok(r.status === 403, 'staff cannot set opening stock');
r = await adm.req('POST', '/items/opening', { hid: 'mithra', stockDate: addD(T, 3), rows: [] });
ok(r.status === 400 && /future/i.test(r.data.error), 'future stock date rejected', r.data.error);
r = await adm.req('POST', '/items/opening', { hid: 'siri', stockDate: D0, rows: [{ name: 'Q', qty: 5, nr: 10, mrp: 20 }] });
ok(r.status === 200, 'opening stock accepted for another hospital');
r = await adm.req('POST', '/items/opening', { hid: 'mithra', stockDate: D0, rows: [
  { name: 'Tab. Pantoprazole 40', qty: 100, nr: 38, mrp: 58, pack: '10s' },
  { name: 'Inj. Ceftriaxone 1g', qty: 40, nr: 42, mrp: 66, pack: 'vial' },
  { name: 'Syp. Lactulose 200ml', qty: 12, nr: 118, mrp: 172 },
  { name: '', qty: 9 },                        // blank -> skipped
  { name: 'Bad Price', qty: 5, nr: 90, mrp: 50 } // nr>mrp -> skipped
]});
ok(r.status === 200 && r.data.created.length === 3, 'opening stock created 3 items (blank + bad price skipped)', r.data.created.length);
ok(r.data.stockDate === D0 && r.data.hospital.stockDate === D0, 'stock date recorded on the hospital');

let boot = (await adm.req('GET', '/bootstrap')).data;
const pan = boot.items.mithra.find(i => i.key === 'tab. pantoprazole 40');
ok(pan && pan.openingQty === 100 && pan.nr === 38, 'openingQty + prices in bootstrap', JSON.stringify(pan && { q: pan.openingQty, nr: pan.nr }));
ok(boot.hospitals.mithra.stockDate === D0, 'hospital carries stockDate');

// re-run opening: updates qty on existing, keeps prices when file omits them
r = await adm.req('POST', '/items/opening', { hid: 'mithra', stockDate: D0, rows: [{ name: 'tab. PANTOPRAZOLE 40', qty: 150 }] });
ok(r.status === 200 && r.data.updated.length === 1 && r.data.updated[0].openingQty === 150 && r.data.updated[0].nr === 38,
   'existing item: qty updated, price preserved', JSON.stringify(r.data.updated[0]));

console.log('— movements feed inventory —');
// a day BEFORE the count must not affect stock
r = await adm.req('PUT', `/entries/mithra/${BEFORE}`, { entry: {
  purchases: [], rtv: [], sales: {}, audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [],
  invoices: [{ vendor: 'V', invoiceNo: 'OLD', date: BEFORE, fileName: '', lines: [{ item: 'Tab. Pantoprazole 40', qty: 999, nr: 38, mrp: 58, value: 1 }] }]
}});
ok(r.status === 200, 'pre-count day saved');
// purchase in
r = await adm.req('PUT', `/entries/mithra/${D1}`, { entry: {
  purchases: [], rtv: [{ drug: 'Inj. Ceftriaxone 1g', vendor: 'V', qty: 5, value: 210, reason: 'Expiry', status: 'Pending' }],
  sales: {}, audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [],
  invoices: [{ vendor: 'V', invoiceNo: 'IN-1', date: D1, fileName: '', lines: [{ item: 'Tab. Pantoprazole 40', qty: 50, nr: 38, mrp: 58, value: 1900 }] }],
  itemSales: [{ item: 'Tab. Pantoprazole 40', qty: 30, amount: 1740 }]
}});
ok(r.status === 200, 'movement day saved');
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.dailyData.mithra[D1].rtv[0].qty === 5, 'RTV qty persists');

console.log('— DOM: inventory tab (live) —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const mk = () => { let cookie = '';
  return new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {}; w.confirm = () => true;
      w.fetch = async (url, opts = {}) => { const res = await fetch(new URL(url, 'http://127.0.0.1:3061'), { method: opts.method || 'GET', headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) }, body: opts.body });
        const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return res; }; } }); };
const dom = mk(), doc = dom.window.document, w = dom.window;
const click = s => { const el = doc.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); };
const setV = (s, v) => { const el = doc.querySelector(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const content = () => doc.querySelector('#content').textContent;
await tick(300);
setV('#loginEmail', 'bhagavan@yajnapharma.in');
doc.querySelector('#loginPw').value = ADMIN_PW;
click('#loginBtn'); await tick(600);
[...doc.querySelectorAll('[data-open2]')].find(b => b.dataset.open2 === 'mithra').click(); await tick(200);
ok([...doc.querySelectorAll('[data-htab]')].some(b => b.dataset.htab === 'inventory'), 'Inventory is a hospital tab');
[...doc.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === 'inventory').click(); await tick(250);

// stock math: opening 150 + 50 purchased - 30 sold = 170 (the 999 pre-count purchase is ignored)
const invOf = k => w.eval(`JSON.stringify(inventoryFor('mithra').find(i=>i.key===${JSON.stringify(k)}))`);
const p = JSON.parse(invOf('tab. pantoprazole 40'));
ok(p.opening === 150 && p.purchased === 50 && p.sold === 30 && p.stock === 170,
   'stock = opening + purchases − sales, ignoring pre-count movements', JSON.stringify({ o: p.opening, pu: p.purchased, so: p.sold, st: p.stock }));
ok(p.value === 170 * 38, 'stock value uses NR', p.value);
const c = JSON.parse(invOf('inj. ceftriaxone 1g'));
ok(c.rtv === 5 && c.stock === 35, 'RTV reduces stock (40 − 5)', JSON.stringify({ rtv: c.rtv, st: c.stock }));
ok(content().includes('Counted from'), 'counted-from KPI shown');
ok(content().includes('Stock value'), 'stock value KPI shown');

// ledger drill-down
click('[data-invled="tab. pantoprazole 40"]'); await tick(150);
const modal = doc.querySelector('.modal').textContent;
ok(modal.includes('stock ledger') && modal.includes('IN-1'), 'ledger lists the purchase with its invoice no.');
ok(modal.includes('Marg GP report'), 'ledger names the sale source');
ok(!modal.includes('OLD'), 'ledger excludes pre-count movements');
click('.modal-x'); await tick();

// filters
click('[data-invf="neg"]'); await tick(150);
ok(content().includes('No items match') || doc.querySelectorAll('tbody tr').length >= 1, 'negative filter runs');
click('[data-invf="all"]'); await tick(150);

// negative stock detection: sell more than we have
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: {
  purchases: [], rtv: [], sales: {}, audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [], invoices: [],
  itemSales: [{ item: 'Syp. Lactulose 200ml', qty: 99, amount: 100 }]   // opening was 12
}});
ok(r.status === 200, 'oversell day saved');
const dom2 = mk(), doc2 = dom2.window.document, w2 = dom2.window;
await tick(300);
const setV2 = (s, v) => { const el = doc2.querySelector(s); el.value = v; el.dispatchEvent(new w2.Event('input', { bubbles: true })); };
setV2('#loginEmail', 'bhagavan@yajnapharma.in');
doc2.querySelector('#loginPw').value = ADMIN_PW;
doc2.querySelector('#loginBtn').click(); await tick(600);
[...doc2.querySelectorAll('[data-open2]')].find(b => b.dataset.open2 === 'mithra').click(); await tick(200);
[...doc2.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === 'inventory').click(); await tick(250);
const lac = JSON.parse(w2.eval(`JSON.stringify(inventoryFor('mithra').find(i=>i.key==='syp. lactulose 200ml'))`));
ok(lac.stock === -87, 'oversell yields negative stock (12 − 99)', lac.stock);
ok(doc2.querySelector('#content').textContent.includes('Negative stock'), 'negative stock surfaced as a KPI');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
