/* Frontend DOM tests via jsdom: demo mode (client-only) + live mode against :3061 */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name, extra ?? ''); } };
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const BASE = 'http://127.0.0.1:3061';

function makeDom() {
  let cookie = '';
  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.scrollTo = () => {};
      window.open = () => null;
      window.print = () => {};
      window.fetch = async (url, opts = {}) => {
        const res = await fetch(new URL(url, BASE), {
          method: opts.method || 'GET',
          headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) },
          body: opts.body
        });
        const sc = res.headers.get('set-cookie');
        if (sc) cookie = sc.split(';')[0];
        return res;
      };
    }
  });
  return dom;
}

const routesOf = (doc) => Array.from(doc.querySelectorAll('#sideNav .nav-item')).map(b => b.dataset.go);
const click = (doc, sel) => { const el = doc.querySelector(sel); if (!el) throw new Error('missing ' + sel); el.click(); };
const text = (doc, sel) => (doc.querySelector(sel)?.textContent || '').trim();
const setVal = (doc, sel, v) => { const el = doc.querySelector(sel); el.value = v; el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true })); };
const lastToast = (doc) => { const t = doc.querySelectorAll('#toastRoot .toast'); return t.length ? t[t.length - 1].textContent : ''; };

/* ================= DEMO MODE ================= */
console.log('— demo mode (browser-only) —');
{
  const dom = makeDom();
  const doc = dom.window.document;
  await tick(300); // DOMContentLoaded + auto-bootstrap 401 swallow
  ok(doc.querySelector('#app').className.includes('on') === false, 'starts on login screen');

  click(doc, '[data-quick="admin"]'); await tick();
  ok(doc.querySelector('#app').classList.contains('on'), 'demo admin enters app');
  ok(doc.querySelector('#demoPill').style.display !== 'none', 'DEMO pill visible');
  ok(doc.querySelector('#livePill').style.display === 'none', 'LIVE pill hidden');
  ok(text(doc, '#uName') === 'Bhagavan', 'user name shown');
  ok(routesOf(doc).join(',') === 'hospitals,master,users,settings', 'admin menu: hospitals / all-companies master / users / settings');
  ok(doc.querySelectorAll('.hosp-card').length === 3, 'hospitals list: 3 hospital cards');
  ok(doc.querySelectorAll('.kpi').length === 4, 'hospitals list: 4 KPIs');

  // enter a hospital, then use its tab bar
  click(doc, '[data-open2]'); await tick();
  const htab = (d,id) => [...d.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === id).click();
  ok(!!doc.querySelector('#entryBody'), 'entry renders');
  click(doc, '[data-tab="1"]'); await tick();
  setVal(doc, '[data-s="mrp"]', '100000'); setVal(doc, '[data-s="cogs"]', '65000');
  ok(text(doc, '#calcMargin') === '35.0%', 'margin live-calc 35.0%', text(doc, '#calcMargin'));
  click(doc, '[data-tab="2"]'); await tick();
  ok(!!doc.querySelector('#cVarBox'), 'cash tab renders the drawer');
  click(doc, '[data-tab="3"]'); await tick();
  ok(!!doc.querySelector('#addBounce'), 'bounce tab renders the register');
  click(doc, '[data-tab="4"]'); await tick();
  ok(!!doc.querySelector('#varBox'), 'audit tab renders');
  click(doc, '[data-tab="5"]'); await tick();
  ok(doc.querySelectorAll('[data-h]').length > 0, 'HV tab renders rows');
  click(doc, '[data-tab="0"]'); await tick();
  const rowsBefore = doc.querySelectorAll('#purchTbl tbody tr').length;
  click(doc, '#addPurch'); await tick();
  ok(doc.querySelectorAll('#purchTbl tbody tr').length === rowsBefore + 1, 'add purchase row');
  click(doc, '#saveBtn'); await tick();
  const allToasts = Array.from(doc.querySelectorAll('#toastRoot .toast')).map(t=>t.textContent).join(' | ');
  ok(allToasts.includes('Saved (demo'), 'demo save toast', allToasts);
  ok(allToasts.includes('Alert sent'), 'demo variance alert toast fired');

  // history
  htab(doc,'history'); await tick();
  ok(doc.querySelectorAll('tbody tr').length >= 30, 'history: 30 days listed');

  // reports: generate all three
  htab(doc,'reports'); await tick();
  click(doc, '#genBtn'); await tick();
  ok(!!doc.querySelector('.report-doc'), 'daily report generated');
  click(doc, '[data-rt="weekly"]'); await tick(); click(doc, '#genBtn'); await tick();
  ok(doc.querySelectorAll('.rp-sec').length >= 8, 'weekly report with sections');
  click(doc, '[data-rt="monthly"]'); await tick(); click(doc, '#genBtn'); await tick(150);
  ok(!!doc.querySelector('.score-ring'), 'monthly report incl. health score ring');
  ok(doc.querySelectorAll('#secList .switch input').length === 19, 'monthly: 19 section toggles (Bounce Summary + Stock Position added)', doc.querySelectorAll('#secList .switch input').length);

  // vendors: pay modal
  htab(doc,'vendors'); await tick();
  const vRows = doc.querySelectorAll('[data-pay]').length;
  ok(vRows >= 6, 'vendor ledger rows', vRows);
  click(doc, '[data-pay="0"]'); await tick();
  setVal(doc, '#payAmt', '9000');
  click(doc, '#payGo'); await tick();
  ok(lastToast(doc).includes('9,000') && lastToast(doc).includes('demo'), 'demo payment recorded', lastToast(doc));

  // vendors: CSV upload preview + import
  click(doc, '#upBtn'); await tick();
  doc.querySelector('#csvPaste').value = 'New Test Vendor,50000,15,+91 9\nSun Pharma Distributors,1,30';
  click(doc, '#csvPrev'); await tick();
  ok(doc.querySelector('#csvPreview').textContent.includes('New'), 'CSV preview parsed');
  click(doc, '#csvGo'); await tick();
  ok(lastToast(doc).includes('imported'), 'CSV imported (demo)');

  // hospitals: add + toggle (now on the hospitals list itself)
  click(doc, '[data-go="hospitals"]'); await tick();
  click(doc, '#addHosp'); await tick();
  setVal(doc, '#hName', 'Demo New Hosp');
  click(doc, '#hSave'); await tick();
  ok(doc.body.textContent.includes('Demo New Hosp'), 'hospital added (demo)');
  click(doc, '[data-htogg="viraj"]'); await tick();
  ok(lastToast(doc).includes('deactivated'), 'hospital toggled');

  // notifications (per-hospital tab)
  click(doc, '[data-open2]'); await tick(); htab(doc,'alerts'); await tick();
  const unreadBefore = doc.querySelectorAll('.notif.unread').length;
  ok(doc.querySelectorAll('.notif').length > 0, 'alerts listed');
  click(doc, '#markAll'); await tick();
  ok(doc.querySelectorAll('.notif.unread').length === 0 && unreadBefore > 0, 'mark all read');
  // click an alert → jumps to entry
  doc.querySelector('.notif').click(); await tick();
  ok(dom.window.eval('state.hospTab') === 'entry' && !!doc.querySelector('#entryBody'), 'alert click opens that day in the Data Entry tab');

  // settings (demo)
  click(doc, '[data-go="settings"]'); await tick();
  ok(doc.body.textContent.includes('demo mode'), 'settings shows demo note');
  ok(!doc.querySelector('#pwGo'), 'no password form in demo');

  // staff demo scoping
  click(doc, '#setLogout'); await tick();
  click(doc, '[data-quick="staff"]'); await tick();
  ok(routesOf(doc).join(',') === 'hospitals,settings', 'staff menu: hospitals / settings');
  ok(!doc.querySelector('#entryHosp'), 'no hospital picker — the workspace defines the hospital');
  ok(!!doc.querySelector('#entryBody'), 'staff lands straight in their only hospital');
  click(doc, '#logoutBtn'); await tick();
  ok(doc.querySelector('#loginView').style.display !== 'none', 'logout returns to login');

  // PIN demo
  doc.querySelector('#pinInput').value = '2580';
  click(doc, '#pinBtn'); await tick();
  ok(doc.querySelector('#app').classList.contains('on'), 'PIN 2580 demo login');
}

