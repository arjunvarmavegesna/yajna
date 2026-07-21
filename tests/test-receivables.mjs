/* Tests: receivables — derived amounts, append-only log, overrides that never reset the clock */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const MANAGER_PW = process.env.SEED_MANAGER_PW || 'Test@Manager#1';
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
const T = (() => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); })();
const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const adm = jar(), mgr = jar(), stf = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await mgr.req('POST', '/login', { email: 'manager@yajnapharma.in', password: MANAGER_PW });
await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });

let n = 0;
const bill = (o = {}) => ({ hid: 'mithra', billNo: 'INV-' + (++n) + '-' + Math.floor(Math.random() * 9999), billDate: T, party: 'Star Health', partyType: 'Insurance / TPA', amount: 10000, ...o });

console.log('— creating a bill —');
let r = await adm.req('POST', '/receivables', bill());
ok(r.status === 200, 'bill created');
ok(r.data.receivable.due === 10000, 'due starts at the full bill amount', r.data.receivable.due);
ok(r.data.receivable.creditDays === 45, 'Insurance/TPA carries 45-day terms', r.data.receivable.creditDays);
ok(r.data.receivable.status === 'current', 'a bill raised today is current');
const id = r.data.receivable.id;

console.log('— validation —');
r = await adm.req('POST', '/receivables', bill({ billNo: '' }));
ok(r.status === 400, 'bill number required');
r = await adm.req('POST', '/receivables', bill({ party: '' }));
ok(r.status === 400, 'party required');
r = await adm.req('POST', '/receivables', bill({ amount: 0 }));
ok(r.status === 400, 'zero amount rejected');
r = await adm.req('POST', '/receivables', bill({ amount: -500 }));
ok(r.status === 400, 'negative amount rejected');
r = await adm.req('POST', '/receivables', bill({ billDate: addD(T, 3) }));
ok(r.status === 400 && /future/i.test(r.data.error), 'future bill date rejected', r.data.error);
r = await adm.req('POST', '/receivables', bill({ partyType: 'Made up' }));
ok(r.status === 400, 'party type must be from the list');
const dupe = bill();
await adm.req('POST', '/receivables', dupe);
r = await adm.req('POST', '/receivables', dupe);
ok(r.status === 409 && /exists/i.test(r.data.error), 'duplicate bill number in the same hospital rejected', r.status + ' ' + r.data.error);
r = await adm.req('POST', '/receivables', { ...dupe, hid: 'viraj' });
ok(r.status === 200, 'the same bill number in another hospital is fine');

console.log('— the credit period comes from the party type —');
const days = { 'Insurance / TPA': 45, 'Government scheme': 60, 'Corporate': 30, 'Ward / department': 15, 'Patient': 7 };
for (const [t, d] of Object.entries(days)) {
  r = await adm.req('POST', '/receivables', bill({ partyType: t }));
  ok(r.data.receivable.creditDays === d, `${t} → ${d} days`, r.data.receivable.creditDays);
}
// a 40-day bill is due_soon for a TPA but critical for a patient
r = await adm.req('POST', '/receivables', bill({ partyType: 'Insurance / TPA', billDate: addD(T, -40) }));
ok(r.data.receivable.status === 'due_soon', '40-day TPA bill = due soon (last 20% of 45)', r.data.receivable.status);
r = await adm.req('POST', '/receivables', bill({ partyType: 'Patient', billDate: addD(T, -40) }));
ok(r.data.receivable.status === 'critical', '40-day patient bill = critical (past 2× of 7)', r.data.receivable.status);
r = await adm.req('POST', '/receivables', bill({ partyType: 'Corporate', billDate: addD(T, -40) }));
ok(r.data.receivable.status === 'overdue', '40-day corporate bill = overdue (past 30, not yet 60)', r.data.receivable.status);

