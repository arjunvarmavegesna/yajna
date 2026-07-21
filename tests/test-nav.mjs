/* Tests: the collapsible side menu — a rail that keeps every target reachable */
import { JSDOM } from 'jsdom';
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 200) => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const mk = () => new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });

const dom = mk(), w = dom.window, doc = w.document;
await tick(400);
doc.querySelector('[data-quick="admin"]').click(); await tick(700);
const nav = () => [...doc.querySelectorAll('.nav-item')];
const collapsed = () => doc.body.classList.contains('nav-collapsed');

console.log('— the toggle —');
const t = doc.querySelector('#navToggle');
ok(!!t, 'there is a collapse button in the sidebar');
ok(!collapsed(), 'the menu starts expanded');
ok(t.getAttribute('aria-expanded') === 'true', 'and says so to a screen reader', t.getAttribute('aria-expanded'));
ok(/collapse/i.test(t.title), 'its label says what it will do', t.title);
t.click(); await tick(150);
ok(collapsed(), 'clicking it collapses the menu');
ok(t.getAttribute('aria-expanded') === 'false', 'aria-expanded follows');
ok(/expand/i.test(t.title), 'and the label flips to Expand', t.title);
t.click(); await tick(150);
ok(!collapsed(), 'clicking again expands it — it is a toggle, not a one-way door');

console.log('— collapsed, nothing becomes unreachable —');
t.click(); await tick(150);
ok(collapsed(), 'collapsed again');
ok(nav().length === 4, 'every menu item is still in the DOM', nav().length);
ok(nav().every(n => n.title), 'and every one carries a title — the icon is all there is to read', nav().map(n => n.title).join(','));
const settings = nav().find(n => n.dataset.go === 'settings');
settings.click(); await tick(300);
ok(w.eval('state.view') === 'settings', 'a rail icon still navigates');
ok(collapsed(), 'and the menu stays collapsed while you move around');
nav().find(n => n.dataset.go === 'hospitals').click(); await tick(300);
ok(w.eval('state.view') === 'hospitals', 'back to the hospitals list');
doc.querySelector('[data-open2]').click(); await tick(300);
ok(doc.querySelectorAll('[data-htab]').length > 0, 'opening a hospital still renders its tabs');
ok(collapsed(), 'still collapsed inside a hospital');

console.log('— the alert count survives as a dot —');
w.eval('db.notifications.push({id:"nv1",type:"variance",hid:"mithra",date:todayISO(),msg:"x",ts:Date.now(),read:false}); renderApp()');
await tick(200);
ok(!!doc.querySelector('.nav-item .badge'), 'the badge is still rendered when collapsed — it becomes a dot, it is not dropped');
ok(/unread/.test(nav()[0].title), 'and the count moves into the tooltip so it is not lost', nav()[0].title);

console.log('— the choice is remembered —');
ok(w.localStorage.getItem('yps_nav_collapsed') === '1', 'collapsing is written to localStorage', w.localStorage.getItem('yps_nav_collapsed'));
w.eval('renderApp()'); await tick(200);
ok(collapsed(), 'and a re-render restores it rather than springing back open');
t.click(); await tick(150);
ok(w.localStorage.getItem('yps_nav_collapsed') === '0', 'expanding is remembered too');
w.eval('renderApp()'); await tick(200);
ok(!collapsed(), 'and stays expanded');
// a browser that refuses localStorage must not break the menu
w.eval('Object.defineProperty(window, "localStorage", { get(){ throw new Error("blocked"); } });');
let threw = false;
try { w.eval('applyNavCollapsed(true); renderApp()'); } catch (e) { threw = true; }
await tick(200);
ok(!threw, 'a browser with storage blocked does not break the menu — the preference is just not kept');
ok(nav().length === 4, 'and the menu still renders', nav().length);

console.log('— the mobile bottom nav is untouched —');
const dom2 = mk(), w2 = dom2.window, doc2 = dom2.window.document;
await tick(400);
doc2.querySelector('[data-quick="admin"]').click(); await tick(700);
ok(doc2.querySelectorAll('#bottomnav .bn').length === 4, 'the bottom nav still carries every item', doc2.querySelectorAll('#bottomnav .bn').length);
doc2.querySelector('#navToggle').click(); await tick(150);
ok(doc2.querySelectorAll('#bottomnav .bn').length === 4, 'and collapsing the sidebar does not touch it — below 960px the sidebar is hidden anyway');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
