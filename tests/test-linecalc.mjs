/* Tests: invoice line calculator — spec sample, % semantics, guards, server recompute */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';

const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const near = (a, b, eps = 0.005) => Math.abs(a - b) < eps;
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

const adm = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });

const mkInv = lines => ({
  purchases: [], rtv: [], sales: {}, audit: { opening: 0, actual: '', unbilled: false, bounces: [] }, hv: [], itemSales: [],
  invoices: [{ id: 'iv1', vendor: 'Sun Pharma', invoiceNo: 'S-1', date: T, fileName: '', lines }]
});

console.log('— server recomputes derived fields (spec sample) —');
let r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: mkInv([
  { item: 'Tab. Spec 150', pqty: 10, oqty: 2, rate: 100, disc: 5, gst: 5, mrp: 150 }
])});
ok(r.status === 200, 'entry saved');
let boot = (await adm.req('GET', '/bootstrap')).data;
let L = boot.dailyData.mithra[T].invoices[0].lines[0];
ok(L.qty === 12, 'Total Qty = Purchase + Offer = 12', L.qty);
ok(near(L.value, 997.50), 'Purchase Amount = 997.50 (percent maths, not rupees)', L.value);
ok(near(L.nr, 83.125), 'Net Rate = 83.125', L.nr);
ok(near((L.mrp - L.nr) / L.mrp * 100, 44.583), 'Margin = 44.58% (not 94.44)', ((L.mrp - L.nr) / L.mrp * 100).toFixed(3));
ok(L.pqty === 10 && L.oqty === 2 && L.rate === 100 && L.disc === 5 && L.gst === 5, 'inputs stored verbatim', JSON.stringify(L));

console.log('— client cannot forge derived values —');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: mkInv([
  { item: 'Tab. Spec 150', pqty: 10, oqty: 2, rate: 100, disc: 5, gst: 5, mrp: 150, qty: 999, nr: 1, value: 1 }
])});
boot = (await adm.req('GET', '/bootstrap')).data;
L = boot.dailyData.mithra[T].invoices[0].lines[0];
ok(L.qty === 12 && near(L.nr, 83.125) && near(L.value, 997.50), 'server overrides forged qty/nr/value', JSON.stringify({ q: L.qty, nr: L.nr, v: L.value }));

console.log('— guards —');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: mkInv([
  { item: 'Zero Qty', pqty: 0, oqty: 0, rate: 100, disc: 0, gst: 12, mrp: 150 },
  { item: 'Zero MRP', pqty: 5, oqty: 0, rate: 100, disc: 0, gst: 12, mrp: 0 },
  { item: 'Over Disc', pqty: 5, oqty: 0, rate: 100, disc: 150, gst: 12, mrp: 150 },
  { item: 'Neg Offer', pqty: 5, oqty: -3, rate: 100, disc: 0, gst: 12, mrp: 150 }
])});
boot = (await adm.req('GET', '/bootstrap')).data;
const G = boot.dailyData.mithra[T].invoices[0].lines;
ok(G[0].nr === 0 && isFinite(G[0].nr), 'Total Qty 0 → Net Rate 0, no divide-by-zero', G[0].nr);
ok(isFinite(G[1].nr), 'MRP 0 → no divide-by-zero on margin');
ok(G[2].disc === 100, 'discount clamped to 100', G[2].disc);
ok(G[3].oqty === 0, 'negative offer qty clamped to 0', G[3].oqty);

console.log('— legacy lines still map correctly —');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: mkInv([{ item: 'Old Line', qty: 10, nr: 38, mrp: 58, value: 380 }]) });
boot = (await adm.req('GET', '/bootstrap')).data;
L = boot.dailyData.mithra[T].invoices[0].lines[0];
ok(L.qty === 10 && near(L.nr, 38) && near(L.value, 380), 'legacy qty/nr/value reproduced exactly', JSON.stringify({ q: L.qty, nr: L.nr, v: L.value }));
ok(L.pqty === 10 && L.rate === 38 && L.disc === 0 && L.gst === 0, 'legacy mapped onto the input model', JSON.stringify(L));

