/* Tests for item master, margin tally, invoices, price log — API + DOM */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const MANAGER_PW = process.env.SEED_MANAGER_PW || 'Test@Manager#1';
const USER_PW = process.env.SEED_USER_PW || 'Test@User#1';

const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }};
}
const today = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const T = today();

const adm = jar(), mgr = jar(), stf = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await mgr.req('POST', '/login', { email: 'manager@yajnapharma.in', password: MANAGER_PW });
await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });

console.log('— item master API —');
let r = await stf.req('POST', '/items', { hid: 'mithra', name: 'X', nr: 10, mrp: 20 });
ok(r.status === 403, 'staff cannot add items');
r = await mgr.req('POST', '/items', { hid: 'mithra', name: '', nr: 10, mrp: 20 });
ok(r.status === 400, 'blank name rejected');
r = await mgr.req('POST', '/items', { hid: 'mithra', name: 'Tab. Pantoprazole 40', nr: 60, mrp: 50 });
ok(r.status === 400, 'NR > MRP rejected');
r = await mgr.req('POST', '/items', { hid: 'mithra', name: 'Tab. Pantoprazole 40', nr: 38, mrp: 58, pack: '10s' });
ok(r.status === 200 && r.data.item.key === 'tab. pantoprazole 40', 'item created with normalized key');
const itemId = r.data.item.id;
r = await mgr.req('POST', '/items', { hid: 'mithra', name: '  TAB.  Pantoprazole   40 ', nr: 40, mrp: 60 });
ok(r.status === 409, 'duplicate (case/space-insensitive) rejected');
r = await mgr.req('PATCH', '/items/' + itemId, { nr: 36, mrp: 58, note: 'negotiated with Sun Pharma' });
ok(r.status === 200 && r.data.item.nr === 36, 'price updated (negotiation)');
r = await adm.req('GET', '/items/' + itemId + '/history');
ok(r.status === 200 && r.data.history.length === 1 && r.data.history[0].oldNr === 38 && r.data.history[0].note.includes('negotiated'), 'price change logged with note');
r = await mgr.req('POST', '/items/bulk', { hid: 'mithra', items: [
  { name: 'Inj. Ceftriaxone 1g', nr: 42, mrp: 66, pack: 'vial' },
  { name: 'tab. pantoprazole 40', nr: 1, mrp: 2 },       // dup
  { name: 'Bad Item', nr: 100, mrp: 50 },                 // nr>mrp
  { name: '', nr: 1, mrp: 2 }                             // blank
]});
ok(r.status === 200 && r.data.created.length === 1 && r.data.created[0].name === 'Inj. Ceftriaxone 1g', 'bulk import: dup/bad/blank skipped');
let boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.items.mithra.length === 2, 'bootstrap carries item master');
ok(typeof boot.aiEnabled === 'boolean', 'bootstrap reports aiEnabled flag');

console.log('— invoice margin tally on entry save —');
// master: Pantoprazole nr36/mrp58 → margin 37.9%. Invoice line at nr48/mrp58 → 17.2% → LOW → alert.
// Ceftriaxone nr42/mrp66 → 36.4%. Invoice line nr42.5/mrp66 → 35.6% → within 2pp → no alert.
// "Brand New Drug" unknown → auto-added to master.
const entry = {
  purchases: [{ vendor: 'Sun Pharma Distributors', items: 3, value: 5000 }],
  rtv: [], sales: { mrp: 9000, cogs: 6000, cash: 5000, credit: 4000, cancels: 0 },
  audit: { opening: 100000, actual: 99000, unbilled: false, bounces: [] }, hv: [],
  invoices: [{ vendor: 'Sun Pharma Distributors', invoiceNo: 'SP-991', date: T, fileName: '', lines: [
    { item: 'Tab. Pantoprazole 40', qty: 50, nr: 48, mrp: 58, value: 2400 },
    { item: 'Inj. Ceftriaxone 1g', qty: 20, nr: 42.5, mrp: 66, value: 850 },
    { item: 'Brand New Drug 10', qty: 10, nr: 70, mrp: 100, value: 700 }
  ]}]
};
r = await stf.req('PUT', `/entries/mithra/${T}`, { entry });
ok(r.status === 200, 'entry with invoices saved');
ok(r.data.itemsAdded.length === 1 && r.data.itemsAdded[0].name === 'Brand New Drug 10', 'unknown invoice item auto-added to master');
const marginNs = r.data.notifications.filter(n => n.type === 'margin');
ok(marginNs.length === 1, 'exactly one margin alert (only the real mismatch)', r.data.notifications.map(n=>n.type));
ok(marginNs[0].msg.includes('Pantoprazole') && marginNs[0].msg.includes('SP-991'), 'alert names the item and invoice', marginNs[0].msg);
// re-save with corrected NR → alert clears
entry.invoices[0].lines[0].nr = 36; entry.invoices[0].lines[0].value = 1800;
r = await stf.req('PUT', `/entries/mithra/${T}`, { entry });
ok(r.data.notifications.filter(n => n.type === 'margin').length === 0, 're-save with matching margin clears the alert');
ok(r.data.itemsAdded.length === 0, 'item not duplicated on re-save');
boot = (await stf.req('GET', '/bootstrap')).data;
ok(boot.dailyData.mithra[T].invoices.length === 1 && boot.dailyData.mithra[T].invoices[0].lines.length === 3, 'invoices persist in the entry');
ok(boot.items.mithra.some(i => i.name === 'Brand New Drug 10' && i.source === 'invoice'), 'auto-added item in bootstrap with invoice source');

