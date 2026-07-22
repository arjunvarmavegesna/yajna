/* Tests: pending items — a purchased name the master does not know waits for
   the manager; matching a misspelling leaves an alias that resolves it forever.
   API (live HTTP) + DOM (demo mode drawer). */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const USER_PW = process.env.SEED_USER_PW || 'Test@User#1';

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
const adm = jar(), stf = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });

const entryWith = (invLines) => ({
  purchases: [{ vendor: 'Sun Pharma', items: invLines.length, value: 0, invId: 'inv-p1' }],
  rtv: [], sales: { mrp: 0, cogs: 0, cash: 0, credit: 0, cancels: 0 },
  cash: { opening: 0, receipts: 0, payments: 0, actual: '', reason: '' },
  audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [], itemSales: [],
  invoices: [{ id: 'inv-p1', vendor: 'Sun Pharma', invoiceNo: 'S1', date: T, lines: invLines }]
});

console.log('— an unknown purchased item QUEUES, it does not auto-join the master —');
await adm.req('POST', '/items', { hid: 'viraj', name: 'Tab. Rifaximin 550', pack: '10s', nr: 300, mrp: 400 });
let r = await adm.req('PUT', `/entries/viraj/${T}`, { entry: entryWith([{ item: 'Tab. Rifaximn 550', pqty: 10, oqty: 0, rate: 290, disc: 0, gst: 0, mrp: 400 }]) });
ok(r.status === 200, 'the day saves', r.data.error);
ok((r.data.itemsAdded || []).length === 0, 'NOTHING was auto-added to the master');
ok(r.data.pendingItems?.length === 1 && r.data.pendingItems[0].name === 'Tab. Rifaximn 550', 'the misspelt name landed in the pending queue', JSON.stringify(r.data.pendingItems));
let boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.items.viraj.length === 1, 'the master still has exactly one item');
ok(boot.pendingItems.viraj.length === 1 && boot.pendingItems.viraj[0].status === 'pending', 'bootstrap carries the queue');
ok(boot.pendingItems.viraj[0].vendor === 'Sun Pharma' && boot.pendingItems.viraj[0].nr === 290, 'with the vendor and the line rates for context');

console.log('— case and spacing NEVER queue: nameKey already folds them —');
r = await adm.req('PUT', `/entries/viraj/${addDaysStr(T, 0)}`, { entry: entryWith([{ item: '  TAB.  Rifaximin   550 ', pqty: 5, oqty: 0, rate: 300, disc: 0, gst: 0, mrp: 400 }]) });
function addDaysStr(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
ok((r.data.pendingItems || []).length === 0, 'a case/spacing variant of a master item creates NO pending entry');

console.log('— seen again: the queue counts, it does not duplicate —');
r = await adm.req('PUT', `/entries/viraj/${T}`, { entry: entryWith([{ item: 'tab. rifaximn 550', pqty: 4, oqty: 0, rate: 292, disc: 0, gst: 0, mrp: 400 }]) });
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.pendingItems.viraj.length === 1 && boot.pendingItems.viraj[0].seen === 2, 'same misspelling (any case) bumps seen to 2, one row', JSON.stringify(boot.pendingItems.viraj));
ok(boot.pendingItems.viraj[0].nr === 292, 'and carries the LATEST rate');
const pid = boot.pendingItems.viraj[0].id;

console.log('— a data-entry user cannot rule on the queue —');
ok((await stf.req('POST', `/pending-items/${pid}/match`, { itemId: 'x' })).status === 403, 'match is admin-only');
ok((await stf.req('POST', `/pending-items/${pid}/approve`, {})).status === 403, 'approve is admin-only');

