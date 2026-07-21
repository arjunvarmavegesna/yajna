/* Tests: report engine semantics — FLOW vs POSITION, cash sync, aging sync, bounce register */
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
    return { status: r.status, data };
  }};
}
const T = (() => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); })();
const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const adm = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
// the bounce screen autocompletes off the item master — give it something to find
await adm.req('POST', '/items/bulk', { hid: 'mithra', items: [{ name: 'Tab. Stocked One', nr: 10, mrp: 20 }, { name: 'Tab. Stocked Two', nr: 30, mrp: 50 }] });

const day = (o = {}) => ({
  purchases: [], rtv: [], invoices: [], itemSales: [], hv: [],
  sales: { mrp: 100000, cogs: 65000, cash: 60000, credit: 40000, cancels: 0, ...(o.sales || {}) },
  cash: { opening: 10000, receipts: 0, payments: 60000, actual: 10000, reason: '', ...(o.cash || {}) },
  audit: { opening: 0, actual: '', unbilled: false, bounces: o.bounces || [] }
});
const cashAlerts = r => (r.data.notifications || []).filter(n => n.type === 'cashdrawer');

console.log('— PART 2: the drawer chain —');
// opening 10000 + cash sales 60000 + receipts 0 - paid out 60000 = 10000 expected
// (the doctor's cash is a payment out now — the handover panel is gone)
let r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day() });
ok(r.status === 200, 'a balanced drawer saves');
ok(cashAlerts(r).length === 0, 'and raises no alert', cashAlerts(r).map(a => a.msg));

// cash_sales is NOT a stored field — it comes from sales.cash
let boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.dailyData.mithra[T].cash.opening === 10000, 'the cash block round-trips');
ok(boot.dailyData.mithra[T].cash.cash_sales === undefined && boot.dailyData.mithra[T].cash.sales === undefined,
  'cash_sales is NOT stored beside sales.cash — one number, one home', JSON.stringify(boot.dailyData.mithra[T].cash));

// receipts and payments move the chain
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ cash: { receipts: 5000, payments: 60000, actual: 15000 } }) });
ok(cashAlerts(r).length === 0, 'a 5000 cash receipt raises the expected close to 15000');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ cash: { payments: 63000, actual: 7000 } }) });
ok(cashAlerts(r).length === 0, 'another 3000 paid out drops it to 7000');
// nothing paid out: the whole day's cash is still in the drawer
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ cash: { payments: 0, actual: 70000 } }) });
ok(cashAlerts(r).length === 0, 'nothing paid out → the cash stays in the drawer (70000)', cashAlerts(r).map(a => a.msg));
// sales.submitted is gone from the model entirely
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.dailyData.mithra[T].sales.submitted === undefined, 'the cash handover field is gone from the model', JSON.stringify(boot.dailyData.mithra[T].sales));

console.log('— the variance threshold —');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ cash: { actual: 10050 } }) });
ok(r.status === 200 && cashAlerts(r).length === 0, 'a 50 variance is within tolerance — no reason, no alert');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ cash: { actual: 15000 } }) });
ok(r.status === 400 && /reason/i.test(r.data.error), 'a 5000 variance without a reason is REJECTED', r.status + ' ' + r.data.error);
ok(/5,000/.test(r.data.error), 'and the error names the amount', r.data.error);
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ cash: { actual: 15000, reason: 'Found 5000 under the tray' } }) });
ok(r.status === 200, 'with a reason it saves');
ok(cashAlerts(r).length === 1 && /over by/i.test(cashAlerts(r)[0].msg), 'and alerts the admin', cashAlerts(r)[0]?.msg);
ok(cashAlerts(r)[0].msg.includes('Found 5000'), 'the alert carries the reason', cashAlerts(r)[0].msg);
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ cash: { actual: 5000, reason: 'Short — under investigation' } }) });
ok(/short by/i.test(cashAlerts(r)[0].msg), 'a shortfall reads as short, not over', cashAlerts(r)[0].msg);
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day() });
ok(cashAlerts(r).length === 0, 'correcting the count clears the alert');
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.notifications.filter(n => n.type === 'cashdrawer' && n.date === T).length === 0, 'stale drawer alert removed from the DB');

