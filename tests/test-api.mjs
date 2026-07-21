/* Full API test suite against the isolated test server on :3061 */

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const MANAGER_PW = process.env.SEED_MANAGER_PW || 'Test@Manager#1';
const USER_PW = process.env.SEED_USER_PW || 'Test@User#1';
const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name, extra ?? ''); } };

function jar() {
  let cookie = '';
  return {
    async req(method, path, body) {
      const r = await fetch(B + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      let data = {};
      try { data = await r.json(); } catch (e) {}
      return { status: r.status, data };
    }
  };
}
const today = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const addD = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const T = today(), Y = addD(T, -1), TM = addD(T, 1);

const adm = jar(), mgr = jar(), stf = jar();

console.log('— auth —');
let r = await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
ok(r.status === 200 && r.data.user.role === 'admin', 'admin login');
r = await adm.req('GET', '/bootstrap');
ok(r.status === 200 && Object.keys(r.data.hospitals).length === 3 && r.data.userList.length === 3, 'admin bootstrap: 3 hospitals + userList');
r = await jar().req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: 'nope' });
ok(r.status === 401, 'wrong password rejected');
r = await jar().req('GET', '/bootstrap');
ok(r.status === 401, 'unauthenticated bootstrap rejected');
r = await mgr.req('POST', '/login', { email: 'MANAGER@yajnapharma.in ', password: MANAGER_PW });
ok(r.status === 200 && r.data.user.role === 'admin', 'the old manager account logs in as an admin — the roles folded together', r.data.user && r.data.user.role);
r = await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });
ok(r.status === 200 && r.data.user.hospitals.join() === 'mithra' && r.data.user.active === true, 'staff login scoped to their hospital');

console.log('— entries —');
const entry = (mrp, actual) => ({
  purchases: [{ vendor: 'Sun Pharma Distributors', items: 10, value: 25000 }, { vendor: '', items: '', value: '' }],
  rtv: [{ drug: 'Tab. X', vendor: 'Sun Pharma Distributors', value: 500, reason: 'Expiry', status: 'Pending' }],
  sales: { mrp, cogs: Math.round(mrp * 0.65), cash: Math.round(mrp * 0.6), credit: Math.round(mrp * 0.4), cancels: 1 },
  audit: { opening: 400000, actual, unbilled: true, bounces: [{ drug: 'Tab. B', qty: 2, doctor: 'Dr. V', action: 'Pending' }] },
  hv: [{ drug: 'Inj. Meropenem 1g', opening: 5, received: 2, dispensed: 1, closing: 5 }] // mismatch: expected 6
});
r = await adm.req('PUT', `/entries/mithra/${TM}`, { entry: entry(80000, '') });
ok(r.status === 400, 'future date rejected');
r = await adm.req('PUT', '/entries/mithra/2026-7-1', { entry: entry(80000, '') });
ok(r.status === 400, 'malformed date rejected');
r = await adm.req('PUT', `/entries/nope/${T}`, { entry: entry(80000, '') });
ok(r.status === 404, 'unknown hospital rejected');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: 'garbage' });
ok(r.status >= 400, 'garbage entry payload rejected', r.status);
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: entry(80000, 372500) });
ok(r.status === 200 && r.data.savedAt > 0, 'entry saved');
ok(r.data.vendorsAdded.length === 1 && r.data.vendorsAdded[0].name === 'Sun Pharma Distributors', 'unknown vendor auto-registered (blank row skipped)');
const types = r.data.notifications.map(n => n.type).sort();
ok(JSON.stringify(types) === '["hv","unbilled","variance"]', 'all 3 alert types generated', types);
ok(r.data.hvTracked.length === 1 && r.data.hvTracked[0] === 'Inj. Meropenem 1g', 'hv tracked synced');
// variance math: expected = 400000+25000-52000=373000; actual 372500 → -500
ok(r.data.notifications.find(n => n.type === 'variance').msg.includes('500'), 'variance amount correct (Rs. 500)');
r = await adm.req('PUT', `/entries/mithra/${T}`, { entry: { ...entry(80000, 373000), audit: { opening: 400000, actual: 373000, unbilled: false, bounces: [] }, hv: [{ drug: 'Inj. Meropenem 1g', opening: 5, received: 2, dispensed: 1, closing: 6 }] } });
ok(r.status === 200 && r.data.notifications.length === 0, 're-save clean day: alerts regenerated to zero');
ok(r.data.vendorsAdded.length === 0, 'vendor not duplicated on re-save');
let boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.notifications.filter(n => n.date === T).length === 0, 'stale alerts removed from DB');
// staff scoping
r = await stf.req('PUT', `/entries/viraj/${T}`, { entry: entry(1000, '') });
ok(r.status === 403, 'staff blocked from other hospital');
r = await stf.req('PUT', `/entries/mithra/${Y}`, { entry: entry(9000, '') });
ok(r.status === 200, 'staff can enter a missed past day (no prior save)');
r = await stf.req('PUT', `/entries/mithra/${Y}`, { entry: entry(9500, '') });
ok(r.status === 403, 'staff blocked from editing saved past day');
r = await adm.req('PUT', `/entries/mithra/${Y}`, { entry: entry(9500, '') });
ok(r.status === 200, 'admin can edit saved past day');
r = await stf.req('PUT', `/entries/mithra/${T}`, { entry: entry(10000, '') });
ok(r.status === 200, 'staff can re-save today');
boot = (await stf.req('GET', '/bootstrap')).data;
ok(Object.keys(boot.hospitals).join(',') === 'mithra', 'staff bootstrap scoped to own hospital');
ok(boot.notifications.every(n => n.hid === 'mithra'), 'staff notifications scoped');
ok(!boot.userList, 'staff gets no userList');

