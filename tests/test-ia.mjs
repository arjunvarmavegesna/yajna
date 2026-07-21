/* Tests: hospital-first IA, 3-item menu, users & roles, multi-hospital access, portal on/off */
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

console.log('— migration + access model —');
const adm = jar();
let r = await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
ok(r.status === 200 && r.data.user.allHospitals === true && r.data.user.active === true, 'admin migrated to allHospitals + active', JSON.stringify(r.data.user));
let boot = (await adm.req('GET', '/bootstrap')).data;
ok(Object.keys(boot.hospitals).length === 3, 'admin sees all 3 hospitals');
const staffRow = boot.userList.find(u => u.email === 'staff.mithra@yajnapharma.in');
ok(staffRow && !staffRow.allHospitals && staffRow.hospitals.join() === 'mithra', 'seeded staff migrated to ["mithra"]', JSON.stringify(staffRow && staffRow.hospitals));

console.log('— multi-hospital grant —');
r = await adm.req('POST', '/users', { name: 'Multi User', email: 'multi@yajnapharma.in', role: 'admin', hospitals: ['mithra', 'viraj'], password: 'MultiPass#123' });
ok(r.status === 200 && r.data.user.hospitals.length === 2, 'user created with 2 hospitals');
const multiId = r.data.user.uid;
const multi = jar();
await multi.req('POST', '/login', { email: 'multi@yajnapharma.in', password: 'MultiPass#123' });
boot = (await multi.req('GET', '/bootstrap')).data;
ok(Object.keys(boot.hospitals).sort().join() === 'mithra,viraj', 'multi user bootstrap scoped to their 2 hospitals', Object.keys(boot.hospitals).join());
r = await multi.req('PUT', '/entries/siri/2026-07-10', { entry: { purchases: [], rtv: [], sales: {}, audit: {}, hv: [] } });
ok(r.status === 403, 'blocked from a hospital they were not granted');
r = await multi.req('PUT', '/entries/viraj/2026-07-10', { entry: { purchases: [], rtv: [], sales: { mrp: 100, cogs: 60 }, audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [] } });
ok(r.status === 200, 'allowed on a granted hospital');

console.log('— validation —');
r = await adm.req('POST', '/users', { name: 'X', email: 'x@y.in', role: 'user', hospitals: [], password: 'LongEnough1' });
ok(r.status === 400, 'no hospitals rejected');
r = await adm.req('POST', '/users', { name: 'X', email: 'x@y.in', role: 'user', hospitals: ['nope'], password: 'LongEnough1' });
ok(r.status === 400, 'unknown hospital rejected');
r = await adm.req('POST', '/users', { name: 'X', email: 'x@y.in', role: 'user', hospitals: ['*'], password: 'LongEnough1' });
ok(r.status === 200 && r.data.user.allHospitals, 'wildcard grant accepted');
const wildId = r.data.user.uid;

console.log('— portal access on/off —');
r = await adm.req('PATCH', '/users/' + multiId, { active: false });
ok(r.status === 200 && r.data.user.active === false, 'portal access revoked');
r = await multi.req('GET', '/bootstrap');
ok(r.status === 401, 'revoked user session killed immediately');
const multi2 = jar();
r = await multi2.req('POST', '/login', { email: 'multi@yajnapharma.in', password: 'MultiPass#123' });
ok(r.status === 403 && /turned off/i.test(r.data.error), 'revoked user cannot log in', r.data.error);
r = await adm.req('PATCH', '/users/' + multiId, { active: true });
ok(r.status === 200 && r.data.user.active, 'access restored');
const multi3 = jar();
r = await multi3.req('POST', '/login', { email: 'multi@yajnapharma.in', password: 'MultiPass#123' });
ok(r.status === 200, 'restored user can log in again');

console.log('— lockout guards —');
r = await adm.req('PATCH', '/users/u-admin', { active: false });
ok(r.status === 400 && /your own/i.test(r.data.error), 'cannot disable own access', r.data.error);
r = await adm.req('PATCH', '/users/u-admin', { role: 'user' });
ok(r.status === 400, 'cannot change own role');
r = await adm.req('DELETE', '/users/u-admin');
ok(r.status === 400, 'cannot delete own account');
// promote another admin, then last-admin guard should relax
await adm.req('PATCH', '/users/' + wildId, { role: 'admin' });
r = await adm.req('DELETE', '/users/' + wildId);
ok(r.status === 200, 'admin can delete another admin when >1 exists');
r = await adm.req('DELETE', '/users/' + multiId);
ok(r.status === 200, 'user deleted');

console.log('— scope change kills sessions —');
const s2 = jar();
await s2.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });
ok((await s2.req('GET', '/bootstrap')).status === 200, 'staff session live');
await adm.req('PATCH', '/users/u-staff-mithra', { hospitals: ['viraj'] });
ok((await s2.req('GET', '/bootstrap')).status === 401, 'changing a user scope signs them out');

