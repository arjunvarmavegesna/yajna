/* Tests: clearing data — one dataset at a time, admin only, name typed back */

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const USER_PW = process.env.SEED_USER_PW || 'Test@User#1';
const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };

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
const NAME = 'Mithra Medicare';

const adm = jar(), stf = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });

const entry = (o = {}) => ({ purchases: [{ vendor: 'ClearVendor', items: 1, value: 100 }], rtv: [], invoices: [], itemSales: [], hv: [],
  sales: { mrp: 1, cogs: 1, cash: 1, credit: 0, cancels: 0 }, cash: {}, audit: { opening: 0, actual: '', unbilled: true, bounces: [] }, ...o });
const counts = async (from, to) => (await adm.req('GET', `/clear/preview?hid=mithra&from=${from || T}&to=${to || T}`)).data.counts;

async function seed() {
  await adm.req('PUT', `/entries/mithra/${T}`, { entry: entry() });                 // + an alert (unbilled)
  await adm.req('PUT', `/entries/mithra/${addD(T, -40)}`, { entry: entry() });      // outside a short range
  await adm.req('POST', '/items/bulk', { hid: 'mithra', items: [{ name: 'ClearItem', nr: 1, mrp: 2 }] });
  await adm.req('POST', '/receivables', { hid: 'mithra', billNo: 'CLR-' + Math.floor(Math.random() * 1e6), billDate: T, party: 'P', partyType: 'Corporate', amount: 100 });
  await adm.req('POST', '/snapshots', { hid: 'mithra', asOf: T, rows: [{ name: 'X', batch: 'B', expiry: '2027-01', qty: 1, nr: 1, mrp: 2 }] });
  await adm.req('POST', '/stock/adjust', { hid: 'mithra', item: 'ClearItem', qty: -1, reason: 'Data correction', date: T });
}
await seed();

console.log('— the preview counts what is at stake —');
let c = await counts();
ok(c.entries === 1, "today's range sees 1 entry, not the 40-day-old one — ranged", c.entries);
ok((await counts('2000-01-01', T)).entries === 2, 'a wide range sees both');
ok(c.items === 1 && c.vendors === 1, 'unranged datasets count everything regardless of the range', c.items + '/' + c.vendors);

console.log('— the confirmation is the gate —');
let r = await adm.req('POST', '/clear', { hid: 'mithra', target: 'entries', from: T, to: T, confirm: 'wrong' });
ok(r.status === 400 && /type the hospital name/i.test(r.data.error), 'a wrong name is refused', r.data.error);
ok(r.data.error.includes(NAME), 'and the error names what to type', r.data.error);
ok((await counts()).entries === 1, 'and nothing was removed', (await counts()).entries);
r = await adm.req('POST', '/clear', { hid: 'mithra', target: 'entries', from: T, to: T, confirm: '  ' + NAME + ' ' });
ok(r.status === 200, 'the exact name (trimmed) goes through');

console.log('— validation —');
await seed();
r = await adm.req('POST', '/clear', { hid: 'mithra', target: 'nonsense', confirm: NAME });
ok(r.status === 400 && /unknown thing/i.test(r.data.error), 'an unknown target is refused', r.data.error);
r = await adm.req('POST', '/clear', { hid: 'mithra', target: 'entries', from: T, to: addD(T, -5), confirm: NAME });
ok(r.status === 400 && /starts after it ends/i.test(r.data.error), 'a backwards range is refused', r.data.error);
r = await adm.req('POST', '/clear', { hid: 'mithra', target: 'entries', from: 'x', to: 'y', confirm: NAME });
ok(r.status === 400, 'a ranged target needs a valid range');
r = await adm.req('POST', '/clear', { hid: 'nope', target: 'entries', from: T, to: T, confirm: NAME });
ok(r.status === 403 || r.status === 404, 'an unknown hospital is refused', r.status);