console.log('— AI endpoints guardrails —');
const fd = new FormData();
fd.append('file', new Blob(['test'], { type: 'application/pdf' }), 'inv.pdf');
const upRes = await fetch(B + '/parse/gpreport?hid=mithra', { method: 'POST', body: fd });
ok(upRes.status === 401, 'parse endpoint requires auth');

console.log('— DOM: item master + invoices UI (demo mode) —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {};
    w.fetch = async (url, opts = {}) => fetch(new URL(url, 'http://127.0.0.1:3061'), opts); } });
const doc = dom.window.document;
const click = s => { const el = doc.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); };
const setVal = (s, v) => { const el = doc.querySelector(s); el.value = v; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
const lastToast = () => { const t = doc.querySelectorAll('#toastRoot .toast'); return t.length ? t[t.length - 1].textContent : ''; };
await tick(300);
click('[data-quick="admin"]'); await tick();
ok(Array.from(doc.querySelectorAll('#sideNav .nav-item')).map(b=>b.dataset.go).join() === 'hospitals,master,users,settings', 'menu is hospitals/master/users/settings');
click('[data-open2]'); await tick();                       // open first hospital
const htab = id => [...doc.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === id).click();
ok([...doc.querySelectorAll('[data-htab]')].some(b => b.dataset.htab === 'items'), 'Item Master is a hospital tab');
htab('items'); await tick();
ok(doc.querySelectorAll('tbody tr').length >= 14, 'demo item master lists seeded items');
ok(doc.body.textContent.includes('avg margin'), 'avg margin shown');
setVal('#itmSearch', 'meropenem'); await tick();
ok(doc.querySelectorAll('tbody tr').length === 1, 'search filters items');
// add item via modal
setVal('#itmSearch', ''); await tick();
click('#itmAdd'); await tick();
setVal('#itName', 'Tab. Test Drug 10'); setVal('#itNr', '80'); setVal('#itMrp', '100');
ok(doc.querySelector('#itMargin').textContent === '20.0%', 'live margin calc in modal', doc.querySelector('#itMargin').textContent);
click('#itGo'); await tick();
ok(doc.body.textContent.includes('Tab. Test Drug 10'), 'item added to list');
// price update modal
const editBtn = doc.querySelector('[data-iedit]'); editBtn.click(); await tick();
setVal('#itNr', String(Number(doc.querySelector('#itNr').value) - 5));
click('#itGo'); await tick();
ok(lastToast().includes('updated'), 'price update flows', lastToast());
// entry: manual invoice with margin mismatch chip
htab('entry'); await tick();
click('#invManualTop'); await tick(250);
ok(!!doc.querySelector('#lmItem'), 'manual invoice opens the line dialog');
setVal('#lmItem', 'Tab. Rifaximin 550');   // master: nr298 mrp412 -> 27.7%
setVal('#lmPqty', '10');
setVal('#lmRate', '350');                  // net rate 350/412 -> margin 15.0% -> low
const g = doc.querySelector('#lmGst'); g.value = '0'; g.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
setVal('#lmMrp', '412');
await tick(150);
const lm = doc.querySelector('#lmCalc').textContent.replace(/\s+/g, ' ');
ok(lm.includes('Low margin'), 'the dialog flags the margin mismatch live', lm.slice(-80));
// read the expectation the app itself would use — an earlier step in this suite
// renegotiated the price, so any hardcoded margin would be stale
const expPct = dom.window.eval("pct(lineStatus(state.hospital, {item:'Tab. Rifaximin 550', pqty:10, oqty:0, rate:350, disc:0, gst:0, mrp:412}).expected)");
ok(lm.includes(expPct), `and names the master's expected margin (${expPct})`, lm.slice(-80));
ok(lm.includes('3,500.00') || lm.includes('3500.00'), 'Purchase Amount auto-computed', lm.slice(0, 120));
click('#lmSave'); await tick(300);
const tbl = doc.querySelector('#entryBody').textContent.replace(/\s+/g, ' ');
ok(tbl.includes('Low margin'), 'the saved row shows the mismatch chip in the Tally column');
ok(tbl.includes(expPct), `and the Master % column shows ${expPct}`);
click('#saveBtn'); await tick();
const toasts = Array.from(doc.querySelectorAll('#toastRoot .toast')).map(t => t.textContent).join('|');
ok(toasts.includes('Alert sent'), 'margin mismatch alert fired on demo save', toasts);
htab('alerts'); await tick();
ok((doc.querySelector('#content')?.textContent||'').includes('Margin mismatch'), 'margin alert listed in this hospital');
ok(!doc.querySelector('#alertHosp'), 'no hospital filter — alerts are scoped to the open hospital');
ok((doc.querySelector('#content')?.textContent||'').includes('unread'), 'alerts header shows unread count for this hospital');
// sales tab has GP upload; demo shows guard toast
htab('entry'); await tick();
click('[data-tab="1"]'); await tick();
ok(!!doc.querySelector('#gpBtn'), 'GP upload button on Sales tab');
click('#gpBtn'); await tick();
ok(lastToast().includes('live mode'), 'GP upload demo-guard toast', lastToast());
click('[data-tab="0"]'); await tick();
ok(!doc.querySelector('#invUpload'), 'invoice upload button removed');
ok(!!doc.querySelector('#invManualTop'), 'only Add invoice manually remains');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
