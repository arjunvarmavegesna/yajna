/* Tests: stock adjustments — recorded as movements, reason-mandatory, auditable */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const MANAGER_PW = process.env.SEED_MANAGER_PW || 'Test@Manager#1';
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
const T = (() => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); })();
const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D0 = addD(T, -5);

const adm = jar(), mgr = jar(), stf = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await mgr.req('POST', '/login', { email: 'manager@yajnapharma.in', password: MANAGER_PW });
await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });

// opening stock 100 of one item as on D0
await adm.req('POST', '/items/opening', { hid: 'mithra', stockDate: D0, rows: [{ name: 'Tab. Adj Test', qty: 100, nr: 10, mrp: 20 }] });

console.log('— permissions —');
let r = await stf.req('POST', '/stock/adjust', { hid: 'mithra', item: 'Tab. Adj Test', qty: -5, reason: 'Damage / breakage' });
ok(r.status === 403, 'a data-entry user CANNOT adjust stock (would defeat the audit)');
r = await mgr.req('POST', '/stock/adjust', { hid: 'mithra', item: 'Tab. Adj Test', qty: -5, reason: 'Damage / breakage', note: 'broken in rack', date: T });
ok(r.status === 200, 'a manager/admin can adjust');
const adjId = r.data.adjustment.id;
ok(r.data.adjustment.user === 'Ravi Teja', 'adjustment records who did it', r.data.adjustment.user);
r = await mgr.req('POST', '/stock/adjust', { hid: 'viraj', item: 'X', qty: 1, reason: 'Data correction' });
ok(r.status === 200, 'manager can adjust another hospital they can see');

console.log('— validation —');
r = await adm.req('POST', '/stock/adjust', { hid: 'mithra', item: 'Tab. Adj Test', qty: 0, reason: 'Data correction' });
ok(r.status === 400 && /zero/i.test(r.data.error), 'zero adjustment rejected', r.data.error);
r = await adm.req('POST', '/stock/adjust', { hid: 'mithra', item: 'Tab. Adj Test', qty: -5 });
ok(r.status === 400 && /reason/i.test(r.data.error), 'reason is mandatory', r.data.error);
r = await adm.req('POST', '/stock/adjust', { hid: 'mithra', item: 'Tab. Adj Test', qty: -5, reason: 'Because I said so' });
ok(r.status === 400, 'reason must be from the allowed list');
r = await adm.req('POST', '/stock/adjust', { hid: 'mithra', item: '', qty: -5, reason: 'Data correction' });
ok(r.status === 400, 'item required');
r = await adm.req('POST', '/stock/adjust', { hid: 'mithra', item: 'Tab. Adj Test', qty: -5, reason: 'Data correction', date: addD(T, 2) });
ok(r.status === 400 && /future/i.test(r.data.error), 'future date rejected', r.data.error);
r = await adm.req('POST', '/stock/adjust', { hid: 'mithra', item: 'Tab. Adj Test', qty: -5, reason: 'Data correction', date: addD(D0, -1) });
ok(r.status === 400 && /stock count date/i.test(r.data.error), 'date before the stock count rejected', r.data.error);

console.log('— it moves the stock —');
let boot = (await adm.req('GET', '/bootstrap')).data;
ok(Array.isArray(boot.adjustments.mithra) && boot.adjustments.mithra.length === 1, 'adjustment in bootstrap');
ok(Array.isArray(boot.adjReasons) && boot.adjReasons.includes('Expiry write-off'), 'reason list served to the client');
const a = boot.adjustments.mithra[0];
ok(a.key === 'tab. adj test' && a.qty === -5 && a.reason === 'Damage / breakage' && a.note === 'broken in rack', 'adjustment stored intact', JSON.stringify(a));

console.log('— DOM: adjust flow (live) —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const mk = () => { let cookie = '';
  return new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {}; w.confirm = () => true;
      w.fetch = async (url, opts = {}) => { const res = await fetch(new URL(url, 'http://127.0.0.1:3061'), { method: opts.method || 'GET', headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) }, body: opts.body });
        const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return res; }; } }); };