console.log('— receipts reduce the due, and nothing is stored —');
r = await adm.req('POST', `/receivables/${id}/actions`, { type: 'receipt', amount: 4000, mode: 'NEFT', date: T });
ok(r.status === 200 && r.data.receivable.due === 6000, 'receipt of 4000 → 6000 due', r.data.receivable.due);
ok(r.data.receivable.received === 4000, 'received tracked', r.data.receivable.received);
r = await adm.req('POST', `/receivables/${id}/actions`, { type: 'receipt', amount: 6000, mode: 'UPI', date: T });
ok(r.data.receivable.due === 0, 'paying the rest clears it', r.data.receivable.due);
ok(r.data.actions.length === 2, 'both receipts on the log');
r = await adm.req('POST', `/receivables/${id}/actions`, { type: 'receipt', amount: 1, mode: 'Cash', date: T });
ok(r.status === 400 && /exceed|more than|due/i.test(r.data.error), 'cannot receive more than is due', r.data.error);
r = await adm.req('POST', `/receivables/${id}/actions`, { type: 'receipt', amount: 0, mode: 'Cash', date: T });
ok(r.status === 400, 'zero receipt rejected');
r = await adm.req('POST', `/receivables/${id}/actions`, { type: 'receipt', amount: 100, mode: 'Bitcoin', date: T });
ok(r.status === 400, 'receipt mode must be from the list');

console.log('— corrections are counter-entries, never edits —');
const r2 = (await adm.req('POST', '/receivables', bill({ amount: 20000 }))).data.receivable;
r = await adm.req('POST', `/receivables/${r2.id}/actions`, { type: 'receipt', amount: 5000, mode: 'Cash', date: T });
ok(r.data.receivable.due === 15000, '5000 received → 15000 due');
r = await adm.req('POST', `/receivables/${r2.id}/actions`, { type: 'receipt', amount: -5000, mode: 'Cash', date: T, reason: 'keyed twice' });
ok(r.status === 400, 'a receipt cannot be negative — reverse it with an adjustment instead');
r = await adm.req('POST', `/receivables/${r2.id}/actions`, { type: 'adjustment', amount: -2000, date: T, reason: 'TPA rejected 2000 of the claim' });
ok(r.status === 200 && r.data.receivable.due === 13000, 'a −2000 adjustment writes the bill down to 13000', r.data.receivable.due);
ok(r.data.receivable.adjustments === -2000, 'adjustments tracked separately from receipts', r.data.receivable.adjustments);
ok(r.data.receivable.received === 5000, 'the write-off did NOT inflate receipts', r.data.receivable.received);
r = await adm.req('POST', `/receivables/${r2.id}/actions`, { type: 'adjustment', amount: 2000, date: T, reason: 'rejection reversed on appeal' });
ok(r.data.receivable.due === 15000, 'a counter-adjustment restores it', r.data.receivable.due);
ok(actLen(await adm.req('GET', '/bootstrap'), r2.id) === 3, 'all three accepted actions survive — nothing was edited away', actLen(await adm.req('GET', '/bootstrap'), r2.id));
function actLen(boot, rid) { return boot.data.recvActions.mithra.filter(a => a.receivableId === rid).length; }

r = await adm.req('POST', `/receivables/${r2.id}/actions`, { type: 'adjustment', amount: -100, date: T });
ok(r.status === 400 && /reason/i.test(r.data.error), 'an adjustment without a reason is rejected', r.data.error);
r = await adm.req('POST', `/receivables/${r2.id}/actions`, { type: 'adjustment', amount: 0, date: T, reason: 'nothing at all' });
ok(r.status === 400, 'zero adjustment rejected');
r = await adm.req('POST', `/receivables/${r2.id}/actions`, { type: 'adjustment', amount: -99000, date: T, reason: 'writing off more than the bill' });
ok(r.status === 400 && /negative|below/i.test(r.data.error), 'cannot push the due below zero', r.data.error);

console.log('— the approval threshold —');
/* With two roles, everyone who can adjust at all is an admin — so the threshold
   can no longer gate. What it still does, and what an audit asks, is NAME the
   approver on any write-off big enough to matter. */
r = await mgr.req('POST', `/receivables/${r2.id}/actions`, { type: 'adjustment', amount: -500, date: T, reason: 'small rounding difference' });
ok(r.status === 200, 'a small adjustment goes through');
ok(!r.data.action.approver, 'and records no approver — it is under the threshold', r.data.action.approver);
r = await adm.req('POST', `/receivables/${r2.id}/actions`, { type: 'adjustment', amount: -6000, date: T, reason: 'large write-off needing approval' });
ok(r.status === 200, 'a large one goes through too');
ok(r.data.action.approver === 'Bhagavan', 'but NAMES who approved it', r.data.action.approver);
r = await stf.req('POST', `/receivables/${r2.id}/actions`, { type: 'adjustment', amount: -100, date: T, reason: 'a data entry user trying' });
ok(r.status === 403, 'a data-entry user cannot adjust at all');

