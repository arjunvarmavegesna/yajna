/* Tests: the sales upload projects its effect on the shelf BEFORE it is
   applied — stock now / this report sells / stock after, reconciling
   exactly — and names which rows won't deduct cleanly: not found on the
   Item Master (nothing to deduct from) vs. matched but would go negative
   (a symptom, not a stock level) vs. the clean majority. The check compares
   against STOCK IN HAND RIGHT NOW (today), never the entry's own date —
   that was the actual production bug this file guards against: an opening
   count and its sales both dated the same day, checked against "yesterday",
   found nothing, and reported 43 correctly-stocked items as zero. Client-
   side computation (stockAsOf), so this is DOM-only, no live server needed
   for the core mechanics; one end-to-end pass drives the real modal. */
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

console.log('— there is no stock position to check against yet: ONE fact, not one per row —');
w.eval(`
  db.items.viraj = [];
  db.hospitals.viraj.stockDate = null;
  db.adjustments.viraj=[]; db.dailyData.viraj={};
`);
let impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [
  {item:'Anything A', qty:5, cost:50}, {item:'Anything B', qty:3, cost:30}, {item:'Anything C', qty:9, cost:90}
])))`);
ok(impact.noBaseline===true, 'flagged as no-baseline rather than three false "not found" rows', JSON.stringify(impact));
ok(impact.reportItems===3 && impact.reportStrips===17 && impact.reportCogs===170, 'the report totals still come through, even with nothing to check against', JSON.stringify(impact));
const noBaseRendered = w.eval(`renderStockImpact(salesStockImpact('viraj', [{item:'Anything A', qty:5, cost:50}]))`);
ok(/no stock position to check against/i.test(noBaseRendered), 'and the message says so in one sentence', noBaseRendered);
ok(!/Anything A/.test(noBaseRendered), 'not a per-item complaint — the row name is not even mentioned', noBaseRendered);

console.log('— THE BUG THIS GUARDS AGAINST: opening count and sales dated the SAME day, no false negatives —');
w.eval(`
  db.items.viraj = [
    {id:'bug1', name:'Tab. Bug Guard 1', key:nameKey('Tab. Bug Guard 1'), pack:'10s', nr:12, mrp:20, openingQty:50, source:'demo', updatedAt:Date.now()},
    {id:'bug2', name:'Tab. Bug Guard 2', key:nameKey('Tab. Bug Guard 2'), pack:'15s', nr:8, mrp:14, openingQty:80, source:'demo', updatedAt:Date.now()}
  ];
  db.hospitals.viraj.stockDate = todayISO();
  db.adjustments.viraj=[]; db.dailyData.viraj={};
`);
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [
  {item:'Tab. Bug Guard 1', qty:10, cost:120},
  {item:'Tab. Bug Guard 2', qty:15, cost:120}
])))`);
ok(impact.noBaseline===false, 'a same-day opening count IS a real baseline — not treated as "no position"', JSON.stringify(impact));
ok(impact.clean.length===2 && impact.notFound.length===0 && impact.negative.length===0, 'both rows check out clean — the exact false-negative that broke in production', JSON.stringify(impact));
ok(impact.stockNowItems===2 && impact.stockNowValue===50*12+80*8, 'stock now reflects the opening count taken TODAY, correctly', JSON.stringify(impact));

console.log('— goods received in the morning, sold in the afternoon of the SAME day: clean, not flagged —');
w.eval(`
  db.dailyData.viraj[todayISO()] = { savedAt:Date.now(), purchases:[], rtv:[], itemSales:[], audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{},
    invoices:[{id:'invtoday', vendor:'V', invoiceNo:'1', date: todayISO(), fileName:'', lines:[
      {item:'Tab. Bug Guard 1', batch:'B1', exp:'2027-01', pqty:20, oqty:0, rate:12, disc:0, gst:0, mrp:20}
    ]}] };
`);
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [{item:'Tab. Bug Guard 1', qty:60, cost:720}])))`);
ok(impact.clean.length===1 && impact.negative.length===0, '50 opening + 20 bought today = 70 on hand; selling 60 same-day is clean, receipts land before issues', JSON.stringify(impact));

console.log('— a back-dated entry checks against CURRENT stock, which is an acceptable, stated leniency —');
w.eval(`
  db.items.viraj = [{id:'bd1', name:'Tab. Backdated Test', key:nameKey('Tab. Backdated Test'), pack:'10s', nr:10, mrp:20, openingQty:10, source:'demo', updatedAt:Date.now()}];
  db.hospitals.viraj.stockDate = addDays(todayISO(),-10);
  db.adjustments.viraj=[]; db.dailyData.viraj={};
  // a purchase landed AFTER the Monday being entered — current stock reflects it, Monday's own position would not have
  db.dailyData.viraj[addDays(todayISO(),-1)] = { savedAt:Date.now(), purchases:[], rtv:[], itemSales:[], audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{},
    invoices:[{id:'invlater', vendor:'V', invoiceNo:'1', date: addDays(todayISO(),-1), fileName:'', lines:[
      {item:'Tab. Backdated Test', batch:'B2', exp:'2027-01', pqty:40, oqty:0, rate:10, disc:0, gst:0, mrp:20}
    ]}] };