console.log('— DOM: hospital-first navigation (demo) —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const mk = () => {
  let cookie = '';
  return new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {}; w.confirm = () => true;
      w.fetch = async (url, opts = {}) => {
        const res = await fetch(new URL(url, 'http://127.0.0.1:3061'), {
          method: opts.method || 'GET',
          headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) },
          body: opts.body
        });
        const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
        return res;
      }; } });
};
let dom = mk(), doc = dom.window.document;
const click = s => { const el = doc.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); };
const content = () => doc.querySelector('#content').textContent;
const navIds = () => [...doc.querySelectorAll('#sideNav .nav-item')].map(b => b.dataset.go);
await tick(300);
click('[data-quick="admin"]'); await tick();
ok(navIds().join() === 'hospitals,master,users,settings', 'admin menu is Hospitals / All-companies master / Users & Roles / Settings', navIds().join());
ok(doc.querySelectorAll('.hosp-card').length === 3, 'hospitals list is the landing page');
ok(doc.querySelector('#hospHeader').innerHTML === '', 'no workspace header on the list');
ok(!!doc.querySelector('#addHosp'), 'admin can add a hospital from the list');
// open a hospital -> tabs appear
doc.querySelector('[data-open2]').click(); await tick();
const tabs = [...doc.querySelectorAll('[data-htab]')].map(b => b.dataset.htab);
ok(tabs.join() === 'entry,history,inventory,receivables,items,offers,reports,vendors,alerts,clear', 'opening a hospital reveals all the tabs', tabs.join());
ok(!!doc.querySelector('#hhBack'), 'back to all hospitals available');
ok(!!doc.querySelector('#entryBody'), 'lands on Data Entry');
ok(!doc.querySelector('#entryHosp'), 'per-page hospital picker removed (workspace defines it)');
// tab switching
[...doc.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === 'reports').click(); await tick();
ok(content().includes('Sections'), 'Reports tab opens inside the hospital');
[...doc.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === 'vendors').click(); await tick();
ok(content().includes('outstanding'), 'Vendors tab opens');
[...doc.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === 'alerts').click(); await tick();
ok(!doc.querySelector('#alertHosp'), 'alerts hospital filter gone (scoped to this hospital)');
// back out
click('#hhBack'); await tick();
ok(doc.querySelectorAll('.hosp-card').length === 3 && doc.querySelector('#hospHeader').innerHTML === '', 'back returns to the hospital list');
// users tab (demo shows a notice)
click('[data-go="users"]'); await tick();
ok(content().includes('demo mode'), 'Users & Roles explains demo limitation');
// settings no longer carries team accounts
click('[data-go="settings"]'); await tick();
ok(!content().includes('Team accounts'), 'team accounts removed from Settings');

console.log('— DOM: staff with one hospital —');
dom = mk(); doc = dom.window.document;
await tick(300);
doc.querySelector('[data-quick="staff"]').click(); await tick();
ok(navIds().join() === 'hospitals,settings', 'staff menu has no Users & Roles', navIds().join());
ok(!!doc.querySelector('#entryBody'), 'single-hospital user drops straight into their hospital');
const stabs = [...doc.querySelectorAll('[data-htab]')].map(b => b.dataset.htab);
ok(!stabs.includes('vendors'), 'staff sees no Vendors tab', stabs.join());
ok(!doc.querySelector('#hhBack'), 'no back button when only one hospital');

console.log('— DOM: live admin -> real Users & Roles —');
dom = mk(); doc = dom.window.document;
await tick(300);
const setV = (s, v) => { const el = doc.querySelector(s); el.value = v; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
setV('#loginEmail', 'bhagavan@yajnapharma.in');
doc.querySelector('#loginPw').value = ADMIN_PW;
click('#loginBtn'); await tick(600);
click('[data-go="users"]'); await tick(200);
ok(doc.querySelectorAll('[data-uedit]').length >= 2, 'live user list renders');
ok(!!doc.querySelector('[data-uact]'), 'portal access toggle present');
ok(content().includes('Role') && content().includes('Hospitals') && content().includes('Portal access'), 'columns: role / hospitals / portal access');
click('#addUser'); await tick();
ok(doc.querySelectorAll('.nuh').length === 3, 'add-user modal lists all hospitals as checkboxes');
ok(!!doc.querySelector('#nuAll'), 'all-hospitals switch present');
setV('#nuName', 'DOM Test User'); setV('#nuEmail', 'domtest@yajnapharma.in'); setV('#nuPw', 'DomTest#1234');
doc.querySelectorAll('.nuh')[0].checked = true;
click('#nuGo'); await tick(500);
ok(content().includes('DOM Test User'), 'user created through the UI');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