console.log('— follow-ups and notes —');
r = await stf.req('POST', `/receivables/${r2.id}/actions`, { type: 'follow_up', date: T, reason: 'spoke to accounts, promised Friday', nextFollowUp: addD(T, 3) });
ok(r.status === 200, 'staff can log a follow-up — chasing is their job');
ok(r.data.receivable.nextFollowUp === addD(T, 3), 'next follow-up date set', r.data.receivable.nextFollowUp);
r = await stf.req('POST', `/receivables/${r2.id}/actions`, { type: 'note', date: T, reason: 'claim number CL-8891' });
ok(r.status === 200, 'staff can add a note');
r = await stf.req('POST', `/receivables/${r2.id}/actions`, { type: 'receipt', amount: 100, mode: 'Cash', date: T });
ok(r.status === 403, 'a data-entry user CANNOT record money in');
r = await stf.req('POST', `/receivables/${r2.id}/actions`, { type: 'adjustment', amount: -100, date: T, reason: 'nope' });
ok(r.status === 403, 'a data-entry user CANNOT adjust');
r = await stf.req('POST', '/receivables', bill());
ok(r.status === 403, 'a data-entry user CANNOT raise a bill');
r = await adm.req('POST', `/receivables/${r2.id}/actions`, { type: 'nonsense', date: T });
ok(r.status === 400, 'unknown action type rejected');

console.log('— overrides explain, they do not reset the clock —');
const old = (await adm.req('POST', '/receivables', bill({ billDate: addD(T, -70), partyType: 'Insurance / TPA' }))).data.receivable;
ok(old.status === 'overdue' && old.daysOutstanding === 70, '70-day TPA bill is overdue', old.status + '/' + old.daysOutstanding);
r = await stf.req('POST', `/receivables/${old.id}/override`, { value: 'disputed', reason: 'TPA rejected on 12 Jul, docs resent', expiresAt: addD(T, 15) });
ok(r.status === 403, 'a data-entry user cannot set an override');
r = await adm.req('POST', `/receivables/${old.id}/override`, { value: 'disputed', reason: 'short', expiresAt: addD(T, 15) });
ok(r.status === 400 && /10|reason/i.test(r.data.error), 'the reason must be substantive', r.data.error);
r = await adm.req('POST', `/receivables/${old.id}/override`, { value: 'made_up', reason: 'a perfectly good reason', expiresAt: addD(T, 15) });
ok(r.status === 400, 'override value must be from the list');
r = await adm.req('POST', `/receivables/${old.id}/override`, { value: 'disputed', reason: 'TPA rejected on 12 Jul, docs resent', expiresAt: addD(T, 60) });
ok(r.status === 400 && /45|expir/i.test(r.data.error), 'an override cannot run past 45 days', r.data.error);
r = await adm.req('POST', `/receivables/${old.id}/override`, { value: 'disputed', reason: 'TPA rejected on 12 Jul, docs resent', expiresAt: addD(T, -1) });
ok(r.status === 400, 'an override cannot expire in the past');

r = await adm.req('POST', `/receivables/${old.id}/override`, { value: 'disputed', reason: 'TPA rejected on 12 Jul, docs resent', expiresAt: addD(T, 15) });
ok(r.status === 200, 'admin sets the override');
ok(r.data.receivable.effectiveStatus === 'disputed', 'effective status is the override', r.data.receivable.effectiveStatus);
ok(r.data.receivable.status === 'overdue', 'the DERIVED status is untouched — still overdue', r.data.receivable.status);
ok(r.data.receivable.daysOutstanding === 70, 'the bill is still visibly 70 days old', r.data.receivable.daysOutstanding);
ok(r.data.receivable.override.setBy === 'Bhagavan' && r.data.receivable.override.reason.includes('TPA rejected'), 'who and why are recorded');
ok(r.data.actions.some(a => a.type === 'override_set'), 'the override is on the action log');