console.log('— permissions —');
r = await stf.req('POST', '/clear', { hid: 'mithra', target: 'entries', from: T, to: T, confirm: NAME });
ok(r.status === 403, 'a data-entry user cannot clear anything');
r = await stf.req('GET', '/clear/preview?hid=mithra&from=' + T + '&to=' + T);
ok(r.status === 403, 'nor even see the counts');
r = await stf.req('POST', '/clear', { hid: 'viraj', target: 'entries', from: T, to: T, confirm: 'Viraj Gastro' });
ok(r.status === 403, 'and cannot reach another hospital');

console.log('— each dataset clears ALONE —');
await seed();
let before = await counts('2000-01-01', T);
r = await adm.req('POST', '/clear', { hid: 'mithra', target: 'entries', from: T, to: T, confirm: NAME });
let after = await counts('2000-01-01', T);
ok(r.data.deleted === 1 && after.entries === before.entries - 1, 'clearing entries takes only the day in range', r.data.deleted);
ok(after.items === before.items, 'the Item Master is untouched');
ok(after.receivables === before.receivables, 'receivables are untouched');
ok(after.snapshots === before.snapshots, 'imported stock reports are untouched');
ok(after.adjustments === before.adjustments, 'stock adjustments are untouched');
ok(after.vendors === before.vendors, 'vendors are untouched');

console.log('— entries take their alerts with them —');
await seed();
let boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.notifications.some(n => n.date === T && n.hid === 'mithra'), 'the seeded day raised an alert');
await adm.req('POST', '/clear', { hid: 'mithra', target: 'entries', from: T, to: T, confirm: NAME });
boot = (await adm.req('GET', '/bootstrap')).data;
ok(!boot.notifications.some(n => n.date === T && n.hid === 'mithra'), 'clearing the day clears its alerts — no orphan pointing at nothing');

console.log('— a bill takes its whole action log —');
await seed();
const bill = (await adm.req('POST', '/receivables', { hid: 'mithra', billNo: 'ACT-' + Math.floor(Math.random() * 1e6), billDate: T, party: 'P', partyType: 'Corporate', amount: 500 })).data.receivable;
await adm.req('POST', `/receivables/${bill.id}/actions`, { type: 'receipt', amount: 100, mode: 'Cash', date: T });
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.recvActions.mithra.some(a => a.receivableId === bill.id), 'the receipt is on the log');
await adm.req('POST', '/clear', { hid: 'mithra', target: 'receivables', from: T, to: T, confirm: NAME });
boot = (await adm.req('GET', '/bootstrap')).data;
ok(!boot.receivables.mithra.some(x => x.id === bill.id), 'the bill is gone');
ok(!boot.recvActions.mithra.some(a => a.receivableId === bill.id), 'and its actions went with it — never orphaned');

console.log('— receivables range by BILL date, not by when they were paid —');
const oldBill = (await adm.req('POST', '/receivables', { hid: 'mithra', billNo: 'OLD-' + Math.floor(Math.random() * 1e6), billDate: addD(T, -60), party: 'P', partyType: 'Corporate', amount: 500 })).data.receivable;
await adm.req('POST', `/receivables/${oldBill.id}/actions`, { type: 'receipt', amount: 100, mode: 'Cash', date: T });   // paid today
await adm.req('POST', '/clear', { hid: 'mithra', target: 'receivables', from: T, to: T, confirm: NAME });
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.receivables.mithra.some(x => x.id === oldBill.id), 'a bill raised before the range survives, even though it was paid inside it');
await adm.req('POST', '/clear', { hid: 'mithra', target: 'receivables', from: '2000-01-01', to: T, confirm: NAME });

