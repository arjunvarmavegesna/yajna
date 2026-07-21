/* Tests: manual invoice is the only path, and it auto-fills the Purchase entry row */
import { JSDOM } from 'jsdom';
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 90) => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {};
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const doc = dom.window.document, w = dom.window;
const click = s => { const el = doc.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); };
const setV = (s, v) => { const el = doc.querySelector(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const entry = () => JSON.parse(w.eval('JSON.stringify(db.dailyData[state.hospital][state.date])'));

await tick(300);
click('[data-quick="admin"]'); await tick();
click('[data-open2]'); await tick();          // open a hospital -> Data Entry
// work on today so nothing is locked
w.eval("state.date = addDays(todayISO(),-200); state.entryTab = 0; renderEntry();"); await tick(150);  // clean, unsaved day

console.log('— only manual entry remains —');
ok(!doc.querySelector('#invUpload'), 'no Upload invoice button');
ok(!!doc.querySelector('#invManualTop'), 'Add invoice manually present');
ok(typeof w.eval('typeof invoiceUploadModal') === 'string' && w.eval('typeof invoiceUploadModal') === 'undefined', 'upload modal code removed');
ok(doc.querySelector('#invManualTop').closest('.subhead').textContent.includes('Purchase entry'), 'button sits in the Purchase entry header');

console.log('— manual invoice fills the purchase row —');
const before = entry().purchases.length;
click('#invManualTop'); await tick(250);
let e = entry();
ok(e.invoices.length === 1 && !!e.invoices[0].id, 'invoice created with an id');
ok(e.invoices[0].lines.length === 0, 'and starts with no lines — the dialog opens instead of a blank row');
ok(!!doc.querySelector('#lmItem'), 'the line dialog opens straight away');
const linked = e.purchases.filter(p => p.invId === e.invoices[0].id);
ok(linked.length === 1, 'exactly one purchase row is linked to it', JSON.stringify(e.purchases));
ok(e.purchases.length === before, 'blank starter row was reused, not duplicated', before + '->' + e.purchases.length);

// key the first line through the dialog
const fill = (o) => {
  if (o.item !== undefined) setV('#lmItem', o.item);
  if (o.pqty !== undefined) setV('#lmPqty', o.pqty);
  if (o.rate !== undefined) setV('#lmRate', o.rate);
  if (o.gst !== undefined) { const g = doc.querySelector('#lmGst'); g.value = String(o.gst); g.dispatchEvent(new w.Event('change', { bubbles: true })); }
  if (o.mrp !== undefined) setV('#lmMrp', o.mrp);
};
fill({ item: 'Tab. Rifaximin 550', pqty: '10', rate: '300', gst: 0, mrp: '412' }); await tick(150);
click('#lmSave'); await tick(300);

setV('[data-iv="0:vendor"]', 'Sun Pharma Distributors'); await tick(150);
ok(entry().purchases.find(p => p.invId).vendor === 'Sun Pharma Distributors', 'vendor flows to the purchase row');
let row = entry().purchases.find(p => p.invId);
ok(row.value === 3000, 'Purchase Amount flows to the purchase row', row.value);
ok(row.items === 1, 'item count flows', row.items);
ok(doc.querySelector('#purchTotal').textContent.includes('3,000'), 'Total purchases reflects it', doc.querySelector('#purchTotal').textContent);
const li = () => entry().purchases.findIndex(p => p.invId);

// a second line, via Save & add another
click('[data-adl="0"]'); await tick(250);
fill({ item: 'Inj. Ceftriaxone 1g', pqty: '5', rate: '40', gst: 0, mrp: '66' }); await tick(150);
click('#lmSave'); await tick(300);
row = entry().purchases.find(p => p.invId);
ok(row.value === 3200 && row.items === 2, 'second line adds in (3000 + 200, 2 items)', JSON.stringify({ v: row.value, i: row.items }));
ok(doc.querySelector('#purchTotal').textContent.includes('3,200'), 'total updates live');
ok(doc.querySelectorAll('[data-iledit]').length === 2, 'both rows are read-only with an Edit button');

console.log('— derived row is read-only —');
const ix = li();
const vIn = doc.querySelector(`[data-p="${ix}:vendor"]`);
ok(vIn.disabled, 'linked purchase row is not hand-editable');
ok(doc.querySelector('#purchTbl').textContent.includes('from invoice'), 'row is labelled "from invoice"');
ok(!doc.querySelector(`[data-pdel="${ix}"]`), 'linked row has no delete button (delete the invoice instead)');

console.log('— deleting the invoice removes its row —');
click('[data-ivdel="0"]'); await tick(150);
e = entry();
ok(e.invoices.length === 0, 'invoice gone');
ok(e.purchases.filter(p => p.invId).length === 0, 'its purchase row gone too');
ok(e.purchases.length === 1, 'a blank row is left to type into', JSON.stringify(e.purchases));
ok(doc.querySelector('#purchTotal').textContent.includes('0'), 'total back to zero');

console.log('— manual (non-invoice) purchase rows still work —');
click('#addPurch'); await tick(120);
const rows = doc.querySelectorAll('#purchTbl tbody tr').length;
ok(rows === 2, 'plain vendor rows can still be added', rows);
ok(!doc.querySelector('[data-p="1:vendor"]').disabled, 'plain rows stay editable');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