console.log('— MATCH: the typo becomes an alias of the real item —');
const realId = boot.items.viraj[0].id;
ok((await adm.req('POST', `/pending-items/${pid}/match`, { itemId: 'nope' })).status === 400, 'matching to a non-item is refused');
r = await adm.req('POST', `/pending-items/${pid}/match`, { itemId: realId });
ok(r.status === 200 && r.data.pending.status === 'matched', 'matched and closed', JSON.stringify(r.data.pending));
ok(r.data.aliases.length === 1 && r.data.aliases[0].itemId === realId, 'the alias points at the real item');
ok((await adm.req('POST', `/pending-items/${pid}/match`, { itemId: realId })).status === 400, 'a resolved row cannot be ruled on twice');
ok((await adm.req('GET', '/bootstrap')).data.items.viraj.length === 1, 'the master STILL has one item — a match never mints one');

console.log('— the alias resolves future purchases: the same typo never asks again —');
r = await adm.req('PUT', `/entries/viraj/${T}`, { entry: entryWith([{ item: 'Tab. Rifaximn 550', pqty: 3, oqty: 0, rate: 300, disc: 0, gst: 0, mrp: 400 }]) });
ok((r.data.pendingItems || []).length === 0, 'no new pending entry — the alias caught it');

console.log('— APPROVE: a genuinely new item joins the master, with the manager\'s corrections —');
await adm.req('PUT', `/entries/viraj/${T}`, { entry: entryWith([{ item: 'Syrp. Cofrest 100ml', pqty: 6, oqty: 0, rate: 55, disc: 0, gst: 12, mrp: 90 }]) });
boot = (await adm.req('GET', '/bootstrap')).data;
const p2 = boot.pendingItems.viraj.find(x => x.status === 'pending');
ok(!!p2 && p2.name === 'Syrp. Cofrest 100ml', 'the new syrup queued');
ok((await adm.req('POST', `/pending-items/${p2.id}/approve`, { name: 'Syrp. Cofrest 100ml', nr: 0, mrp: 0 })).status === 400, 'approving without positive rates is refused');
r = await adm.req('POST', `/pending-items/${p2.id}/approve`, { name: 'Syp. Cofrest 100ml', pack: 'btl', nr: 61.6, mrp: 90 });
ok(r.status === 200 && r.data.item.name === 'Syp. Cofrest 100ml', 'approved under the CORRECTED spelling', JSON.stringify(r.data.item));
ok(r.data.aliases.some(a => a.itemId === r.data.item.id), 'and the purchased spelling became an alias of it — old lines still resolve');
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.items.viraj.length === 2, 'the master now has two items — one approval, one addition');
ok(boot.pendingItems.viraj.every(p => p.status !== 'pending'), 'the queue is empty');

console.log('— DISMISS reopens by itself if the thing is bought again —');
await adm.req('PUT', `/entries/viraj/${T}`, { entry: entryWith([{ item: 'Total Junk Row', pqty: 1, oqty: 0, rate: 5, disc: 0, gst: 0, mrp: 9 }]) });
boot = (await adm.req('GET', '/bootstrap')).data;
const p3 = boot.pendingItems.viraj.find(x => x.status === 'pending');
await adm.req('POST', `/pending-items/${p3.id}/dismiss`, {});
ok((await adm.req('GET', '/bootstrap')).data.pendingItems.viraj.find(x => x.id === p3.id).status === 'dismissed', 'dismissed');
await adm.req('PUT', `/entries/viraj/${T}`, { entry: entryWith([{ item: 'Total Junk Row', pqty: 2, oqty: 0, rate: 5, disc: 0, gst: 0, mrp: 9 }]) });
ok((await adm.req('GET', '/bootstrap')).data.pendingItems.viraj.find(x => x.id === p3.id).status === 'pending', 'bought again → it reopens — a dismissal is not a permanent blind spot');

/* ── DOM: the drawer, the suggestions, and the ledger re-count ── */
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null;
    w.confirm = () => true;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const w = dom.window, doc = w.document;
await tick(400);
doc.querySelector('[data-quick="admin"]').click(); await tick(700);

