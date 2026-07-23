/* Tests: the sales upload projects its effect on the shelf BEFORE it is
   applied — stock now / this report sells / stock after, reconciling
   exactly — and names which rows won't deduct cleanly: not found on the
   Item Master (nothing to deduct from) vs. matched but would go negative
   (a symptom, not a stock level) vs. the clean majority. Client-side
   computation (stockAsOf), so this is DOM-only, no live server needed for
   the core mechanics; one end-to-end pass drives the real modal. */
import { JSDOM } from 'jsdom';
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 100) => new Promise(r => setTimeout(r, ms));
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null; w.confirm = () => true;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const w = dom.window, doc = w.document;
await tick(400);
doc.querySelector('[data-quick="admin"]').click(); await tick(700);

console.log('— the clean case: matched, stays non-negative, nothing to flag —');
w.eval(`
  db.items.viraj = [{id:'si1', name:'Tab. Clean Item', key:nameKey('Tab. Clean Item'), pack:'10s', nr:10, mrp:20, openingQty:100, source:'demo', updatedAt:Date.now()}];
  db.hospitals.viraj.stockDate = addDays(todayISO(),-30);
  db.adjustments.viraj=[]; db.dailyData.viraj={};
`);
let impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [{item:'Tab. Clean Item', qty:20, cost:200}], addDays(todayISO(),-1))))`);
ok(impact.clean.length===1 && impact.notFound.length===0 && impact.negative.length===0, 'a matched, well-stocked sale is entirely clean', JSON.stringify(impact));
ok(impact.stockNowItems===1 && impact.stockNowValue===1000, 'stock now: 100 strips @ nr10 = 1000', JSON.stringify(impact));
ok(impact.reportItems===1 && impact.reportStrips===20 && impact.reportCogs===200, 'report sells: 1 item, 20 strips, cogs 200', JSON.stringify(impact));
ok(impact.stockAfterValue === impact.stockNowValue - impact.reportCogs, 'stock after reconciles EXACTLY: 1000 - 200 = 800', impact.stockAfterValue);

console.log('— sold, but not in inventory: nothing to deduct from —');
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [
  {item:'Tab. Clean Item', qty:5, cost:50},
  {item:'PAN 40 TAB (typo of PAN-40 TAB)', qty:8, cost:80}
], addDays(todayISO(),-1))))`);
ok(impact.clean.length===1 && impact.notFound.length===1 && impact.notFound[0]==='PAN 40 TAB (typo of PAN-40 TAB)', 'the unmatched name is named, separately from the clean one', JSON.stringify(impact));
ok(impact.negative.length===0, 'and it is NOT counted as negative — it never reached a real lot at all');

console.log('— sold more than you have: a symptom, named with the exact numbers —');
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [{item:'Tab. Clean Item', qty:150, cost:1500}], addDays(todayISO(),-1))))`);
ok(impact.negative.length===1 && impact.negative[0].name==='Tab. Clean Item', 'selling 150 of 100 on hand goes negative', JSON.stringify(impact));
ok(impact.negative[0].have===100 && impact.negative[0].selling===150, 'both figures are exact — this is diagnosable, not just a flag', JSON.stringify(impact.negative[0]));
ok(impact.clean.length===0, 'and it is not ALSO counted as clean — the buckets are mutually exclusive');

console.log('— two lines for the SAME item are summed before the check — a cumulative shortfall is still caught —');
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [
  {item:'Tab. Clean Item', qty:60, cost:600},
  {item:'Tab. Clean Item', qty:60, cost:600}
], addDays(todayISO(),-1))))`);
ok(impact.reportItems===1, 'two rows for one product count as ONE item in the report tally', impact.reportItems);
ok(impact.negative.length===1 && impact.negative[0].selling===120, '60+60=120 against 100 on hand — the CUMULATIVE draw goes negative, even though neither line alone would', JSON.stringify(impact.negative));