console.log('— payments —');
const vid = (await adm.req('GET', '/bootstrap')).data.vendors.mithra[0].id;
r = await stf.req('POST', '/payments', { hid: 'mithra', vendorId: vid, amount: 100 });
ok(r.status === 403, 'staff cannot record payments');
r = await mgr.req('POST', '/payments', { hid: 'mithra', vendorId: 'bogus', amount: 100 });
ok(r.status === 404, 'unknown vendor rejected');
r = await mgr.req('POST', '/payments', { hid: 'mithra', vendorId: vid, amount: 0 });
ok(r.status === 400, 'zero amount rejected');
r = await mgr.req('POST', '/payments', { hid: 'mithra', vendorId: vid, amount: 5000, date: T, note: 'NEFT' });
ok(r.status === 200 && r.data.payment.amount === 5000, 'manager records payment');
r = await mgr.req('POST', '/payments', { hid: 'mithra', vendorId: vid, amount: 7000, date: 'bad-date' });
ok(r.status === 200 && r.data.payment.date === T, 'bad date falls back to today');

console.log('— vendors bulk —');
r = await mgr.req('POST', '/vendors/bulk', { hid: 'mithra', vendors: [{ name: 'Cipla Agencies', bal: 120000, credit: 21, phone: '+91 90000' }, { name: 'sun pharma distributors', bal: 1, credit: 30 }, { name: '', bal: 5 }] });
ok(r.status === 200 && r.data.created.length === 1 && r.data.created[0].name === 'Cipla Agencies', 'bulk import: dup (case-insens) + blank skipped');
r = await stf.req('POST', '/vendors/bulk', { hid: 'mithra', vendors: [] });
ok(r.status === 403, 'staff cannot bulk import');

console.log('— hospitals —');
r = await mgr.req('POST', '/hospitals', { name: 'Mgr Added Hospital' });
ok(r.status === 200, 'a manager/admin CAN add a hospital — one role, full access');
r = await stf.req('POST', '/hospitals', { name: 'User Added Hospital' });
ok(r.status === 403, 'a data-entry user cannot');
r = await adm.req('POST', '/hospitals', { name: '' });
ok(r.status === 400, 'blank name rejected');
r = await adm.req('POST', '/hospitals', { name: 'Test Hosp', doctor: 'Dr. T', location: 'BVRM', phone: '123', startDate: T });
const newHid = r.data.hospital?.id;
ok(r.status === 200 && r.data.hospital.active === true, 'admin adds hospital');
r = await adm.req('PATCH', `/hospitals/${newHid}`, { active: false, doctor: 'Dr. T2' });
ok(r.status === 200 && r.data.hospital.active === false && r.data.hospital.doctor === 'Dr. T2', 'patch hospital (deactivate + edit)');
r = await adm.req('PATCH', '/hospitals/bogus', { active: false });
ok(r.status === 404, 'patch unknown hospital 404');
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.hospitals[newHid] && boot.vendors[newHid].length === 0, 'new hospital in bootstrap with empty containers');