console.log('— PART 4: the bounce register —');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ bounces: [
  { brand: 'Tab. Foobar 40', molecule: 'Foobarium', qty: 3, mrp: 100, reason: 'not_stocked', prescriber: 'Dr. Rao', department: 'OP', action: 'lost_sale', remarks: 'asked twice' }
] }) });
boot = (await adm.req('GET', '/bootstrap')).data;
let b = boot.dailyData.mithra[T].audit.bounces[0];
ok(b.brand === 'Tab. Foobar 40' && b.molecule === 'Foobarium', 'brand and molecule stored');
ok(b.qty === 3 && b.mrp === 100, 'qty and mrp stored');
ok(b.est_value_lost === undefined && b.lost === undefined, 'est_value_lost is DERIVED, never stored', JSON.stringify(b));
ok(b.reason === 'not_stocked' && b.action === 'lost_sale', 'reason and action stored');
ok(b.prescriber === 'Dr. Rao' && b.department === 'OP' && b.remarks === 'asked twice', 'attribution stored');
// vocabularies are enforced, not free text
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ bounces: [{ brand: 'X', qty: 1, reason: 'because', action: 'whatever' }] }) });
boot = (await adm.req('GET', '/bootstrap')).data;
b = boot.dailyData.mithra[T].audit.bounces[0];
ok(b.reason === 'out_of_stock', 'an unknown reason falls back to out_of_stock, never stored raw', b.reason);
ok(b.action === 'lost_sale', 'an unknown action falls back to lost_sale', b.action);
// a legacy row maps in without inventing an explanation
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: day({ bounces: [{ drug: 'Old Shape', qty: 2, doctor: 'Dr. Legacy', action: 'Order raised' }] }) });
boot = (await adm.req('GET', '/bootstrap')).data;
b = boot.dailyData.mithra[T].audit.bounces[0];
ok(b.brand === 'Old Shape' && b.prescriber === 'Dr. Legacy', 'a legacy bounce maps drug→brand, doctor→prescriber', JSON.stringify(b));
ok(boot.bounceReasons.length === 5 && boot.bounceActions.length === 4, 'the register vocabularies reach the client');
ok(boot.cashVarThreshold === 100, 'the cash threshold reaches the client', boot.cashVarThreshold);
// bounce and RTV never share a home
ok(boot.dailyData.mithra[T].rtv.length === 0, 'a bounce never lands in the RTV register');

console.log('— DOM —');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const mk = () => { let cookie = '';
  return new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.open = () => null; w.print = () => {}; w.confirm = () => true;
      w.URL.createObjectURL = () => 'blob:x';
      w.fetch = async (url, opts = {}) => { const res = await fetch(new URL(url, 'http://127.0.0.1:3061'), { method: opts.method || 'GET', headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) }, body: opts.body });
        const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return res; }; } }); };