// expiry is silent
r = await adm.req('POST', `/receivables/${old.id}/override`, { value: 'payment_promised', reason: 'accounts promised by end of week', expiresAt: addD(T, 1) });
ok(r.status === 200 && r.data.receivable.effectiveStatus === 'payment_promised', 'an override can be replaced');
r = await adm.req('DELETE', `/receivables/${old.id}/override`);
ok(r.status === 200 && r.data.receivable.effectiveStatus === 'overdue', 'clearing it resumes the derived status', r.data.receivable.effectiveStatus);
ok(r.data.receivable.override === null, 'override gone from the row');
ok(r.data.actions.filter(a => a.type === 'override_cleared').length === 1, 'the clear is logged too — the history stays');
ok(r.data.actions.filter(a => a.type === 'override_set').length === 2, 'both overrides remain on the log', r.data.actions.filter(a => a.type === 'override_set').length);

console.log('— bulk moves work, never money —');
const b1 = (await adm.req('POST', '/receivables', bill())).data.receivable;
const b2 = (await adm.req('POST', '/receivables', bill())).data.receivable;
r = await adm.req('PATCH', '/receivables/bulk', { hid: 'mithra', ids: [b1.id, b2.id], assignedTo: 'Lalitha', nextFollowUp: addD(T, 5) });
ok(r.status === 200 && r.data.updated.length === 2, 'bulk assign + follow-up applied to both');
ok(r.data.updated.every(u => u.assignedTo === 'Lalitha' && u.nextFollowUp === addD(T, 5)), 'both rows updated');
r = await adm.req('PATCH', '/receivables/bulk', { hid: 'mithra', ids: [b1.id, b2.id], amount: 500, type: 'receipt' });
ok(r.status === 400, 'bulk cannot carry a receipt — money moves one row at a time');
r = await adm.req('PATCH', '/receivables/bulk', { hid: 'mithra', ids: [] });
ok(r.status === 400, 'bulk with no selection rejected');
r = await stf.req('PATCH', '/receivables/bulk', { hid: 'mithra', ids: [b1.id], assignedTo: 'X' });
ok(r.status === 200, 'staff can reassign chasing');

console.log('— scoping —');
r = await stf.req('POST', '/receivables', { ...bill(), hid: 'viraj' });
ok(r.status === 403, 'staff cannot reach a hospital they are not on');
const boot = (await stf.req('GET', '/bootstrap')).data;
ok(!boot.receivables.viraj, 'and viraj receivables are not in their bootstrap');
ok(Array.isArray(boot.receivables.mithra) && boot.receivables.mithra.length > 0, 'their own hospital is');
const abt = (await adm.req('GET', '/bootstrap')).data;
ok(Array.isArray(abt.recvActions.mithra) && abt.recvActions.mithra.length > 0, 'action log served in bootstrap');
ok(abt.partyTypes.length === 5 && abt.receiptModes.includes('UPI') && abt.overrideValues.includes('disputed'), 'the model constants reach the client');
ok(abt.adjThreshold === 5000 && abt.overrideMaxDays === 45, 'thresholds served', abt.adjThreshold + '/' + abt.overrideMaxDays);