`);
// only 10 were on hand as of the Monday being entered, but 50 are on hand NOW (10 + 40 bought later) — selling 30 checks clean today
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [{item:'Tab. Backdated Test', qty:30, cost:300}])))`);
ok(impact.clean.length===1 && impact.negative.length===0, 'checks against the CURRENT balance (50), not the balance on the day being entered (10) — the stated trade-off', JSON.stringify(impact));

console.log('— a genuine oversell still warns, even against current stock —');
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [{item:'Tab. Backdated Test', qty:999, cost:9990}])))`);
ok(impact.negative.length===1 && impact.negative[0].have===50 && impact.negative[0].selling===999, 'far beyond even the current balance — still caught', JSON.stringify(impact.negative));

console.log('— the clean case: matched, stays non-negative, nothing to flag —');
w.eval(`
  db.items.viraj = [{id:'si1', name:'Tab. Clean Item', key:nameKey('Tab. Clean Item'), pack:'10s', nr:10, mrp:20, openingQty:100, source:'demo', updatedAt:Date.now()}];
  db.hospitals.viraj.stockDate = addDays(todayISO(),-30);
  db.adjustments.viraj=[]; db.dailyData.viraj={};
`);
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [{item:'Tab. Clean Item', qty:20, cost:200}])))`);
ok(impact.clean.length===1 && impact.notFound.length===0 && impact.negative.length===0, 'a matched, well-stocked sale is entirely clean', JSON.stringify(impact));
ok(impact.stockNowItems===1 && impact.stockNowValue===1000, 'stock now: 100 strips @ nr10 = 1000', JSON.stringify(impact));
ok(impact.reportItems===1 && impact.reportStrips===20 && impact.reportCogs===200, 'report sells: 1 item, 20 strips, cogs 200', JSON.stringify(impact));
ok(impact.stockAfterValue === impact.stockNowValue - impact.reportCogs, 'stock after reconciles EXACTLY: 1000 - 200 = 800', impact.stockAfterValue);

console.log('— sold, but not in inventory: nothing to deduct from —');
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [
  {item:'Tab. Clean Item', qty:5, cost:50},
  {item:'PAN 40 TAB (typo of PAN-40 TAB)', qty:8, cost:80}
])))`);
ok(impact.clean.length===1 && impact.notFound.length===1 && impact.notFound[0]==='PAN 40 TAB (typo of PAN-40 TAB)', 'the unmatched name is named, separately from the clean one', JSON.stringify(impact));
ok(impact.negative.length===0, 'and it is NOT counted as negative — it never reached a real lot at all');

console.log('— sold more than you have: a symptom, named with the exact numbers —');
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [{item:'Tab. Clean Item', qty:150, cost:1500}])))`);
ok(impact.negative.length===1 && impact.negative[0].name==='Tab. Clean Item', 'selling 150 of 100 on hand goes negative', JSON.stringify(impact));
ok(impact.negative[0].have===100 && impact.negative[0].selling===150, 'both figures are exact — this is diagnosable, not just a flag', JSON.stringify(impact.negative[0]));
ok(impact.clean.length===0, 'and it is not ALSO counted as clean — the buckets are mutually exclusive');