console.log('— Opening stock clears WITHOUT taking the item master —');
await seed();
await adm.req('POST', '/items/opening', { hid: 'mithra', stockDate: addD(T, -5), rows: [{ name: 'OpenA', qty: 100, nr: 10, mrp: 20, batch: 'OB1' }, { name: 'OpenB', qty: 50, nr: 5, mrp: 9 }] });
ok((await counts()).opening === 2, 'the preview counts items carrying an opening count', (await counts()).opening);
boot = (await adm.req('GET', '/bootstrap')).data;
const itemsBefore = boot.items.mithra.length;
// a real load record exists now — the actual bug report: this permanent
// audit-log entry must NOT keep warning "already loaded" after the data it
// describes is genuinely cleared
await adm.req('POST', '/opening-loads', { hid: 'mithra', stockDate: addD(T, -5), itemsCount: 2, valueNr: 1250, valueMrp: 2450, fileName: 'seed.xlsx', source: 'template' });
let loadCheck = await adm.req('GET', '/opening-loads?hid=mithra');
ok(loadCheck.data.hasCurrentOpening === true, 'before clearing: real opening data exists, so hasCurrentOpening is true', loadCheck.data.hasCurrentOpening);
r = await adm.req('POST', '/clear', { hid: 'mithra', target: 'opening', confirm: NAME });
ok(r.status === 200 && r.data.deleted === 2, 'clearing opening stock reports what it zeroed', r.data.deleted);
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.items.mithra.length === itemsBefore, 'the items are all still there — this is not the master', boot.items.mithra.length + ' vs ' + itemsBefore);
ok(boot.items.mithra.every(i => i.openingQty === 0), 'but every opening count is zero');
ok((boot.openingBatches.mithra || []).length === 0, 'and the batch rows behind it are gone too — nothing orphaned for the next load to collide with', (boot.openingBatches.mithra || []).length);
const opA = boot.items.mithra.find(i => i.name === 'OpenA');
ok(opA && opA.nr === 10 && opA.mrp === 20, 'and the negotiated prices survived — you can re-do a bad count without losing them', opA && opA.nr + '/' + opA.mrp);
ok(boot.hospitals.mithra.stockDate === null, 'the counted-from anchor is dropped with the count', boot.hospitals.mithra.stockDate);
ok((await counts()).opening === 0, 'and the preview drops to nothing');
loadCheck = await adm.req('GET', '/opening-loads?hid=mithra');
ok(loadCheck.data.loads.length >= 1, 'the load RECORD itself still exists — it is a permanent audit log, never cleared alongside the data', loadCheck.data.loads.length);
ok(loadCheck.data.hasCurrentOpening === false, 'but hasCurrentOpening now correctly reads false — the "already loaded" warning must not fire on a record this stale', loadCheck.data.hasCurrentOpening);

console.log('— the Item Master takes the opening count with it —');
await seed();
await adm.req('POST', '/items/opening', { hid: 'mithra', stockDate: addD(T, -5), rows: [{ name: 'ClearItem', qty: 50, nr: 1, mrp: 2, batch: 'CI1' }] });
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.hospitals.mithra.stockDate === addD(T, -5), 'the counted-from date is set');
ok((boot.openingBatches.mithra || []).some(b => b.key === 'clearitem'), 'a real batch row exists for it', JSON.stringify(boot.openingBatches.mithra));
r = await adm.req('POST', '/clear', { hid: 'mithra', target: 'items', confirm: NAME });
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.items.mithra.length === 0, 'the master is empty');
ok(boot.hospitals.mithra.stockDate === null, 'and the counted-from date is reset — the anchor went with the count', boot.hospitals.mithra.stockDate);
ok((boot.openingBatches.mithra || []).length === 0, 'and its batch rows are gone too — clearing the master promises "AND the opening stock count", so nothing orphaned survives underneath it', JSON.stringify(boot.openingBatches.mithra));