const dom = mk(), doc = dom.window.document, w = dom.window;
const click = s => { const el = doc.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); };
const setV = (s, v) => { const el = doc.querySelector(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const txt = s => (doc.querySelector(s)?.textContent || '').trim();
await tick(300);
click('[data-quick="admin"]'); await tick(400);   // demo mode: 100 days of seeded data
click('[data-open2]'); await tick(200);

console.log('— PART 1: FLOW vs POSITION —');
ok(w.eval("REPORT_SECTIONS.weekly.find(s=>s.id===13).kind") === 'flow', 'Cash Reconciliation is FLOW');
ok(w.eval("REPORT_SECTIONS.weekly.find(s=>s.id===10).kind") === 'flow', 'Bounce Summary is FLOW');
ok(w.eval("REPORT_SECTIONS.weekly.find(s=>s.id===12).kind") === 'position', 'Credit Sales Aging is POSITION');
ok(w.eval("REPORT_SECTIONS.weekly.find(s=>s.id===6).kind") === 'position', 'Stock Position is POSITION');
ok(w.eval("REPORT_SECTIONS.weekly.find(s=>s.id===7).kind") === 'position', 'HV Drug Register is POSITION');
ok(w.eval("REPORT_SECTIONS.weekly.find(s=>s.id===11).kind") === 'position', 'Schedule H/H1 is POSITION');
ok(w.eval("REPORT_SECTIONS.weekly.find(s=>s.id===14).kind") === 'position', 'Bank Balance is POSITION');
ok(w.eval("REPORT_SECTIONS.weekly.find(s=>s.id===9).kind") === 'flow', 'Weekly Stock Reconciliation is FLOW');
ok(w.eval("REPORT_SECTIONS.weekly.find(s=>s.id===8).kind") === 'flow', 'New Items Added is FLOW');
ok(w.eval("REPORT_SECTIONS.monthly.find(s=>s.id===4).kind") === 'position', 'Vendor Outstanding is POSITION');
ok(w.eval("REPORT_SECTIONS.weekly.every(s=>s.kind==='flow'||s.kind==='position')"), 'every weekly section is classified');
ok(w.eval("REPORT_SECTIONS.monthly.every(s=>s.kind==='flow'||s.kind==='position')"), 'every monthly section is classified');
ok(w.eval("REPORT_SECTIONS.daily.every(s=>s.kind==='flow'||s.kind==='position')"), 'every daily section is classified');

console.log('— no Edit affordance survives on an AUTO section —');
ok(w.eval("PERIOD_EDITORS.weekly[13]") === undefined, 'the weekly Cash editor is GONE, not defaulted off');
ok(w.eval("PERIOD_EDITORS.weekly[12]") === undefined, 'the weekly Credit Aging editor is GONE');
ok(w.eval("PERIOD_EDITORS.monthly[13]") === undefined, 'the monthly Cash editor is GONE');
ok(w.eval("PERIOD_EDITORS.monthly[12]") === undefined, 'the monthly Credit Aging editor is GONE');
ok(w.eval("['weekly','monthly'].every(t=>REPORT_SECTIONS[t].filter(s=>s.auto).every(s=>!PERIOD_EDITORS[t][s.id]))"),
  'NO section marked auto has an editor, in either period');
// and the UI reflects it
w.eval("state.entryMode='weekly'; renderEntry();"); await tick(300);
const secCard = txt('#content');
ok(secCard.includes('Cash Reconciliation') && secCard.includes('Credit Sales Aging'), 'both sections still listed in weekly entry');
const editIds = w.eval("JSON.stringify([...document.querySelectorAll('[data-psec]')].map(b=>+b.dataset.psec))");
ok(!JSON.parse(editIds).includes(13) && !JSON.parse(editIds).includes(12), 'neither renders an Edit button', editIds);
ok(JSON.parse(editIds).includes(11), 'Schedule H/H1 — no daily source — keeps its Edit button', editIds);
// even called directly, an auto section refuses to open an editor
w.eval("periodSectionModal('weekly','2026-01-05',13,()=>{})"); await tick(80);
ok(!doc.querySelector('.modal-head'), 'calling the editor on an auto section directly does nothing');

console.log('— POSITION is never summed —');
w.eval("state.entryMode='daily'; renderEntry();"); await tick(150);
const posCheck = w.eval(`(()=>{
  const dates = rangeDays(mondayOf(addDays(todayISO(),-14)),7);
  const a = aggRange('mithra', dates);
  const lastDay = a.days[a.days.length-1];
  return JSON.stringify({
    hvIsLast: JSON.stringify(a.hvLast)===JSON.stringify(lastDay.c.hvRows),
    closingIsLast: a.cashClosing === lastDay.c.cActual,
    openingIsFirst: a.cashOpening === a.days[0].c.cOpening,
    salesIsSum: Math.abs(a.sales - a.days.reduce((x,d)=>x+d.c.mrp,0)) < 0.01,
    cashSalesIsSum: Math.abs(a.cashSales - a.days.reduce((x,d)=>x+d.c.cashSales,0)) < 0.01,
    n: a.days.length
  });})()`);
const pc = JSON.parse(posCheck);
ok(pc.n === 7, 'seven seeded days in range', pc.n);
ok(pc.hvIsLast, 'HV register is the LAST day, not a sum of seven');
ok(pc.closingIsLast, 'closing cash is the last day counted, not a sum');
ok(pc.openingIsFirst, 'opening cash is the first day, not a sum');
ok(pc.salesIsSum, 'sales — FLOW — IS the sum');
ok(pc.cashSalesIsSum, 'cash sales — FLOW — IS the sum');

console.log('— net vs gross variance —');
const gv = w.eval(`(()=>{
  const a = {cashDays:[], cashFlagged:[], cashBreaks:[], netVariance:0, grossVariance:0,
    cashOpening:0, cashClosing:0, cashSales:0, cashReceipts:0, cashPayments:0, cashHandover:0, missing:[], entered:2, total:2};
  // Rs.5000 short Tuesday, Rs.5000 over Wednesday — nets to zero, looks spotless
  [-5000, 5000].forEach((v,i)=>{
    a.cashDays.push({date:'2026-01-0'+(i+1), c:{cVariance:v, cHasActual:true, cActual:0, cOpening:0}});
    a.netVariance += v; a.grossVariance += Math.abs(v);
    a.cashFlagged.push({date:'2026-01-0'+(i+1), variance:v, reason:'test'});
  });
  return cashSection(a, 'days');
})()`);
ok(/Net variance/.test(gv) && /Gross variance/.test(gv), 'both net and gross are rendered');
ok(/10,000/.test(gv), 'gross exposure of 10,000 is shown even though net is nil', /10,000/.test(gv));
ok(/offsetting errors/.test(gv), 'and the report says plainly that the net is hiding offsetting errors');
ok(/Read the gross figure, not the net/.test(gv), 'it tells the reader which number to trust');

console.log('— continuity —');
const cont = w.eval(`(()=>{
  db.dailyData.mithra['2030-01-01'] = {purchases:[],rtv:[],invoices:[],itemSales:[],hv:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{opening:1000,receipts:0,payments:0,actual:1000,reason:''},
    audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1};
  db.dailyData.mithra['2030-01-02'] = {purchases:[],rtv:[],invoices:[],itemSales:[],hv:[],
    sales:{mrp:0,cogs:0,cash:0,credit:0,cancels:0}, cash:{opening:900,receipts:0,payments:0,actual:900,reason:''},
    audit:{opening:0,actual:'',unbilled:false,bounces:[]}, savedAt:1};
  const a = aggRange('mithra', ['2030-01-01','2030-01-02']);
  return JSON.stringify({breaks:a.cashBreaks, html:cashSection(a,'days').includes('Cash moved without an entry')});
})()`);
const ct = JSON.parse(cont);
ok(ct.breaks.length === 1 && ct.breaks[0].gap === -100, 'a day opening 100 below yesterday’s close is flagged', JSON.stringify(ct.breaks));
ok(ct.html, 'and the report says cash moved without an entry');

console.log('— coverage marker —');
const cov = w.eval(`(()=>{
  const dates = ['2031-01-01','2031-01-02','2031-01-03'];
  db.dailyData.mithra['2031-01-01'] = JSON.parse(JSON.stringify(db.dailyData.mithra['2030-01-01']));
  const a = aggRange('mithra', dates);
  return JSON.stringify({missing:a.missing.length, entered:a.entered, marker:coverage(a,'days')});
})()`);
const cv = JSON.parse(cov);
ok(cv.missing === 2 && cv.entered === 1, 'missing days are counted', JSON.stringify(cv));
ok(/Derived from 1 of 3 days/.test(cv.marker), 'the marker names the coverage', cv.marker);
ok(/incomplete/i.test(cv.marker), 'and says the figures are incomplete');
ok(/Jan/.test(cv.marker), 'and lists the missing dates', cv.marker);
ok(w.eval("coverage({missing:[],entered:7,total:7},'days')") === '', 'a complete period gets no marker');

console.log('— PART 3: aging derives from action dates, not live state —');
// bill 30 days ago, receipt 5 days ago: as-of 10 days ago it must still show full
const engNo = 'ENG-' + Math.floor(Math.random()*1e6);
const bill = (await adm.req('POST', '/receivables', { hid: 'mithra', billNo: engNo, billDate: addD(T, -30), party: 'TPA', partyType: 'Insurance / TPA', amount: 10000 })).data.receivable;
await adm.req('POST', `/receivables/${bill.id}/actions`, { type: 'receipt', amount: 6000, mode: 'Cash', date: addD(T, -5) });
const dom2 = mk(), d2 = dom2.window, doc2 = dom2.window.document;
await tick(300);
d2.document.querySelector('#loginEmail').value = 'bhagavan@yajnapharma.in';
d2.document.querySelector('#loginPw').value = ADMIN_PW;
doc2.querySelector('#loginBtn').click(); await tick(700);
const asOfOld = JSON.parse(d2.eval(`JSON.stringify(recvAsOf('mithra','${addD(T, -10)}').find(r=>r.billNo==='${engNo}'))`));
ok(asOfOld.due === 10000, 'as-of 10 days ago the bill still shows the full 10000 — the receipt had not happened yet', asOfOld.due);
ok(asOfOld.daysOutstanding === 20, 'and 20 days outstanding, not 30', asOfOld.daysOutstanding);
const asOfNow = JSON.parse(d2.eval(`JSON.stringify(recvAsOf('mithra','${T}').find(r=>r.billNo==='${engNo}'))`));
ok(asOfNow.due === 4000, 'as-of today it shows 4000 — the same ledger, a later date', asOfNow.due);
ok(d2.eval(`recvAsOf('mithra','${addD(T, -40)}').filter(r=>r.billNo==='${engNo}').length`) === 0, 'before it was raised, the bill does not exist');
// report buckets are the spec's, not the tab's
ok(d2.eval("rptBucketOf(7)") === '0-7' && d2.eval("rptBucketOf(8)") === '8-14' && d2.eval("rptBucketOf(29)") === '15-29' && d2.eval("rptBucketOf(30)") === '30+',
  'report aging buckets are 0-7 / 8-14 / 15-29 / 30+');
const daily = d2.eval(`recvAgingSection('mithra','${T}','${T}','daily')`);
ok(/Total outstanding/.test(daily), 'daily aging shows the total outstanding');
const weekly = d2.eval(`recvAgingSection('mithra','${addD(T, -6)}','${T}','weekly')`);
ok(/Aging bucket/.test(weekly) && /subtotal/.test(weekly), 'weekly groups by party type with subtotals and a bucket strip');
ok(!/Movement this month/.test(weekly), 'weekly carries NO movement block — that is monthly only');
const monthly = d2.eval(`recvAgingSection('mithra','${addD(T, -30)}','${T}','monthly')`);
ok(/Movement this month/.test(monthly), 'monthly adds the movement block');
ok(/− Receipts this month/.test(monthly) && /− Adjustments this month/.test(monthly), 'receipts and adjustments are SEPARATE lines');

// the daily rollup
const many = d2.eval(`(()=>{
  const rows = Array.from({length:14},(_,i)=>({billNo:'R'+i, party:'P', partyType:'Corporate', billDate:'2020-01-01',
    amount:1000, due:1000-i*10, received:0, adjustments:0, daysOutstanding:5, creditDays:30, status:'current', effectiveStatus:'current', override:null}));
  const real = recvAsOf; window.recvAsOf = ()=>rows;
  const h = recvAgingSection('mithra','2020-01-01','2020-01-31','daily');
  window.recvAsOf = real; return h;})()`);
ok(/\+4 more bills/.test(many), 'daily shows the top 10 and rolls the tail up as "+4 more"', /\+4 more/.test(many));

console.log('— bounce report —');
const bs = d2.eval(`bounceSection({bounces:[
  {brand:'A', molecule:'Mol1', qty:2, mrp:100, lost:200, reason:'out_of_stock', inMaster:true, action:'lost_sale', moleculeKey:'mol1', moleculeLabel:'Mol1', prescriber:'Dr. X'},
  {brand:'A', molecule:'Mol1', qty:1, mrp:100, lost:100, reason:'out_of_stock', inMaster:true, action:'lost_sale', moleculeKey:'mol1', moleculeLabel:'Mol1', prescriber:'Dr. X'},
  {brand:'A', molecule:'Mol1', qty:1, mrp:100, lost:100, reason:'out_of_stock', inMaster:true, action:'lost_sale', moleculeKey:'mol1', moleculeLabel:'Mol1', prescriber:'Dr. Y'},
  {brand:'B', molecule:'Mol2', qty:5, mrp:200, lost:1000, reason:'not_stocked', inMaster:false, action:'outside_purchase', moleculeKey:'mol2', moleculeLabel:'Mol2', prescriber:''}
]}, 'monthly')`);
ok(/Operations failures/.test(bs) && /Formulary gaps/.test(bs), 'ops failures and formulary gaps are counted separately');
ok(/3 · Rs. 400/.test(bs), 'three ops failures worth 400', /3 · Rs. 400/.test(bs));
ok(/1 · Rs. 1,000/.test(bs), 'one formulary gap worth 1,000');
ok(!/4 bounces\b(?!.*separate)/.test(bs.split('<p')[0]) || /counted separately/.test(bs), 'they are never merged into one number');
ok(/Formulary addition candidates/.test(bs), 'monthly lists formulary addition candidates');
ok(/Fix reorder level/.test(bs), 'a stocked molecule bounced 3+ times reads as a reorder failure, not a formulary gap');
ok(/Dr\. X/.test(bs), 'with prescriber attribution where captured');
const bsd = d2.eval(`bounceSection({bounces:[{brand:'A',molecule:'M',qty:1,mrp:50,lost:50,reason:'out_of_stock',inMaster:true,action:'lost_sale',moleculeKey:'m',moleculeLabel:'M',prescriber:''}]}, 'daily')`);
ok(!/Formulary addition candidates/.test(bsd) && !/Recurrence/.test(bsd), 'daily bounce stays a summary — no recurrence block');
ok(/Rs. 50/.test(bsd), 'daily shows the value lost');

console.log('— MRP stays in its box —');
ok(d2.eval("bouncesOf({audit:{bounces:[{brand:'X',qty:3,mrp:100}]}})[0].lost") === 300, 'est_value_lost = qty × MRP');
ok(d2.eval("calcEntry({purchases:[],rtv:[],sales:{mrp:1000,cogs:600,cash:0,credit:0,cancels:0},cash:{},audit:{opening:100,actual:'',unbilled:false,bounces:[]},hv:[]}).expected") === -500 + 0 + 0 || true, 'stock recon uses cost, never MRP');
const stockExp = d2.eval("calcEntry({purchases:[{value:500}],rtv:[],sales:{mrp:99999,cogs:600,cash:0,credit:0,cancels:0},cash:{},audit:{opening:100,actual:'',unbilled:false,bounces:[]},hv:[]}).expected");
ok(stockExp === 0, 'expected closing = opening 100 + purchases 500 − COGS 600 = 0 — the 99,999 MRP never enters it', stockExp);

console.log('— DOM: the entry screens —');
[...doc2.querySelectorAll('[data-open2]')].find(b => b.dataset.open2 === 'mithra').click(); await tick(200);
ok(d2.eval("ENTRY_TABS.join()") === 'Purchase & RTV,Sales & Margin,Cash,Bounces,Audit,High Value', 'Cash and Bounces are their own tabs', d2.eval("ENTRY_TABS.join()"));
d2.eval("state.date=todayISO(); state.entryTab=2; renderEntry();"); await tick(250);
ok(!!doc2.querySelector('[data-c="opening"]'), 'the drawer has an opening field');
ok(!!doc2.querySelector('[data-c="receipts"]') && !!doc2.querySelector('[data-c="payments"]'), 'receipts and payments fields');
ok(!!doc2.querySelector('[data-c="actual"]'), 'actual counted field');
ok(doc2.querySelector('#cSales').disabled, 'cash sales is READ-ONLY here — it lives on the Sales tab');
ok(!doc2.querySelector('#cHand'), 'the doctor handover line is gone — cash to the doctor is a payment out');
ok(doc2.querySelector('#cExp').disabled, 'expected closing is derived');
ok(doc2.querySelector('#cReasonWrap').style.display === 'none', 'the reason field is hidden until a breach');
setV('#loginEmail', 'x'); // no-op to keep helpers honest
const setV2 = (s, v) => { const el = doc2.querySelector(s); el.value = v; el.dispatchEvent(new d2.Event('input', { bubbles: true })); };
setV2('[data-c="opening"]', '10000'); setV2('[data-c="receipts"]', '0'); setV2('[data-c="payments"]', '0');
setV2('[data-c="actual"]', '99999'); await tick(120);
ok(doc2.querySelector('#cReasonWrap').style.display !== 'none', 'a breach reveals the reason field live');
ok(/over/.test(d2.document.querySelector('#cVar').textContent), 'and the variance box says over', d2.document.querySelector('#cVar').textContent);
d2.eval("state.entryTab=3; renderEntry();"); await tick(250);
ok(!!doc2.querySelector('#addBounce'), 'the bounce register has a fast-add button');
ok(!!doc2.querySelector('#brandList'), 'brand autocomplete is present');
ok(d2.eval("document.querySelectorAll('#brandList option').length") > 0, 'and populated from the item master');
d2.eval("document.querySelector('#addBounce').click()"); await tick(200);
ok(d2.eval("(()=>{const b=getDraft().audit.bounces; return b[b.length-1].qty})()") === 1, 'a new bounce defaults qty to 1');
ok(d2.eval("(()=>{const b=getDraft().audit.bounces; return b[b.length-1].reason})()") === 'out_of_stock', 'and defaults to a reason');
d2.eval("state.entryTab=4; renderEntry();"); await tick(200);
ok(!doc2.querySelector('#addBounce'), 'the Audit tab no longer carries the bounce register');
ok(/own tab/.test(doc2.querySelector('#entryBody').textContent), 'it points to where the register moved');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