const dom = mk(), doc = dom.window.document, w = dom.window;
const click = s => { const el = doc.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); };
const setV = (s, v) => { const el = doc.querySelector(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const txt = s => (doc.querySelector(s)?.textContent || '').trim();
const stockOf = () => JSON.parse(w.eval("JSON.stringify(inventoryFor('mithra').find(i=>i.key==='tab. adj test'))"));
await tick(300);
setV('#loginEmail', 'bhagavan@yajnapharma.in');
doc.querySelector('#loginPw').value = ADMIN_PW;
click('#loginBtn'); await tick(600);
[...doc.querySelectorAll('[data-open2]')].find(b => b.dataset.open2 === 'mithra').click(); await tick(200);
[...doc.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === 'inventory').click(); await tick(250);

ok(stockOf().stock === 95, 'stock reflects the -5 adjustment (100 - 5)', stockOf().stock);
ok(stockOf().adj === -5, 'adjusted column tracks it', stockOf().adj);
ok(txt('#content').includes('Adjustments'), 'Adjustments KPI present');
ok(!!doc.querySelector('[data-invadj="tab. adj test"]'), 'Adjust button on the row');

// counted-stock mode works out the delta itself
click('[data-invadj="tab. adj test"]'); await tick(150);
ok(txt('#adjAfter') === '95', 'modal opens showing current stock', txt('#adjAfter'));
setV('#adjCount', '90'); await tick(80);
ok(txt('#adjAfter') === '90' && txt('#adjDelta').includes('-5'), 'counted 90 → works out −5 for you', txt('#adjDelta'));
ok(txt('#adjDelta').includes('written off'), 'shows the rupee value being written off', txt('#adjDelta'));
doc.querySelector('#adjReason').value = 'Physical count correction';
setV('#adjNote', 'monthly count');
click('#adjGo'); await tick(500);
ok(stockOf().stock === 90, 'stock now 90 after the counted correction', stockOf().stock);

// direct +/- mode
click('[data-invadj="tab. adj test"]'); await tick(150);
click('[data-adjm="delta"]'); await tick(80);
setV('#adjQty', '10'); await tick(80);
ok(txt('#adjAfter') === '100', 'add/remove mode: +10 → 100', txt('#adjAfter'));
doc.querySelector('#adjReason').value = 'Return from ward';
click('#adjGo'); await tick(500);
ok(stockOf().stock === 100, 'stock back to 100', stockOf().stock);

// ledger shows every adjustment with its reason
click('[data-invled="tab. adj test"]'); await tick(200);
const led = doc.querySelector('.modal').textContent;
ok(led.includes('Adjustment'), 'ledger flags adjustments');
ok(led.includes('Physical count correction') && led.includes('monthly count'), 'ledger shows reason and note', led.includes('monthly count'));
ok(led.includes('Bhagavan'), 'ledger names who adjusted');
ok(!!doc.querySelector('[data-adjdel]'), 'admin can undo from the ledger');

// undo reverts the stock
const before = stockOf().stock;
click('[data-adjdel]'); await tick(500);
ok(stockOf().stock !== before, 'undo reverts the stock', before + ' -> ' + stockOf().stock);

// filter
click('[data-invf="adj"]'); await tick(200);
ok(doc.querySelectorAll('tbody tr').length >= 1, 'Adjusted filter lists corrected items');

console.log('— undo is admin-only —');
// fresh one: the DOM run above already undid the original
r = await mgr.req('POST', '/stock/adjust', { hid: 'mithra', item: 'Tab. Adj Test', qty: -2, reason: 'Expiry write-off', date: T });
const freshId = r.data.adjustment.id;
r = await stf.req('DELETE', '/stock/adjust/' + freshId);
ok(r.status === 403, 'a data-entry user cannot delete an adjustment');
r = await mgr.req('DELETE', '/stock/adjust/' + freshId);
ok(r.status === 200, 'a manager/admin can — one role, full access');
r = await adm.req('DELETE', '/stock/adjust/' + freshId);
ok(r.status === 404, 'deleting twice 404s');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