console.log('— clearing never reaches another hospital —');
await adm.req('PUT', `/entries/viraj/${T}`, { entry: entry() });
await adm.req('POST', '/clear', { hid: 'mithra', target: 'entries', from: '2000-01-01', to: T, confirm: NAME });
const vc = (await adm.req('GET', `/clear/preview?hid=viraj&from=2000-01-01&to=${T}`)).data.counts;
ok(vc.entries === 1, "viraj's entry is still there", vc.entries);
await adm.req('POST', '/clear', { hid: 'viraj', target: 'entries', from: '2000-01-01', to: T, confirm: 'Viraj Gastro' });

console.log('— deleting a hospital: the impact is countable first —');
await adm.req('PUT', `/entries/siri/${T}`, { entry: entry() });
await adm.req('POST', '/items/bulk', { hid: 'siri', items: [{ name: 'SiriItem', nr: 1, mrp: 2 }] });
let I = (await adm.req('GET', '/hospitals/siri/impact')).data;
ok(I.rows.entries === 1 && I.rows.items === 1, 'the impact counts each table that would go', JSON.stringify(I.rows));
ok(I.total >= 2, 'and totals them', I.total);
ok(I.remaining === 2, 'and says what would be left', I.remaining);
ok(I.stranded.length === 0, 'nobody is scoped only to siri');
I = (await adm.req('GET', '/hospitals/mithra/impact')).data;
ok(I.stranded.some(u => u.email === 'staff.mithra@yajnapharma.in'),
   'but the mithra-only data-entry user IS named as stranded — before the delete, not after', JSON.stringify(I.stranded));

console.log('— the gates —');
r = await adm.req('DELETE', '/hospitals/siri', { confirm: 'wrong' });
ok(r.status === 400 && /type the hospital name/i.test(r.data.error), 'a wrong name is refused', r.data.error);
r = await stf.req('DELETE', '/hospitals/siri', { confirm: 'Siri Emergency Hospital' });
ok(r.status === 403, 'a data-entry user cannot delete a hospital');
r = await stf.req('GET', '/hospitals/siri/impact');
ok(r.status === 403, 'nor see the impact');
r = await adm.req('DELETE', '/hospitals/nope', { confirm: 'x' });
ok(r.status === 404, 'an unknown hospital 404s');

console.log('— it takes everything with it —');
r = await adm.req('DELETE', '/hospitals/siri', { confirm: 'Siri Emergency Hospital' });
ok(r.status === 200 && r.data.deleted >= 2, 'siri deleted, rows reported', r.data.deleted);
boot = (await adm.req('GET', '/bootstrap')).data;
ok(!boot.hospitals.siri, 'the hospital is gone');
ok(!boot.dailyData.siri && !boot.items.siri, 'and all of its data with it');
ok(!!boot.hospitals.viraj && !!boot.hospitals.mithra, 'the others are untouched');

console.log('— a user is never left pointing at a hospital that no longer exists —');
r = await adm.req('DELETE', '/hospitals/mithra', { confirm: 'Mithra Medicare' });
ok(r.status === 200, 'mithra deleted');
ok(r.data.stranded.includes('Lakshmi D'), 'and the response names who it stranded', JSON.stringify(r.data.stranded));
const users = (await adm.req('GET', '/users')).data.users;
const lak = users.find(u => u.email === 'staff.mithra@yajnapharma.in');
ok(!lak.hospitals.includes('mithra'), 'her scope no longer names the deleted hospital', JSON.stringify(lak.hospitals));
// her session was killed because her scope changed under her
const stf2 = jar();
r = await stf2.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });
ok(r.status === 200 && r.data.user.hospitals.length === 0, 'she can still sign in, but with no hospital — visible, not silent', JSON.stringify(r.data.user.hospitals));

console.log('— the last hospital cannot be deleted —');
r = await adm.req('DELETE', '/hospitals/viraj', { confirm: 'Viraj Gastro' });
ok(r.status === 400 && /only hospital/i.test(r.data.error), 'the console would have nothing to show', r.data.error);
boot = (await adm.req('GET', '/bootstrap')).data;
ok(!!boot.hospitals.viraj, 'so it is still there');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