/* ================= LIVE MODE ================= */
console.log('— live mode (against test server) —');
{
  const dom = makeDom();
  const doc = dom.window.document;
  await tick(300);

  // wrong login shows error
  setVal(doc, '#loginEmail', 'bhagavan@yajnapharma.in');
  doc.querySelector('#loginPw').value = 'wrongpass';
  click(doc, '#loginBtn'); await tick(400);
  ok(doc.querySelector('#loginErr').style.display === 'block', 'bad login shows error');

  doc.querySelector('#loginPw').value = ADMIN_PW;
  click(doc, '#loginBtn'); await tick(600);
  ok(doc.querySelector('#app').classList.contains('on'), 'real login enters app');
  ok(doc.querySelector('#livePill').style.display !== 'none', 'LIVE pill visible');
  ok(doc.querySelector('#demoPill').style.display === 'none', 'DEMO pill hidden');
  ok(doc.querySelectorAll('.hosp-card').length === 3, 'live hospitals list: 3 hospitals (clean db)');

  // live entry save round-trip — open Mithra explicitly
  const openHosp = (d,hid) => [...d.querySelectorAll('[data-open2]')].find(b => b.dataset.open2 === hid).click();
  const htabL = (d,id) => [...d.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === id).click();
  openHosp(doc,'mithra'); await tick();
  setVal(doc, '[data-p="0:vendor"]', 'Live Vendor One');
  setVal(doc, '[data-p="0:items"]', '5');
  setVal(doc, '[data-p="0:value"]', '12000');
  click(doc, '[data-tab="1"]'); await tick();
  setVal(doc, '[data-s="mrp"]', '40000'); setVal(doc, '[data-s="cogs"]', '26000');
  setVal(doc, '[data-s="cash"]', '25000'); setVal(doc, '[data-s="credit"]', '15000');
  click(doc, '[data-tab="4"]'); await tick();   // Audit — Cash and Bounces now sit at 2 and 3
  setVal(doc, '[data-a="opening"]', '100000');
  setVal(doc, '[data-a="actual"]', '86000'); // expected 100000+12000-26000=86000 → Nil
  ok(text(doc, '#calcVar').includes('Nil'), 'live variance calc Nil', text(doc, '#calcVar'));
  click(doc, '#saveBtn'); await tick(500);
  ok(lastToast(doc).includes('Saved & synced'), 'live save toast', lastToast(doc));
  ok(lastToast(doc).includes('1 new vendor'), 'new vendor toast');
  ok(!!doc.querySelector('.chip-green'), 'saved chip shown');

  // live payment via UI
  htabL(doc,'vendors'); await tick(300);
  ok(doc.body.textContent.includes('Live Vendor One'), 'auto-registered vendor in ledger');
  click(doc, '[data-pay="0"]'); await tick();
  setVal(doc, '#payAmt', '3000');
  click(doc, '#payGo'); await tick(400);
  ok(lastToast(doc).includes('3,000'), 'live payment recorded', lastToast(doc));

  // live CSV import via UI
  click(doc, '#upBtn'); await tick();
  doc.querySelector('#csvPaste').value = 'UI Bulk Vendor,75000,21,+91 90001';
  click(doc, '#csvPrev'); await tick();
  click(doc, '#csvGo'); await tick(400);
  ok(lastToast(doc).includes('1 vendor imported'), 'live CSV import', lastToast(doc));

  // report prefs persist via UI toggle
  htabL(doc,'reports'); await tick();
  const sw = doc.querySelector('[data-sec="2"]');
  sw.checked = false; sw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await tick(300);

  // live report generation from real entry
  click(doc, '#genBtn'); await tick(200);
  ok(!!doc.querySelector('.report-doc'), 'daily report from real data');
  ok(doc.body.textContent.includes('12,000'), 'report shows real purchase value');
  ok(!text(doc,'.report-doc').includes('Gross margin'), 'disabled Sales section correctly omitted');

  // settings keeps only the profile + password
  click(doc, '[data-go="settings"]'); await tick(200);
  ok(!!doc.querySelector('#pwGo'), 'password form present (live)');
  ok(!doc.body.textContent.includes('Team accounts'), 'team accounts moved out of Settings');

  // add user via the Users & Roles tab
  click(doc, '[data-go="users"]'); await tick(250);
  ok(doc.querySelectorAll('[data-uedit]').length >= 3, 'users listed in Users & Roles');
  click(doc, '#addUser'); await tick();
  setVal(doc, '#nuName', 'UI Test User');
  setVal(doc, '#nuEmail', 'uitest@yajnapharma.in');
  doc.querySelector('input[name="nurole"][value="admin"]').checked = true;
  doc.querySelector('#nuAll').checked = true;
  doc.querySelector('#nuAll').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  setVal(doc, '#nuPw', 'UiTest#1234');
  click(doc, '#nuGo'); await tick(500);
  ok(lastToast(doc).includes('Account created'), 'user created via UI', lastToast(doc));

  // add hospital via UI
  click(doc, '[data-go="hospitals"]'); await tick();
  click(doc, '#addHosp'); await tick();
  setVal(doc, '#hName', 'UI Live Hosp');
  setVal(doc, '#hDoc', 'Dr. UI');
  click(doc, '#hSave'); await tick(400);
  ok(doc.body.textContent.includes('UI Live Hosp'), 'hospital added via UI (live)');
}