console.log('— all three buckets in one file, and they still add up —');
w.eval(`
  db.items.viraj.push({id:'si2', name:'Tab. Second Item', key:nameKey('Tab. Second Item'), pack:'15s', nr:8, mrp:14, openingQty:10, source:'demo', updatedAt:Date.now()});
`);
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [
  {item:'Tab. Clean Item', qty:10, cost:100},
  {item:'Tab. Second Item', qty:25, cost:200},
  {item:'Ghost Product', qty:3, cost:30}
], addDays(todayISO(),-1))))`);
ok(impact.clean.length===1 && impact.negative.length===1 && impact.notFound.length===1, 'one of each, from three rows', JSON.stringify({clean:impact.clean,negative:impact.negative,notFound:impact.notFound}));
ok(impact.clean.length+impact.negative.length+impact.notFound.length === impact.reportItems, 'the three buckets sum to exactly the report item count — nothing uncounted');

console.log('— renderStockImpact: the reconciliation reads as arithmetic, and buckets are named —');
const rendered = w.eval(`renderStockImpact(salesStockImpact('viraj', [
  {item:'Tab. Clean Item', qty:10, cost:100},
  {item:'Tab. Second Item', qty:25, cost:200},
  {item:'Ghost Product', qty:3, cost:30}
], addDays(todayISO(),-1)))`);
ok(/Stock now/.test(rendered) && /This report sells/.test(rendered) && /Stock after/.test(rendered), 'before, this-report, and after all appear');
ok(/−/.test(rendered) && /=/.test(rendered), 'the after-value is shown as a subtraction, not just asserted', rendered.match(/\([^)]*=[^)]*\)/)?.[0]);
ok(/not found in inventory/i.test(rendered) && /would go negative/i.test(rendered), 'both problem buckets are called out by name in the summary line');
ok(/Ghost Product/.test(rendered) && /Tab\. Second Item/.test(rendered), 'and the actual offending names are listed below, not just counted', rendered.includes('Ghost Product'));

console.log('— the modal: the preview shows the shelf impact BEFORE anything is staged, and confirms it again after —');
// gpUploadModal refuses to open in demo mode ("live mode only") — flip the
// flag now that the seeded db.* data is in place; apiUpload is monkey-patched
// below so nothing here actually depends on a real network round trip
w.eval(`state.demo = false;`);
doc.querySelector('[data-open2]').click(); await tick(250);
w.eval(`state.date=todayISO(); state.entryTab=1; state.entryMode="daily"; renderHospitalWorkspace();`); await tick(300);
// monkey-patch apiUpload for this one call — a controlled, deterministic parse
// response, matching this suite's live-HTTP siblings' style of testing the
// PARSE layer directly rather than fighting jsdom's file-input support
w.eval(`
  window.__realApiUpload = apiUpload;
  window.apiUpload = async () => ({
    source:'template', sheet:'Sales', salesMrp: 400, cogs: 300, cash:0, credit:0,
    rejected:[], tabletsCol:true, grossProfit:100, marginPct: 25,
    fileName:'x.xlsx', fileRows:2, parsed:2, imported:2, skipped:[], ignored:0, cautions:[],
    note:'Read 2 rows from the template (sheet "Sales")',
    items:[
      {row:1, item:'Tab. Clean Item', pack:'10s', qty:10, nr:10, mrp:20, unit:'strips', srcStrips:10, srcLoose:0, amount:200, cost:100, marginPct:50},
      {row:2, item:'Ghost Product 2', pack:'', qty:20, nr:10, mrp:20, unit:'strips', srcStrips:20, srcLoose:0, amount:400, cost:200, marginPct:50}
    ]
  });
`);
doc.querySelector('#gpBtn').click(); await tick(200);
ok(!!doc.querySelector('#gpFile'), 'the file input exists');
// the parse handler bails out before even calling apiUpload unless a file is
// actually selected — fake one on so the monkey-patched apiUpload gets reached
const fakeFile = new w.File(['dummy'], 'sales.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
Object.defineProperty(doc.querySelector('#gpFile'), 'files', { value: [fakeFile], configurable: true });
doc.querySelector('#gpParse').click(); await tick(300);
let body = doc.querySelector('#gpPrev').textContent;
ok(/What this does to the shelf/.test(body), 'the shelf-impact section renders in the preview, before anything is saved', body.slice(0,200));
ok(/not found in inventory/i.test(body) && /Ghost Product 2/.test(body), 'the unmatched row from this parse is named, before commit', body.includes('Ghost Product 2'));
ok(!doc.querySelector('#gpContinue'), 'still just a preview — no confirmation step yet, nothing staged');
doc.querySelector('#gpApply').click(); await tick(200);
body = doc.querySelector('#gpPrev').textContent;
ok(/Staged/.test(body) && /What this does to the shelf/.test(body), 'clicking Fill & Apply shows the SAME shelf-impact summary as confirmation', body.slice(0,150));
ok(!!doc.querySelector('#gpContinue'), 'and offers to continue rather than silently vanishing');
const staged = w.eval(`JSON.parse(JSON.stringify(getDraft().itemSales||[]))`);
ok(staged.length===2 && staged.some(r=>r.item==='Ghost Product 2'), '"staged" is real — the draft entry already carries both rows before Continue is even clicked', JSON.stringify(staged.map(r=>r.item)));
doc.querySelector('#gpContinue').click(); await tick(200);
ok(!doc.querySelector('.modal'), 'Continue closes the modal');
w.eval(`window.apiUpload = window.__realApiUpload;`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