console.log('— export —');
let xr = await fetch(B + '/receivables/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hid: 'mithra' }) });
ok(xr.status === 401, 'export needs a session');
const xcook = await (async () => { const res = await fetch(B + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bhagavan@yajnapharma.in', password: ADMIN_PW }) }); return res.headers.get('set-cookie').split(';')[0]; })();
xr = await fetch(B + '/receivables/export', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: xcook }, body: JSON.stringify({ hid: 'mithra' }) });
const buf = Buffer.from(await xr.arrayBuffer());
ok(xr.status === 200, 'export returns 200');
ok(buf.slice(0, 2).toString() === 'PK', 'it is a real XLSX, not a CSV with a lying extension', buf.slice(0, 4).toString('hex'));
ok(buf.length > 2000, 'and it has content', buf.length);
ok(/spreadsheetml/.test(xr.headers.get('content-type') || ''), 'served with the right content type', xr.headers.get('content-type'));

console.log('— DOM: the tab —');
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
setV('#loginEmail', 'bhagavan@yajnapharma.in');
doc.querySelector('#loginPw').value = ADMIN_PW;
click('#loginBtn'); await tick(700);
[...doc.querySelectorAll('[data-open2]')].find(b => b.dataset.open2 === 'mithra').click(); await tick(200);
ok(!!doc.querySelector('[data-htab="receivables"]'), 'Receivables is a hospital tab');
doc.querySelector('[data-htab="receivables"]').click(); await tick(300);
ok(txt('#content').includes('Total outstanding') && txt('#content').includes('Due for follow-up'), 'the tab renders its counters', txt('#content').slice(0, 120));
ok(!!doc.querySelector('#rcvAdd'), 'Add bill button present');

// add a bill through the UI
click('#rcvAdd'); await tick(150);
const uiNo = 'UI-' + Math.floor(Math.random() * 1e6);
setV('#rbNo', uiNo); setV('#rbParty', 'Apollo Munich'); setV('#rbAmt', '12000');
doc.querySelector('#rbType').value = 'Corporate';
click('#rbGo'); await tick(600);
const uiBill = w.eval("JSON.stringify(db.receivables.mithra.find(r=>r.billNo==='" + uiNo + "'))");
ok(uiBill && uiBill !== 'undefined', 'the bill was created from the UI');
const ub = JSON.parse(uiBill);
ok(ub.due === 12000 && ub.creditDays === 30, 'it lands with the right terms', ub.due + '/' + ub.creditDays);

// record a receipt through the UI
w.eval(`recvActionModal('mithra','receipt','${ub.id}')`); await tick(200);
ok(txt('#acAfter').includes('12,000'), 'the modal opens showing the amount due', txt('#acAfter'));
setV('#acAmt', '5000'); await tick(80);
ok(txt('#acAfter').includes('7,000'), 'it works out what will still be due before you commit', txt('#acAfter'));
doc.querySelector('#acMode').value = 'UPI';
click('#acGo'); await tick(600);
ok(JSON.parse(w.eval(`JSON.stringify(db.receivables.mithra.find(r=>r.id==='${ub.id}'))`)).due === 7000, 'the receipt landed — 7000 due', w.eval(`db.receivables.mithra.find(r=>r.id==='${ub.id}').due`));

// the detail panel shows the log with a running balance
w.eval(`state.rcvOpen='${ub.id}'; renderReceivables();`); await tick(250);
ok(txt('#content').includes('UPI'), 'the action log shows the mode');
ok(txt('#content').includes('5,000'), 'and the amount');

// derived status matrix, client side
ok(w.eval("derivedStatusOf(40,'Insurance / TPA')") === 'due_soon', 'client mirrors the server: 40d TPA = due soon');
ok(w.eval("derivedStatusOf(40,'Patient')") === 'critical', 'client mirrors the server: 40d patient = critical');
ok(w.eval("bucketOf(31)") === '31-60' && w.eval("bucketOf(91)") === '90+', 'aging buckets');

// the report reads the ledger
ok(w.eval("hasRecvLedger('mithra')") === true, 'the report knows there is a real ledger');
const mv = JSON.parse(w.eval(`JSON.stringify(recvMovement('mithra','${addD(T, -365)}','${T}'))`));
ok(Math.abs((mv.opening + mv.credit - mv.receipts - mv.adjustments) - mv.closing) < 0.01, 'Opening + Credit − Receipts − Adjustments = Closing', JSON.stringify(mv));
ok(mv.adjustments !== 0, 'adjustments are their own line, not folded into receipts', mv.adjustments);
// the movement block is monthly-only now — weekly gets rows + buckets, daily gets a rollup
const sec = w.eval(`recvAgingSection('mithra','${addD(T, -365)}','${T}','monthly')`);
ok(sec.includes('Opening receivables') && sec.includes('− Adjustments this month') && sec.includes('− Receipts this month') && sec.includes('= Closing receivables'),
  'the movement block prints all four lines');
ok(sec.includes('Aging bucket'), 'the aging table prints');
const secW = w.eval(`recvAgingSection('mithra','${addD(T, -7)}','${T}','weekly')`);
ok(!secW.includes('Movement this month'), 'weekly carries no movement block');
// as-of never leaks the future
const past = JSON.parse(w.eval(`JSON.stringify(recvAsOf('mithra','${addD(T, -100)}'))`));
ok(past.every(p => p.billDate <= addD(T, -100)), 'as-of never includes bills raised later');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