/* fresh session: everything persisted + auto-resume via cookie */
console.log('— persistence & session resume —');
{
  // new DOM, no cookie: must stay at login
  const dom0 = makeDom(); await tick(300);
  ok(!dom0.window.document.querySelector('#app').classList.contains('on'), 'no cookie → stays on login');
}
{
  const dom = makeDom();
  const doc = dom.window.document;
  await tick(200);
  setVal(doc, '#loginEmail', 'bhagavan@yajnapharma.in');
  doc.querySelector('#loginPw').value = ADMIN_PW;
  click(doc, '#loginBtn'); await tick(600);
  ok(doc.querySelectorAll('.hosp-card').length === 4, 'new session: 4 hospitals persisted (incl UI Live Hosp)', doc.querySelectorAll('.hosp-card').length);
  [...doc.querySelectorAll('[data-open2]')].find(b => b.dataset.open2 === 'mithra').click(); await tick(200);
  const htabP = id => [...doc.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === id).click();
  htabP('vendors'); await tick(200);
  ok(doc.body.textContent.includes('UI Bulk Vendor') && doc.body.textContent.includes('Live Vendor One'), 'vendors persisted');
  ok(doc.body.textContent.includes('3,000'), 'payment persisted');
  htabP('reports'); await tick(200);
  ok(doc.querySelector('[data-sec="2"]').checked === false, 'report pref toggle persisted');
  htabP('entry'); await tick(200);
  ok(text(doc, '#entryBody').length > 0 && !!doc.querySelector('.chip-green'), "today's entry loads as saved");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
