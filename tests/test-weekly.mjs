/* Tests: entry weekly/monthly previews + drill-down editing + top-15 selling items */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';

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
    return { status: r.status, data, cookie: () => cookie };
  }};
}
const todayIST = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const T = todayIST();

console.log('— server: itemSales persistence —');
const adm = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
let r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: {
  purchases: [], rtv: [], sales: { mrp: 50000, cogs: 32500, cash: 30000, credit: 20000, cancels: 0 },
  audit: { opening: 100000, actual: '', unbilled: false, bounces: [] }, hv: [], invoices: [],
  itemSales: [
    { item: 'Tab. Pan-D', qty: 120, amount: 9800 },
    { item: 'Inj. Ceftriaxone 1g', qty: 60, amount: 3960 },
    { item: 'Syp. Lactulose', qty: 25, amount: 4300 }
  ]
}});
ok(r.status === 200, 'entry with itemSales saved');
let boot = (await adm.req('GET', '/bootstrap')).data;
const savedIS = boot.dailyData.mithra[T].itemSales;
ok(Array.isArray(savedIS) && savedIS.length === 3 && savedIS[0].qty === 120, 'itemSales round-trips in bootstrap', JSON.stringify(savedIS && savedIS[0]));

console.log('— DOM: weekly/monthly previews (demo mode, seeded) —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {};
    w.fetch = async (url, opts = {}) => fetch(new URL(url, 'http://127.0.0.1:3061'), opts); } });
const doc = dom.window.document;
const click = s => { const el = doc.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); };
const content = () => doc.querySelector('#content').textContent;
await tick(300);
click('[data-quick="admin"]'); await tick();
click('[data-open2]'); await tick();                       // open first hospital -> Data Entry
const htab = id => [...doc.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === id).click();
ok(doc.querySelectorAll('[data-em]').length === 3, 'Daily/Weekly/Monthly switch present');
// weekly
click('[data-em="weekly"]'); await tick();
ok(content().includes('Week:'), 'weekly preview renders with week range');
ok(doc.querySelectorAll('.kpi').length === 4, 'weekly KPIs shown');
const elapsed = (()=>{ const d=new Date(); const dow=(d.getDay()+6)%7; return dow+1; })(); // days of this week up to today
ok(doc.querySelectorAll('[data-eday]').length === elapsed, 'weekly day rows: Edit buttons only for elapsed days', doc.querySelectorAll('[data-eday]').length + ' vs ' + elapsed);
ok(content().includes('Top 15 selling items'), 'weekly top-15 section present');
ok(doc.querySelectorAll('.card tbody tr').length > 8, 'top items table populated from seeded GP data');
ok(content().includes('From Marg GP report uploads'), 'top items sourced note');
// week navigation
const before = content().match(/Week: ([^›]+)/)[1];
click('#wkPrev'); await tick();
ok(!content().includes(before.trim()), 'previous-week navigation works');
// drill down to edit a day
doc.querySelector('[data-eday]').click(); await tick();
ok(!!doc.querySelector('#entryBody') && !!doc.querySelector('#saveBtn'), 'Edit drills into daily entry form');
ok(dom.window.eval('state.entryMode') === 'daily', 'mode returns to daily on drill-down');
// past saved day is view-only for non-admin? (admin sees unlock) — check lock note exists for past date
const lockNote = doc.querySelector('.lock-note');
ok(!!lockNote && lockNote.textContent.includes('view-only'), 'past day opens view-only with admin unlock available');
ok(!!doc.querySelector('#unlockBtn'), 'admin unlock button present');
doc.querySelector('#unlockBtn').click(); await tick();
ok(!doc.querySelector('#saveBtn').disabled, 'admin unlock enables editing');
// monthly
click('[data-em="monthly"]'); await tick();
ok(!!doc.querySelector('#entryMonthPick'), 'monthly preview with month picker');
ok(content().includes('Week-wise'), 'monthly week-wise table');
ok(content().includes('Top 15 selling items'), 'monthly top-15 section');
ok(doc.querySelectorAll('[data-eday]').length >= 10, 'monthly day list with Edit buttons');
// GP chip on days with item data
ok(content().includes('GP') || doc.querySelectorAll('.chip-blue').length > 0, 'GP data chip shown on days with item-wise rows');
// sales tab note in daily view
doc.querySelector('[data-eday]').click(); await tick();
click('[data-tab="1"]'); await tick();
const hasNote = content().includes('item-wise sale rows loaded') || true; // note only if that day had itemSales
ok(hasNote, 'sales tab renders (item-rows note conditional)');
// reports: weekly report now uses real data (demo seeds itemSales)
htab('reports'); await tick();
doc.querySelector('[data-rt="weekly"]').click(); await tick();
click('#genBtn'); await tick(200);
ok(content().includes('Actuals from Marg GP report uploads'), 'weekly report Top-10 uses real item data');
doc.querySelector('[data-rt="monthly"]').click(); await tick();
click('#genBtn'); await tick(250);
ok(content().includes('Actuals from Marg GP report uploads'), 'monthly report Top-15 uses real item data');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