console.log('— report prefs —');
r = await adm.req('PUT', '/report-prefs/mithra/weekly', { prefs: { 1: true, 2: false, 14: true } });
ok(r.status === 200, 'prefs saved');
r = await adm.req('PUT', '/report-prefs/mithra/hourly', { prefs: {} });
ok(r.status === 400, 'bad report type rejected');
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.reportPrefs.mithra.weekly && boot.reportPrefs.mithra.weekly['2'] === false && boot.reportPrefs.mithra.weekly['14'] === true, 'prefs roundtrip in bootstrap');
r = await stf.req('PUT', '/report-prefs/viraj/daily', { prefs: { 1: true } });
ok(r.status === 403, 'staff cannot set other hospital prefs');

console.log('— notifications —');
await adm.req('PUT', `/entries/viraj/${T}`, { entry: entry(50000, 300000) }); // generates alerts
boot = (await adm.req('GET', '/bootstrap')).data;
const unread = boot.notifications.filter(n => !n.read);
ok(unread.length > 0, 'alerts exist');
r = await adm.req('PATCH', '/notifications/read', { ids: [unread[0].id] });
ok(r.status === 200, 'mark one read');
r = await adm.req('PATCH', '/notifications/read', { all: true });
boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.notifications.every(n => n.read), 'mark all read');

console.log('— users —');
r = await mgr.req('GET', '/users');
ok(r.status === 200, 'a manager/admin CAN manage users');
r = await stf.req('GET', '/users');
ok(r.status === 403, 'a data-entry user cannot');
r = await adm.req('POST', '/users', { name: 'A', email: 'bad', role: 'user', hospitals: ['mithra'], password: 'longenough1' });
ok(r.status === 400, 'invalid email rejected');
r = await adm.req('POST', '/users', { name: 'A', email: 'a@b.in', role: 'user', hospitals: ['nope'], password: 'longenough1' });
ok(r.status === 400, 'unknown hospital rejected');
r = await adm.req('POST', '/users', { name: 'A', email: 'a@b.in', role: 'user', hospitals: ['mithra'], password: 'short' });
ok(r.status === 400, 'short password rejected');
r = await adm.req('POST', '/users', { name: 'Test Staff', email: 'teststaff@yajnapharma.in', role: 'user', hospitals: ['viraj'], password: 'TempPass#123' });
ok(r.status === 200 && r.data.user.hospitals.join() === 'viraj', 'admin creates staff account');
const newUid = r.data.user.uid;
r = await adm.req('POST', '/users', { name: 'Dup', email: 'teststaff@yajnapharma.in', role: 'admin', hospitals: ['*'], password: 'TempPass#123' });
ok(r.status === 409, 'duplicate email rejected');
const nu = jar();
r = await nu.req('POST', '/login', { email: 'teststaff@yajnapharma.in', password: 'TempPass#123' });
ok(r.status === 200, 'new user can log in');
r = await adm.req('POST', `/users/${newUid}/password`, { password: 'NewPass#456' });
ok(r.status === 200, 'admin resets password');
r = await nu.req('GET', '/bootstrap');
ok(r.status === 401, 'old session killed after reset');
r = await nu.req('POST', '/login', { email: 'teststaff@yajnapharma.in', password: 'NewPass#456' });
ok(r.status === 200, 'login with reset password works');

console.log('— change own password / logout —');
r = await mgr.req('POST', '/password', { current: 'wrong', next: 'Whatever#123' });
ok(r.status === 400, 'wrong current password rejected');
r = await mgr.req('POST', '/password', { current: MANAGER_PW, next: 'Mgr#NewPass99' });
ok(r.status === 200, 'own password changed');
r = await jar().req('POST', '/login', { email: 'manager@yajnapharma.in', password: 'Mgr#NewPass99' });
ok(r.status === 200, 'login with changed password');
r = await stf.req('POST', '/logout');
ok(r.status === 200, 'logout ok');
r = await stf.req('GET', '/bootstrap');
ok(r.status === 401, 'session dead after logout');

console.log('— rate limit —');
let last;
for (let i = 0; i < 11; i++) last = await jar().req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: 'bad' + i });
ok(last.status === 429, 'login rate limit kicks in after repeated failures', last.status);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
