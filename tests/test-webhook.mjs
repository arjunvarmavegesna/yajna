/* Tests: the inbound WhatsApp webhook — the signature IS the authentication. */
import crypto from 'crypto';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const SECRET = process.env.TAI_WEBHOOK_SECRET || 'test-webhook-secret';

const B = 'http://127.0.0.1:3061';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }};
}
const hook = async (payload, sig) => {
  const raw = JSON.stringify(payload);
  const s = sig === undefined ? crypto.createHmac('sha256', SECRET).update(raw).digest('hex') : sig;
  const r = await fetch(B + '/wa/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(s === null ? {} : { 'x-thinkai-signature': s }) }, body: raw });
  return r.status;
};

const adm = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await adm.req('PATCH', '/hospitals/viraj', { doctorPhone: '+91 98111 22233' });
await adm.req('POST', '/items', { hid: 'viraj', name: 'Tab. Hook Test', pack: '10s', nr: 100, mrp: 200 });
const off = (await adm.req('POST', '/offers', { hid: 'viraj', item: 'Tab. Hook Test', newNr: 90, negotiatedBy: 'Bhagavan' })).data.offer;
await adm.req('POST', `/offers/${off.id}/request-approval`);

console.log('— nothing gets in without the signature —');
const msg = (text, id) => ({ event: 'incoming_message', id: id || 'e1', data: { from: '+919811122233', text, type: 'text', messageId: id || 'm1' } });
ok(await hook(msg('hello'), null) === 401, 'no signature header → 401');
ok(await hook(msg('hello'), 'sha256=deadbeef') === 401, 'a wrong signature → 401');
ok(await hook(msg('checking rate', 'm-hex')) === 200, 'a correctly signed hex HMAC is accepted');
const raw2 = JSON.stringify(msg('base64 works too', 'm-b64'));
const b64 = crypto.createHmac('sha256', SECRET).update(raw2).digest('base64');
const r2 = await fetch(B + '/wa/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-thinkai-signature': b64 }, body: raw2 });
ok(r2.status === 200, 'and so is the base64 form of the same HMAC');

console.log('— a doctor reply becomes visible in the console —');
await new Promise(r => setTimeout(r, 300));       // the handler runs after the fast ack
const boot = (await adm.req('GET', '/bootstrap')).data;
ok(boot.notifications.some(n => n.type === 'doctor_reply' && /checking rate/.test(n.msg)), 'the reply lands as an alert on the hospital', JSON.stringify(boot.notifications[0]));
const acts = boot.offerActions.viraj.filter(a => a.offerId === off.id);
ok(acts.some(a => /WhatsApp reply/.test(a.note) && /checking rate/.test(a.note)), 'and onto the log of the offer that is with the doctor', JSON.stringify(acts.map(a => a.note)));
ok(boot.offers.viraj.find(o => o.id === off.id).status === 'proposed', 'but a chat message NEVER approves — the signed link is the only signature');

console.log('— retries and strangers —');
const before = (await adm.req('GET', '/bootstrap')).data.notifications.length;
await hook(msg('checking rate', 'm-hex'));        // TAI retry: same messageId
await new Promise(r => setTimeout(r, 250));
ok((await adm.req('GET', '/bootstrap')).data.notifications.length === before, 'a retried delivery (same message id) is deduped');
await hook({ event: 'incoming_message', id: 'x9', data: { from: '+919999900000', text: 'spam', type: 'text', messageId: 'x9' } });
await new Promise(r => setTimeout(r, 250));
ok(!(await adm.req('GET', '/bootstrap')).data.notifications.some(n => /spam/.test(n.msg)), 'a number that is no doctor is ignored');
ok(await hook({ event: 'message_status', id: 's1', data: { messageId: 'm1', status: 'delivered' } }) === 200, 'status receipts are acked and dropped');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