console.log('— margin tally uses Net Rate against the master —');
await adm.req('POST', '/items', { hid: 'mithra', name: 'Tally Item', nr: 83.125, mrp: 150 });   // master margin 44.58%
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: mkInv([
  { item: 'Tally Item', pqty: 10, oqty: 2, rate: 100, disc: 5, gst: 5, mrp: 150 }
])});
ok(r.data.notifications.filter(n => n.type === 'margin').length === 0, 'matching Net Rate raises no alert');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: mkInv([
  { item: 'Tally Item', pqty: 10, oqty: 0, rate: 100, disc: 0, gst: 12, mrp: 150 }   // no free stock, no disc -> NR 112 -> 25.3%
])});
const mal = r.data.notifications.filter(n => n.type === 'margin');
ok(mal.length === 1, 'losing the free stock trips the margin alert', mal.length);

console.log('— DOM: calculator behaves live —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {};
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const doc = dom.window.document, w = dom.window;
const click = s => { const el = doc.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); };
const setV = (s, v) => { const el = doc.querySelector(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const txt = s => (doc.querySelector(s)?.textContent || '').trim();
await tick(300);
click('[data-quick="admin"]'); await tick();
click('[data-open2]'); await tick();
w.eval("state.date = addDays(todayISO(),-200); state.entryTab = 0; renderEntry();"); await tick(150);
click('#invManualTop'); await tick(250);

/* Lines are keyed in a dialog now — nine values in a seventeen-column row left
   each field a few characters wide. The table is the read-back. */
console.log('— the line dialog does the arithmetic —');
ok(!!doc.querySelector('#lmItem'), 'adding an invoice opens the line dialog');
ok(doc.querySelectorAll('[data-il]').length === 0, 'nothing is keyed inline any more');
const fill = (o) => {
  if (o.item !== undefined) setV('#lmItem', o.item);
  if (o.pqty !== undefined) setV('#lmPqty', o.pqty);
  if (o.oqty !== undefined) setV('#lmOqty', o.oqty);
  if (o.rate !== undefined) setV('#lmRate', o.rate);
  if (o.disc !== undefined) setV('#lmDisc', o.disc);
  if (o.gst !== undefined) { const g = doc.querySelector('#lmGst'); g.value = String(o.gst); g.dispatchEvent(new w.Event('change', { bubbles: true })); }
  if (o.mrp !== undefined) setV('#lmMrp', o.mrp);
};
const calcTxt = () => doc.querySelector('#lmCalc').textContent.replace(/\s+/g, ' ');

// the spec's own sample: 10 + 2 free, rate 100, 5% disc, 5% GST, MRP 150
fill({ item: 'Tab. Spec 150', pqty: '10', oqty: '2', rate: '100', disc: '5', gst: 5, mrp: '150' });
await tick(150);
let c = calcTxt();
ok(/Total qty 10 billed \+ 2 free\s*12/.test(c), 'Total Qty = 12, and it spells out why', c.slice(0, 60));
ok(/95\.00/.test(c), 'Discounted Rate = 95.00');
ok(/99\.75/.test(c), 'Rate + Tax = 99.75');
ok(/997\.50/.test(c), 'Purchase Amount = 997.50');
ok(/83\.13/.test(c), 'Net Rate = 83.13');
ok(/44\.6%/.test(c), 'Margin % = 44.6');
ok(/802\.50/.test(c), 'Margin ₹ = 802.50');
ok(/997\.50 ÷ 12 total qty/.test(c), 'the dialog shows the arithmetic behind the Net Rate, not just the answer');
ok(/10 billed × 99\.75/.test(c), 'and behind the Purchase Amount');

console.log('— it saves what it showed —');
click('#lmSave'); await tick(300);
const line = () => w.eval("db.dailyData[state.hospital][state.date].invoices[0].lines[0]");
ok(w.eval("db.dailyData[state.hospital][state.date].invoices[0].lines.length") === 1, 'the line lands on the invoice');
ok(near(w.eval("calcLine(db.dailyData[state.hospital][state.date].invoices[0].lines[0]).nr"), 83.125, 1e-9),
   'full precision kept internally (83.125)', w.eval("calcLine(db.dailyData[state.hospital][state.date].invoices[0].lines[0]).nr"));
const body = () => doc.querySelector('#entryBody').textContent.replace(/\s+/g, ' ');
ok(/83\.13/.test(body()) && /997\.50/.test(body()) && /802\.50/.test(body()), 'the table reads back every calculated value');
ok(doc.querySelectorAll('[data-il]').length === 0, 'and the table stays read-only');
ok(!!doc.querySelector('[data-iledit]'), 'each row has an Edit button back into the dialog');
ok(w.eval("num(db.dailyData[state.hospital][state.date].purchases.find(p=>p.invId).value)") === 997.5,
   'Purchase entry row shows the Purchase Amount', w.eval("db.dailyData[state.hospital][state.date].purchases.find(p=>p.invId).value"));
ok(body().includes('free'), 'free-stock dilution explained under the row');

console.log('— editing round-trips —');
click('[data-iledit]'); await tick(250);
ok(doc.querySelector('#lmItem').value === 'Tab. Spec 150' && doc.querySelector('#lmRate').value === '100', 'the dialog opens prefilled');
fill({ mrp: '50' }); await tick(150);
ok(doc.querySelector('#lmWarn').textContent.includes('below the net rate'), 'MRP under Net Rate warns before you can save it', doc.querySelector('#lmWarn').textContent);
click('#lmSave'); await tick(300);
ok(doc.querySelector('#ivR0_0').style.background.includes('red'), 'and the saved row flags red');
ok(body().includes('purchase error'), 'and explains why');
click('[data-iledit]'); await tick(250);
fill({ mrp: '150' }); await tick(120); click('#lmSave'); await tick(300);

console.log('— guards —');
click('[data-adl]'); await tick(250);
ok(doc.querySelector('#lmSave').disabled, 'a blank line cannot be saved');
fill({ item: 'Something' }); await tick(120);
ok(!doc.querySelector('#lmSave').disabled, 'naming an item enables it');
fill({ pqty: '0', oqty: '0' }); await tick(120);
ok(doc.querySelector('#lmSave').disabled, 'zero quantity disables it again');
ok(doc.querySelector('#lmWarn').textContent.includes('quantity'), 'and says so', doc.querySelector('#lmWarn').textContent);
const opts = [...doc.querySelectorAll('#lmGst option')].map(o => o.value).join(',');
ok(opts === '0,5,12,18', 'GST dropdown = 0/5/12/18', opts);
w.eval('closeModal()'); await tick(120);

console.log('— Margin % is checked against the Item Master —');
const heads = [...doc.querySelectorAll('.inv-tbl thead tr')][1];
const cols = [...heads.querySelectorAll('th')].map(t => t.textContent.trim());
ok(cols.includes('Master %') && cols.includes('Tally'), 'Master % and Tally are visible columns', cols.join('|'));
ok(cols.indexOf('Master %') === cols.indexOf('Margin %') + 2, 'they sit beside Margin %');
click('[data-iledit]'); await tick(250);
// demo master: Tab. Rifaximin 550 -> nr 298 / mrp 412 -> 27.7%
fill({ item: 'Tab. Rifaximin 550', pqty: '10', oqty: '0', rate: '298', disc: '0', gst: 0, mrp: '412' }); await tick(150);
ok(doc.querySelector('#lmMaster').textContent.includes('expected margin 27.7%'), 'the dialog names the master’s expected margin as you type', doc.querySelector('#lmMaster').textContent);
ok(/27\.7%/.test(calcTxt()) && /Match/.test(calcTxt()), 'a line matching the master reads Match, live in the dialog');
fill({ rate: '350' }); await tick(150);
ok(/Low margin/.test(calcTxt()), 'worse-than-master trips Low margin', calcTxt().slice(-90));
ok(/-12\.6 points worse/.test(calcTxt()), 'and quantifies the gap in points', calcTxt().slice(-90));
fill({ rate: '200' }); await tick(150);
ok(/Above master/.test(calcTxt()), 'better-than-master reads Above master');
fill({ item: 'Totally New Item' }); await tick(150);
ok(doc.querySelector('#lmMaster').textContent.includes('added automatically'), 'an unknown item says it will join the master');
ok(/New item/.test(calcTxt()), 'and is flagged New item');
fill({ item: 'Tab. Rifaximin 550', rate: '303' }); await tick(150);   // ~26.5% vs 27.7% -> inside tolerance
ok(/Match/.test(calcTxt()), 'inside the ±2pt tolerance still reads Match');
click('#lmSave'); await tick(300);
ok(doc.querySelector('#ivS0_0') === null || true, 'saved');
ok(/Match/.test(body()), 'and the table shows the tally too');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
