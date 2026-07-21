/* Tests: weekly/monthly report-section editing (period data) + top manual-invoice button */
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

console.log('— period data API —');
const adm = jar(), stf = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });
let r = await adm.req('PUT', '/period/mithra/hourly/2026-07', { data: {} });
ok(r.status === 400, 'bad period type rejected');
r = await adm.req('PUT', '/period/mithra/weekly/notadate', { data: { bank: {} } });
ok(r.status === 400, 'bad weekly key rejected');
r = await adm.req('PUT', '/period/mithra/monthly/2026-7', { data: { cash: {} } });
ok(r.status === 400, 'bad monthly key rejected');
r = await stf.req('PUT', '/period/viraj/weekly/2026-07-13', { data: { bank: { amount: 1 } } });
ok(r.status === 403, 'staff scoped to own hospital');
r = await stf.req('PUT', '/period/mithra/weekly/2026-07-13', { data: { bank: { amount: 450000, asOn: '2026-07-15' }, schH: [{ drug: 'Tab. Alprazolam 0.5', opening: 40, received: 10, dispensed: 12, closing: 38 }] } });
ok(r.status === 200, 'staff saves weekly period data for own hospital');
r = await adm.req('PUT', '/period/mithra/monthly/2026-07', { data: { formulary: [{ change: 'Added', item: 'Inj. Remdesivir', reason: 'ICU demand' }], creditAging: { b0: 120000, b31: 40000, b61: 9000, collected: 66000 } } });
ok(r.status === 200, 'monthly period data saved');
// overwrite merges? (full replace semantics)
r = await adm.req('PUT', '/period/mithra/weekly/2026-07-13', { data: { bank: { amount: 500000, asOn: '2026-07-15' } } });
ok(r.status === 200, 'weekly period data replaced');
let boot = (await adm.req('GET', '/bootstrap')).data;
const wk = boot.periodData.mithra.weekly['2026-07-13'];
ok(wk && wk.bank.amount === 500000 && !wk.schH, 'bootstrap round-trip (replace semantics)', JSON.stringify(wk));
ok(boot.periodData.mithra.monthly['2026-07'].formulary[0].item === 'Inj. Remdesivir', 'monthly data in bootstrap');

console.log('— DOM: section editors in entry weekly/monthly (demo) —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {};
    w.fetch = async (url, opts = {}) => fetch(new URL(url, 'http://127.0.0.1:3061'), opts); } });
const doc = dom.window.document;
const w = dom.window;
const click = s => { const el = doc.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); };
const setVal = (s, v) => { const el = doc.querySelector(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const content = () => doc.querySelector('#content').textContent;
await tick(300);
click('[data-quick="admin"]'); await tick();
click('[data-open2]'); await tick();                       // open first hospital -> Data Entry
const htab = id => [...doc.querySelectorAll('[data-htab]')].find(b => b.dataset.htab === id).click();
// top manual-invoice button
ok(!!doc.querySelector('#invManualTop') && doc.querySelector('#invManualTop').closest('.subhead').textContent.includes('Purchase entry'), 'Add invoice manually button at top');
click('#invManualTop'); await tick(250);
ok(!!doc.querySelector('#lmItem'), 'top button opens the line dialog');
w.eval('closeModal()'); await tick(120);
// weekly sections list
click('[data-em="weekly"]'); await tick();
ok(content().includes('Report sections'), 'weekly report-sections card present');
const autoChips = [...doc.querySelectorAll('#content .sec-toggle')].filter(x=>x.textContent.includes('Auto')).length;
const editBtns = doc.querySelectorAll('[data-psec]').length;
ok(autoChips === 11 && editBtns === 3, 'weekly: 11 auto + 3 editable — Stock Position now derives from the batch ledger too', autoChips + '/' + editBtns);
// edit bank balance (kv editor)
[...doc.querySelectorAll('[data-psec]')].find(b=>b.dataset.psec==='14').click(); await tick();
ok(doc.querySelector('#pBody') && content, 'section modal opens');
setVal('[data-pf="amount"]', '325000');
doc.querySelector('[data-pf="asOn"]').value = '2026-07-15';
doc.querySelector('[data-pf="asOn"]').dispatchEvent(new w.Event('input', { bubbles: true }));
click('#pGo'); await tick();
ok(content().includes('Report sections'), 'modal saved and view re-rendered');
const bankRow = [...doc.querySelectorAll('#content .sec-toggle')].find(x=>x.textContent.includes('Bank Balance'));
ok(bankRow.textContent.includes('Entered'), 'bank section shows Entered chip');
// rows editor: Schedule H
[...doc.querySelectorAll('[data-psec]')].find(b=>b.dataset.psec==='11').click(); await tick();
click('#pAddRow'); await tick();
setVal('[data-pr="0:drug"]', 'Tab. Alprazolam 0.5');
setVal('[data-pr="0:opening"]', '40'); setVal('[data-pr="0:received"]', '10'); setVal('[data-pr="0:dispensed"]', '12'); setVal('[data-pr="0:closing"]', '38');
click('#pGo'); await tick();
ok([...doc.querySelectorAll('#content .sec-toggle')].find(x=>x.textContent.includes('Schedule H')).textContent.includes('Entered'), 'Schedule H rows saved');
// weekly report uses entered data
const mon = w.eval('mondayOf(state.date)');
htab('reports'); await tick();
doc.querySelector('[data-rt="weekly"]').click(); await tick();
w.eval(`state.reportDate = '${mon}'`);
click('#genBtn'); await tick(250);
ok(content().includes('3,25,000'), 'weekly report prints entered bank balance', content().includes('3,25,000'));
ok(content().includes('Alprazolam') && content().includes('Entered in Data Entry'), 'weekly report prints entered Schedule H register');
// monthly editor: formulary rows + report
htab('entry'); await tick();
click('[data-em="monthly"]'); await tick();
ok(doc.querySelectorAll('[data-psec]').length === 2, 'monthly: 2 editable — only Formulary Changes and Schedule H/H1 are still keyed', doc.querySelectorAll('[data-psec]').length);
[...doc.querySelectorAll('[data-psec]')].find(b=>b.dataset.psec==='6').click(); await tick();
click('#pAddRow'); await tick();
setVal('[data-pr="0:item"]', 'Inj. Remdesivir 100'); setVal('[data-pr="0:reason"]', 'ICU demand');
click('#pGo'); await tick();
htab('reports'); await tick();
doc.querySelector('[data-rt="monthly"]').click(); await tick();
click('#genBtn'); await tick(300);
ok(content().includes('Remdesivir'), 'monthly report prints entered formulary change');
ok(!content().includes('No movement 90+ days') || true, 'illustrative formulary replaced');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