console.log('— two lines for the SAME item are summed before the check — a cumulative shortfall is still caught —');
impact = w.eval(`JSON.parse(JSON.stringify(salesStockImpact('viraj', [
  {item:'Tab. Clean Item', qty:60, cost:600},
  {item:'Tab. Clean Item', qty:60, cost:600}
])))`);
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
])))`);
ok(impact.clean.length===1 && impact.negative.length===1 && impact.notFound.length===1, 'one of each, from three rows', JSON.stringify({clean:impact.clean,negative:impact.negative,notFound:impact.notFound}));
ok(impact.clean.length+impact.negative.length+impact.notFound.length === impact.reportItems, 'the three buckets sum to exactly the report item count — nothing uncounted');

console.log('— renderStockImpact: the reconciliation reads as arithmetic, and buckets are named —');
const rendered = w.eval(`renderStockImpact(salesStockImpact('viraj', [
  {item:'Tab. Clean Item', qty:10, cost:100},
  {item:'Tab. Second Item', qty:25, cost:200},
  {item:'Ghost Product', qty:3, cost:30}
]))`);
ok(/Stock now/.test(rendered) && /This report sells/.test(rendered) && /Stock after/.test(rendered), 'before, this-report, and after all appear');
ok(/−/.test(rendered) && /=/.test(rendered), 'the after-value is shown as a subtraction, not just asserted', rendered.match(/\([^)]*=[^)]*\)/)?.[0]);
ok(/not found in inventory/i.test(rendered) && /would go negative/i.test(rendered), 'both problem buckets are called out by name in the summary line');
ok(/Ghost Product/.test(rendered) && /Tab\. Second Item/.test(rendered), 'and the actual offending names are listed below, not just counted', rendered.includes('Ghost Product'));

console.log('— the underlying ledger: a running balance, order-independent, full history preserved —');
{
  // the worked example from the spec: opening 30, then Mon sold 10, Tue bought
  // 50, Wed sold 20 — uploaded together, in EITHER order — must both land on 50
  const seedAndLoad = (order) => w.eval(`(() => {
    db.items.viraj = [{id:'rb1', name:'Tab. Running Balance', key:nameKey('Tab. Running Balance'), pack:'10s', nr:5, mrp:9, openingQty:30, source:'demo', updatedAt:Date.now()}];
    db.hospitals.viraj.stockDate = addDays(todayISO(),-10);
    db.adjustments.viraj=[]; db.dailyData.viraj={};
    const mon = addDays(todayISO(),-3), tue = addDays(todayISO(),-2), wed = addDays(todayISO(),-1);
    const blank = () => ({ savedAt:Date.now(), purchases:[], rtv:[], itemSales:[], audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[],
      sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{}, invoices:[] });
    const days = {
      mon: { ...blank(), itemSales:[{item:'Tab. Running Balance', qty:10, amount:90, pack:'10s', nr:5, mrp:9, cost:50}] },
      tue: { ...blank(), invoices:[{id:'i1', vendor:'V', invoiceNo:'1', date:tue, fileName:'', lines:[
        {item:'Tab. Running Balance', batch:'B1', exp:'2027-01', pqty:50, oqty:0, rate:5, disc:0, gst:0, mrp:9}
      ]}] },
      wed: { ...blank(), itemSales:[{item:'Tab. Running Balance', qty:20, amount:180, pack:'10s', nr:5, mrp:9, cost:100}] }
    };
    // save in the requested order — the KEY is the date either way, never the save order
    ${JSON.stringify(order)}.forEach(k => { const d = k==='mon'?mon:k==='tue'?tue:wed; db.dailyData.viraj[d] = days[k]; });
    return { mon, tue, wed };
  })()`);
  const forwardDates = seedAndLoad(['mon','tue','wed']);
  const forwardFinal = w.eval(`stockAsOf('viraj', todayISO()).items.find(i=>i.key===nameKey('Tab. Running Balance')).stock`);
  ok(forwardFinal===50, 'forward order (Mon, Tue, Wed): 30 − 10 + 50 − 20 = 50', forwardFinal);
  const forwardMon = w.eval(`stockAsOf('viraj', '${forwardDates.mon}').items.find(i=>i.key===nameKey('Tab. Running Balance')).stock`);
  const forwardTue = w.eval(`stockAsOf('viraj', '${forwardDates.tue}').items.find(i=>i.key===nameKey('Tab. Running Balance')).stock`);
  const forwardWed = w.eval(`stockAsOf('viraj', '${forwardDates.wed}').items.find(i=>i.key===nameKey('Tab. Running Balance')).stock`);
  ok(forwardMon===20 && forwardTue===70 && forwardWed===50, 'and the day-by-day history is intact: 20 end of Mon, 70 end of Tue, 50 end of Wed', JSON.stringify({forwardMon,forwardTue,forwardWed}));

  const reverseDates = seedAndLoad(['wed','tue','mon']);
  const reverseFinal = w.eval(`stockAsOf('viraj', todayISO()).items.find(i=>i.key===nameKey('Tab. Running Balance')).stock`);
  ok(reverseFinal===50, 'reverse upload order (Wed, Tue, Mon saved into their slots in that order): IDENTICAL final stock, 50', reverseFinal);
  const reverseMon = w.eval(`stockAsOf('viraj', '${reverseDates.mon}').items.find(i=>i.key===nameKey('Tab. Running Balance')).stock`);
  ok(reverseMon===20, 'and the history is identical too — order of arrival never touched it', reverseMon);
}

console.log('— re-uploading the same day\'s sales file does not deduct twice —');
{
  w.eval(`
    db.items.viraj = [{id:'ru1', name:'Tab. Reupload Test', key:nameKey('Tab. Reupload Test'), pack:'10s', nr:5, mrp:9, openingQty:100, source:'demo', updatedAt:Date.now()}];
    db.hospitals.viraj.stockDate = addDays(todayISO(),-10);
    db.adjustments.viraj=[]; db.dailyData.viraj={};
    const d = addDays(todayISO(),-1);
    db.dailyData.viraj[d] = { savedAt:Date.now(), purchases:[], rtv:[], invoices:[], audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[],
      sales:{mrp:90,cogs:50,cash:90,credit:0,cancels:0},
      itemSales:[{item:'Tab. Reupload Test', qty:10, amount:90, pack:'10s', nr:5, mrp:9, cost:50}] };
  `);
  const once = w.eval(`stockAsOf('viraj', todayISO()).items.find(i=>i.key===nameKey('Tab. Reupload Test')).stock`);
  // re-upload the SAME file for the SAME day — this OVERWRITES that day's slot
  // (a PUT/upsert, not an append), so it must read exactly the same, not 100-20
  w.eval(`
    const d = addDays(todayISO(),-1);
    db.dailyData.viraj[d] = { savedAt:Date.now(), purchases:[], rtv:[], invoices:[], audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[],
      sales:{mrp:90,cogs:50,cash:90,credit:0,cancels:0},
      itemSales:[{item:'Tab. Reupload Test', qty:10, amount:90, pack:'10s', nr:5, mrp:9, cost:50}] };
  `);
  const twice = w.eval(`stockAsOf('viraj', todayISO()).items.find(i=>i.key===nameKey('Tab. Reupload Test')).stock`);
  ok(once===90 && twice===90, 're-saving the same day is a REPLACE, not an append — stock reads 90 both times, never 80', JSON.stringify({once,twice}));
}

console.log('— after all of it, the audit\'s negative-stock check still finds a genuine dip on any date —');
{
  w.eval(`
    db.items.viraj = [{id:'neg1', name:'Tab. Negative Audit', key:nameKey('Tab. Negative Audit'), pack:'10s', nr:5, mrp:9, openingQty:10, source:'demo', updatedAt:Date.now()}];
    db.hospitals.viraj.stockDate = addDays(todayISO(),-5);
    db.adjustments.viraj=[]; db.dailyData.viraj={};
    db.dailyData.viraj[addDays(todayISO(),-1)] = { savedAt:Date.now(), purchases:[], rtv:[], invoices:[], audit:{opening:0,actual:'',unbilled:false,bounces:[]}, hv:[],
      sales:{mrp:180,cogs:100,cash:180,credit:0,cancels:0},
      itemSales:[{item:'Tab. Negative Audit', qty:20, amount:180, pack:'10s', nr:5, mrp:9, cost:100}] };
  `);
  const dipped = w.eval(`stockAsOf('viraj', todayISO()).items.filter(i=>i.stock<0).map(i=>i.name)`);
  ok(dipped.includes('Tab. Negative Audit'), 'the audit-grade check (same one the Inventory tab\'s Negative stock KPI reads) finds it', JSON.stringify(dipped));
}

console.log('— the modal: the preview shows the shelf impact BEFORE anything is staged, and confirms it again after —');
w.eval(`
  db.items.viraj = [{id:'si1', name:'Tab. Clean Item', key:nameKey('Tab. Clean Item'), pack:'10s', nr:10, mrp:20, openingQty:100, source:'demo', updatedAt:Date.now()}];
  db.hospitals.viraj.stockDate = addDays(todayISO(),-30);
  db.adjustments.viraj=[]; db.dailyData.viraj={};