console.log('— the ledger re-counts old lines the moment an alias lands —');
w.eval(`
  const hid='viraj', T=todayISO();
  db.items[hid] = [{id:'r1', name:'Tab. Rifaximin 550', key:nameKey('Tab. Rifaximin 550'), pack:'10s', nr:300, mrp:400, openingQty:10, source:'demo', updatedAt:Date.now()}];
  db.hospitals[hid].stockDate = addDays(T,-1);
  db.adjustments[hid]=[]; db.aliases[hid]=[]; db.pendingItems[hid]=[]; db.dailyData[hid]={};
  db.dailyData[hid][T] = { savedAt:Date.now(), purchases:[], rtv:[], itemSales:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{opening:0,receipts:0,payments:0,actual:'',reason:''},
    audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[],
    invoices:[{id:'iv1', vendor:'Sun', invoiceNo:'1', date:T, lines:[{item:'Tab. Rifaximn 550', pqty:7, oqty:0, rate:290, disc:0, gst:0, mrp:400}]}] };
`);
let stocks = w.eval(`JSON.parse(JSON.stringify(stockAsOf('viraj', todayISO()).items.map(m=>({key:m.key, stock:m.stock}))))`);
ok(stocks.length === 2, 'before the match, the typo is its own phantom line in stock', JSON.stringify(stocks));
w.eval(`db.aliases.viraj.push({id:'al1', aliasKey:nameKey('Tab. Rifaximn 550'), itemId:'r1', by:'B', at:Date.now()})`);
stocks = w.eval(`JSON.parse(JSON.stringify(stockAsOf('viraj', todayISO()).items.map(m=>({key:m.key, stock:m.stock}))))`);
ok(stocks.length === 1 && stocks[0].stock === 17, 'after the match, 10 opening + 7 typo-purchase count as ONE item — the ledger derived, nothing was rewritten', JSON.stringify(stocks));
ok(w.eval(`findItem('viraj','Tab. Rifaximn 550').name`) === 'Tab. Rifaximin 550', 'findItem resolves the alias — the margin tally sees the real item');

console.log('— the drawer —');
w.eval(`
  db.pendingItems.viraj = [{id:'p1', hid:'viraj', name:'Tab. Rifaximine 550', key:nameKey('Tab. Rifaximine 550'), nr:290, mrp:400,
    vendor:'Sun Pharma', firstDate:todayISO(), lastDate:todayISO(), seen:3, status:'pending', matchedItemId:null}];
  openHospital('viraj','items');
`); await tick(400);
ok(/1 new from purchases/.test(doc.querySelector('#content').textContent), 'the Item Master toolbar wears the count', doc.querySelector('#itmPending')?.textContent);
doc.querySelector('#itmPending').click(); await tick(400);
ok(!!doc.querySelector('#pendDrawer'), 'the slide-over drawer opens');
ok(/Tab\. Rifaximine 550/.test(doc.querySelector('#pendDrawer').textContent), 'listing the pending name');
ok(/seen 3×/.test(doc.querySelector('#pendDrawer').textContent), 'with how often it has been bought');
ok(/Is it one of these\?/.test(doc.querySelector('#pendDrawer').textContent) && /Tab\. Rifaximin 550/.test(doc.querySelector('#pendDrawer').textContent),
   'and suggests the near-identical master item first — the typo is one letter off');
// match from the suggestion
doc.querySelector('[data-pmatch]').click(); await tick(300);
ok(w.eval(`db.pendingItems.viraj[0].status`) === 'matched', 'one tap on the suggestion matches it');
ok(w.eval(`db.aliases.viraj.some(a=>a.aliasKey===nameKey('Tab. Rifaximine 550'))`), 'and leaves the alias');
ok(/Nothing waiting/.test(doc.querySelector('#pendDrawer').textContent), 'the drawer empties');
w.eval(`closeDrawer()`); await tick(150);

console.log('— a data-entry user never sees the queue —');
w.eval(`state.user = {...state.user, role:"user"}; openHospital('viraj','items')`); await tick(300);
ok(w.eval('state.hospTab') === 'entry', 'the Item Master tab itself is admin-only, queue included');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