`);
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

console.log('— against the REAL server: three days saved via genuine PUT round trips, in two different orders, land on the identical final stock —');
{
  const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
  const B = 'http://127.0.0.1:3061/api';
  let domCookie = '';
  const dom2 = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w2) { w2.HTMLElement.prototype.scrollIntoView = () => {}; w2.scrollTo = () => {}; w2.print = () => {}; w2.open = () => null; w2.confirm = () => true;
      w2.fetch = async (url, opts = {}) => {
        const r = await fetch(new URL(url, 'http://127.0.0.1:3061'), { ...opts, headers: { ...(opts.headers || {}), ...(domCookie ? { cookie: domCookie } : {}) } });
        const sc = r.headers.get('set-cookie'); if (sc) domCookie = sc.split(';')[0];
        return r;
      }; } });
  const w2 = dom2.window, doc2 = w2.document;
  await tick(400);
  doc2.querySelector('#loginEmail').value = 'bhagavan@yajnapharma.in';
  doc2.querySelector('#loginPw').value = ADMIN_PW;
  doc2.querySelector('#loginBtn').click(); await tick(900);

  const req = async (m, p, b) => {
    const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(domCookie ? { cookie: domCookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) domCookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const todayISO2 = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
  const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const T2 = todayISO2(), mon = addD(T2, -3), tue = addD(T2, -2), wed = addD(T2, -1);

  // PUT /entries replaces the WHOLE day's blob for a hospital — two runs on
  // the same hospital+dates would let the second overwrite the first, not
  // add to it. Two separate hospitals keep them from colliding, same as two
  // separate pharmacies would never share a day's entry row.
  const saveThreeDays = async (hid, itemName, order) => {
    await req('POST', '/items/opening', { hid, stockDate: addD(T2, -10), rows: [{ name: itemName, qty: 30, nr: 5, mrp: 9, pack: '10s' }] });
    const days = {
      mon: { purchases: [], rtv: [], invoices: [], hv: [], sales: { mrp: 90, cogs: 50, cash: 90, credit: 0, cancels: 0 }, cash: {},
        audit: { opening: 0, actual: '', unbilled: false, bounces: [] },
        itemSales: [{ item: itemName, qty: 10, amount: 90, pack: '10s', nr: 5, mrp: 9, cost: 50 }] },
      tue: { purchases: [], rtv: [], hv: [], sales: { mrp: 0, cogs: 0, cash: 0, credit: 0, cancels: 0 }, cash: {},
        audit: { opening: 0, actual: '', unbilled: false, bounces: [] },
        invoices: [{ id: 'inv-' + itemName, vendor: 'Order Test Vendor', invoiceNo: '1', date: tue, fileName: '', lines: [
          { item: itemName, pack: '10s', pqty: 50, oqty: 0, rate: 5, disc: 0, gst: 0, mrp: 9 }
        ] }] },
      wed: { purchases: [], rtv: [], invoices: [], hv: [], sales: { mrp: 180, cogs: 100, cash: 180, credit: 0, cancels: 0 }, cash: {},
        audit: { opening: 0, actual: '', unbilled: false, bounces: [] },
        itemSales: [{ item: itemName, qty: 20, amount: 180, pack: '10s', nr: 5, mrp: 9, cost: 100 }] }
    };
    const dateOf = { mon, tue, wed };
    for (const k of order) {
      const r = await req('PUT', `/entries/${hid}/${dateOf[k]}`, { entry: days[k] });
      if (r.status !== 200) throw new Error(`save ${hid}/${k} failed: ${JSON.stringify(r.data)}`);
    }
  };

  await saveThreeDays('viraj', 'Tab. Order Fwd Test', ['mon', 'tue', 'wed']);
  await saveThreeDays('siri', 'Tab. Order Rev Test', ['wed', 'tue', 'mon']);
  const boot = (await req('GET', '/bootstrap')).data;
  w2.eval(`
    db.items.viraj = ${JSON.stringify(boot.items.viraj)}; db.items.siri = ${JSON.stringify(boot.items.siri)};
    db.hospitals.viraj = ${JSON.stringify(boot.hospitals.viraj)}; db.hospitals.siri = ${JSON.stringify(boot.hospitals.siri)};
    db.dailyData.viraj = ${JSON.stringify(boot.dailyData.viraj)}; db.dailyData.siri = ${JSON.stringify(boot.dailyData.siri)};
    db.adjustments.viraj = ${JSON.stringify(boot.adjustments.viraj || [])}; db.adjustments.siri = ${JSON.stringify(boot.adjustments.siri || [])};
  `);
  const fwdStock = w2.eval(`stockAsOf('viraj', todayISO()).items.find(i=>i.key===nameKey('Tab. Order Fwd Test')).stock`);
  const revStock = w2.eval(`stockAsOf('siri', todayISO()).items.find(i=>i.key===nameKey('Tab. Order Rev Test')).stock`);
  ok(fwdStock === 50, 'saved mon→tue→wed via real PUT calls: 30 − 10 + 50 − 20 = 50', fwdStock);
  ok(revStock === 50, 'IDENTICAL data saved wed→tue→mon (opposite order, different hospital so nothing overwrites): same final stock, 50', revStock);
  ok(fwdStock === revStock, 'against the real server and real persistence, upload order never changes the answer');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
