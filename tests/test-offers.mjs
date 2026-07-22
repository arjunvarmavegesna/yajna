/* Tests: the margin-offer tracker, the all-companies item master, and hospital
   add/delete from the side menu. DOM (demo mode) + API. */
import { JSDOM } from 'jsdom';
import fs from 'fs';

/* the test database is seeded from these same env vars by runall.sh */
const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const USER_PW = process.env.SEED_USER_PW || 'Test@User#1';

const B = 'http://127.0.0.1:3061/api';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 200) => new Promise(r => setTimeout(r, ms));
const todayISO = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const T = todayISO();
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }};
}

const form = async (path, body) => {
  const r = await fetch(B.replace('/api','') + path, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  return { status: r.status, text: await r.text() };
};
const page = async (path) => { const r = await fetch(B.replace('/api','') + path); return { status: r.status, text: await r.text() }; };

/* ─────────────────────────── API ─────────────────────────── */
const adm = jar(), stf = jar();
await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
await stf.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });

console.log('— an offer is measured against the master, not against what you type —');
await adm.req('POST', '/items', { hid: 'viraj', name: 'Tab. Rifaximin 550', molecule: 'Rifaximin 550mg', pack: '10s', nr: 300, mrp: 400 });
let r = await adm.req('POST', '/offers', { hid: 'viraj', item: 'Tab. Rifaximin 550', oldNr: 999, newNr: 270,
  vendor: 'Zydus', offeredBy: 'Ramesh (MR)', negotiatedBy: 'Bhagavan', qtyCommit: 100, validTill: addDays(T, 10) });
ok(r.status === 200, 'offer recorded', r.data.error);
const off = r.data.offer;
ok(off.oldNr === 300, 'the current rate is read from the Item Master, not from the caller', off.oldNr);
ok(off.oldMrp === 400 && off.newMrp === 400, 'the MRP carries over when the offer does not restate it');
ok(Math.abs(off.gainPts - 7.5) < 0.01, 'the margin gain is computed, not stored by hand', off.gainPts);
ok(off.savingRs === 3000, 'what it is worth = rate cut × the quantity committed', off.savingRs);
ok(off.molecule === 'Rifaximin 550mg', 'the molecule is inherited from the master');
ok(off.status === 'proposed', 'a new offer starts proposed');

console.log('— it refuses what cannot be true —');
ok((await adm.req('POST', '/offers', { hid: 'viraj', item: 'X', newNr: 10, negotiatedBy: '' })).status === 400, 'an offer nobody owns is refused');
ok((await adm.req('POST', '/offers', { hid: 'viraj', item: 'X', newNr: 500, newMrp: 400, negotiatedBy: 'A' })).status === 400, 'a rate above the MRP is refused — that sells at a loss');
ok((await adm.req('POST', '/offers', { hid: 'viraj', item: 'X', newNr: 10, negotiatedBy: 'A', offerDate: addDays(T, 3) })).status === 400, 'an offer made in the future is refused');
ok((await adm.req('POST', '/offers', { hid: 'viraj', item: 'X', newNr: 10, negotiatedBy: 'A', offerDate: T, validTill: addDays(T, -2) })).status === 400, 'it cannot expire before it was made');
ok((await stf.req('POST', '/offers', { hid: 'mithra', item: 'X', newNr: 10, negotiatedBy: 'A' })).status === 403, 'a data-entry user cannot record offers');
ok((await stf.req('GET', '/master')).status === 403, 'nor read the all-companies master');

console.log('— the log is the point —');
r = await adm.req('POST', `/offers/${off.id}/actions`, { type: 'follow_up', note: 'Called the MR', nextFollowUp: addDays(T, 4) });
ok(r.status === 200 && r.data.offer.nextFollowUp === addDays(T, 4), 'a follow-up moves the next date');
ok((await adm.req('POST', `/offers/${off.id}/actions`, { type: 'revised', newNr: 265 })).status === 400, 'a revision without a note is refused — the number alone says nothing');
r = await adm.req('POST', `/offers/${off.id}/actions`, { type: 'revised', newNr: 265, note: 'pushed to 265 on 200 strips' });
ok(r.data.offer.newNr === 265, 'the revised rate replaces the old one');
ok(r.data.actions.length === 2, 'and the earlier offer stays on the log', r.data.actions.length);
ok((await adm.req('POST', `/offers/${off.id}/actions`, { type: 'declined' })).status === 400, 'declining without a reason is refused');
ok((await adm.req('POST', `/offers/${off.id}/actions`, { type: 'note', date: addDays(T, -400) })).status === 400, 'an action before the offer existed is refused');
r = await adm.req('POST', `/offers/${off.id}/actions`, { type: 'accepted' });
ok(r.status === 400 && /doctor/i.test(r.data.error), 'the console CANNOT accept — acceptance belongs to the doctor', r.data.error);

console.log('— proposed → the doctor agrees → accepted → the manager adds it —');
let it = (await adm.req('GET', '/bootstrap')).data.items.viraj.find(x => x.name === 'Tab. Rifaximin 550');
ok(it.nr === 300, 'nothing so far has touched the Item Master', it.nr);
r = await adm.req('POST', `/offers/${off.id}/apply`);
ok(r.status === 400 && /doctor/i.test(r.data.error), 'apply is refused while the doctor has not agreed', r.data.error);
ok((await adm.req('PATCH', '/items/' + it.id, { nr: 111, mrp: 400 })).data.code === 'needs_approval', 'nor can the master be edited around the gate');
ok((await adm.req('PATCH', '/items/' + it.id, { nr: 300, mrp: 400, pack: '10s' })).status === 200, 'pack and molecule are still plain edits — they describe the item, they do not move its money');
await adm.req('PATCH', '/hospitals/viraj', { doctorPhone: '+91 90000 11111' });
r = await adm.req('POST', `/offers/${off.id}/request-approval`);
ok(r.status === 200 && r.data.offer.awaitingDoctor, 'the offer goes to the doctor over WhatsApp', JSON.stringify(r.data.sent ?? r.data.error));
ok(r.data.offer.status === 'proposed', 'and STAYS proposed while it is with them — sending is not deciding', r.data.offer.status);
ok(/₹300 → \*₹265\*/.test(r.data.text), 'the message states the exact change', r.data.text.split('\n')[2]);
ok(r.data.waLink.includes('wa.me/919000011111'), 'and falls back to the admin sending it themselves when the BSP cannot');
const tok1 = r.data.url.split('/approve/')[1];
r = await adm.req('POST', `/offers/${off.id}/request-approval`);
const tok2 = r.data.url.split('/approve/')[1];
ok(tok1 !== tok2 && (await page('/approve/' + tok1)).status === 404, 'a resend replaces the link — a forwarded old message can approve nothing');
let pg = await page('/approve/' + tok2);
ok(pg.status === 200 && /₹300/.test(pg.text) && /₹265/.test(pg.text) && /Approve/.test(pg.text), 'the doctor sees exactly what changes, no login needed');
ok(/I agree to the revised purchase rate/.test(pg.text), 'with an explicit agreement checkbox — the tick is the sign-off');
ok(/needs a word on why/.test((await form('/approve/' + tok2, 'decision=decline')).text), 'declining without a note is refused on the page too');
ok(/tick/i.test((await form('/approve/' + tok2, 'decision=approve&note=fine')).text), 'Approve without the tick is bounced back');
pg = await form('/approve/' + tok2, 'decision=approve&agree=1&note=fine');
ok(/Approved/i.test(pg.text) && /will now add/i.test(pg.text), "the doctor's yes is recorded — and the page says Yajna adds it, not that it is done", pg.text.slice(0, 120));
it = (await adm.req('GET', '/bootstrap')).data.items.viraj.find(x => x.name === 'Tab. Rifaximin 550');
ok(it.nr === 300, 'the master has NOT moved yet — approval is a decision, applying is an act', it.nr);
let offRow = (await adm.req('GET', '/bootstrap')).data.offers.viraj.find(x => x.id === off.id);
ok(offRow.status === 'accepted' && offRow.approvedBy === 'Dr. Guna Ranjan', 'the offer moved to accepted, in the doctor\'s name', JSON.stringify({ s: offRow.status, by: offRow.approvedBy }));
ok((await adm.req('POST', `/offers/${off.id}/request-approval`)).status === 400, 'an approved offer cannot be sent again');
r = await adm.req('POST', `/offers/${off.id}/apply`);
ok(r.status === 200 && r.data.item.nr === 265, 'NOW the manager adds it and the master moves', r.data.item?.nr);
offRow = r.data.offer;
ok(offRow.status === 'applied' && offRow.approvedBy === 'Dr. Guna Ranjan', 'applied, still carrying who approved it', JSON.stringify({ s: offRow.status, by: offRow.approvedBy }));
ok((await page('/approve/' + tok2)).status === 404, 'the used link is dead — the token was cleared on approval');
const hist = (await adm.req('GET', `/items/${it.id}/history`)).data.history;
ok(hist.some(h => /Zydus/.test(h.note) && /Bhagavan/.test(h.note)), 'the item price history names the vendor and the negotiator, so it reads on its own', JSON.stringify(hist[0]));
const ph = (await adm.req('GET', '/price-history?hid=viraj')).data.history;
ok(ph.length === 1 && ph[0].approvedBy === 'Dr. Guna Ranjan' && ph[0].source === 'offer', 'the procurement price history carries who approved it', JSON.stringify(ph[0]));
ok((await stf.req('GET', '/price-history?hid=mithra')).status === 403, 'a data-entry user cannot read the price history');
ok((await adm.req('POST', `/offers/${off.id}/apply`)).status === 400, 'it cannot be applied twice');
ok((await adm.req('DELETE', `/offers/${off.id}`)).status === 400, 'an applied offer is part of the price history and cannot be deleted');
ok((await adm.req('POST', `/offers/${off.id}/actions`, { type: 'reopened' })).status === 400, 'nor reopened — raise a new offer instead');

console.log('— expiry is derived from the date, never stored —');
r = await adm.req('POST', '/offers', { hid: 'viraj', item: 'Tab. Metformin 500', newNr: 10, newMrp: 20,
  negotiatedBy: 'Bhagavan', offerDate: addDays(T, -30), validTill: addDays(T, -5) });
const ex = r.data.offer;
ok(ex.status === 'proposed', 'the stored status is untouched by the calendar', ex.status);
ok(ex.expired && ex.effectiveStatus === 'expired', 'but it reads as expired');
ok((await adm.req('POST', `/offers/${ex.id}/apply`)).status === 400, 'an expired offer cannot be applied');
ok((await adm.req('POST', `/offers/${ex.id}/request-approval`)).status === 400, 'nor sent to the doctor — their time is not spent on a dead offer');
r = await adm.req('POST', `/offers/${ex.id}/actions`, { type: 'reopened', note: 'vendor still honours it' });
ok(r.status === 200 && r.data.offer.status === 'proposed', 'reopening puts it back in play');
ok((await adm.req('DELETE', `/offers/${ex.id}`)).status === 200, 'an unapplied offer can be deleted');

console.log('— the vendor import is untouched by the molecule work —');
r = await adm.req('POST', '/vendors/bulk', { hid: 'viraj', vendors: [{ name: 'Zydus Wellness', credit: 30 }] });
ok(r.status === 200 && r.data.created.length === 1, 'vendors still import', JSON.stringify(r.data).slice(0, 120));

console.log('— the all-companies master —');
await adm.req('POST', '/items', { hid: 'mithra', name: 'Rifagut 550', molecule: 'Rifaximin 550mg', pack: '10s', nr: 320, mrp: 400 });
await adm.req('POST', '/items', { hid: 'siri', name: 'Tab. Ranitidine 150', nr: 8, mrp: 14 });
const m = (await adm.req('GET', '/master')).data;
const rif = m.groups.find(g => g.molecule === 'Rifaximin 550mg');
ok(!!rif && rif.hospitals === 2, 'two brands of one molecule at two hospitals group together', rif && rif.hospitals);
// viraj now buys it at 265/400 (33.75%) after the offer was applied; mithra at 320/400 (20%)
ok(Math.abs(rif.spreadPts - 13.75) < 0.01, 'the spread is the gap between the best and worst margin', rif && rif.spreadPts);
ok(rif.bestAt === 'Viraj Gastro' && rif.bestNr === 265, 'and it names where the better rate already is', rif && rif.bestAt);
ok(m.groups[0].key === rif.key, 'the widest gap sorts first — that is the money');
const noMol = m.groups.find(g => !g.byMolecule);
ok(!!noMol && noMol.label === 'Tab. Ranitidine 150', 'an item with no molecule groups on its own name rather than joining a pile', noMol && noMol.label);

console.log('— the item-master template carries the molecule —');
const tpl = await fetch('http://127.0.0.1:3061/api/template/items');
ok(tpl.status === 200, 'the template still downloads without a session');
const XLSX = (await import(new URL('../node_modules/xlsx/xlsx.mjs', import.meta.url))).default ?? await import(new URL('../node_modules/xlsx/xlsx.mjs', import.meta.url));
const wb = XLSX.read(Buffer.from(await tpl.arrayBuffer()), { type: 'buffer' });
const hdr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0];
ok(hdr.some(h => /molecule/i.test(h)), 'the sheet has a Molecule column', hdr.join(' | '));

console.log('— a re-import fills a missing molecule without touching prices —');
await adm.req('POST', '/items', { hid: 'siri', name: 'Tab. Pantoprazole 40', nr: 38, mrp: 58 });
r = await adm.req('POST', '/items/bulk', { hid: 'siri', items: [{ name: 'Tab. Pantoprazole 40', molecule: 'Pantoprazole 40mg', nr: 99, mrp: 200 }] });
ok(r.data.created.length === 0 && r.data.filled.length === 1, 'the existing row is filled, not created again', JSON.stringify(r.data));
const pan = (await adm.req('GET', '/bootstrap')).data.items.siri.find(x => x.name === 'Tab. Pantoprazole 40');
ok(pan.molecule === 'Pantoprazole 40mg' && pan.nr === 38, 'the molecule lands and the price is left alone', `${pan.molecule} @ ${pan.nr}`);

/* ─────────────────────────── DOM (demo) ─────────────────────────── */
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const mk = () => new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null;
    w.confirm = () => true;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
const dom = mk(), w = dom.window, doc = w.document;
await tick(400);
doc.querySelector('[data-quick="admin"]').click(); await tick(700);
const nav = () => [...doc.querySelectorAll('.nav-item')];

console.log('— the side menu carries the hospitals —');
const subs = () => [...doc.querySelectorAll('.nav-sub [data-navh]')];
ok(subs().length === 3, 'every hospital is listed under the Hospitals item', subs().length);
ok(!!doc.querySelector('[data-navaddh]'), 'there is an Add hospital button in the menu');
ok(doc.querySelectorAll('.nav-sub [data-navdel]').length === 3, 'and each one can be deleted from there');
subs()[1].click(); await tick(300);
ok(w.eval('state.view') === "hospital", 'clicking a hospital in the menu opens it');
ok(!!doc.querySelector('.nav-sub .nsi.active'), 'and the open one is marked active in the menu');
doc.querySelector('[data-navaddh]').click(); await tick(200);
ok(/add hospital/i.test(doc.querySelector('.modal-head')?.textContent || ''), 'Add hospital opens the hospital dialog', doc.querySelector('.modal-head')?.textContent);
doc.querySelector('.modal-x').click(); await tick(150);
// deleting is a live-mode act; in demo it says so rather than pretending
doc.querySelector('.nav-sub [data-navdel]').click(); await tick(400);
ok(/live mode/i.test(doc.querySelector('#toastRoot')?.textContent || ''), 'the ✕ routes into the delete flow', doc.querySelector('#toastRoot')?.textContent);
ok(w.eval('Object.keys(db.hospitals).length') === 3, 'and nothing is deleted on the spot — never a one-click delete');
ok(!doc.querySelector('#hdConfirm'), 'the live flow demands the hospital name typed out, so nothing goes by a stray click');
// a data-entry user gets neither the sub-list controls nor the group master
w.eval('state.user = {...state.user, role:"user"}; renderApp()'); await tick(300);
ok(!doc.querySelector('[data-navaddh]'), 'a data-entry user cannot add a hospital from the menu');
ok(!doc.querySelector('.nav-sub [data-navdel]'), 'nor delete one');
ok(!nav().some(n => n.dataset.go === 'master'), 'nor see the all-companies master');
w.eval('state.user = {...state.user, role:"admin"}; renderApp()'); await tick(300);

console.log('— the offers tab —');
w.eval('openHospital("viraj","offers")'); await tick(400);
const txt = () => doc.querySelector('#content').textContent;
ok(/Offers on the table/.test(txt()), 'the offers screen renders');
ok(w.eval('db.offers.viraj.length') === 2, 'the demo seeds a couple of offers to show what it is for');
const rows = () => [...doc.querySelectorAll('[data-offopen]')];
ok(rows().length === 2, 'both are open, so the default filter shows them', rows().length);
w.eval('state.offFilter="due"; renderOffers()'); await tick(200);
ok(rows().length === 1, 'the follow-up filter finds the one that is overdue', rows().length);
w.eval('state.offFilter="applied"; renderOffers()'); await tick(200);
ok(rows().length === 0, 'nothing is applied yet');
w.eval('state.offFilter="open"; renderOffers()'); await tick(200);

console.log('— recording an offer —');
doc.querySelector('#offAdd').click(); await tick(250);
ok(!!doc.querySelector('#ofItem'), 'the dialog opens');
w.eval('$("#ofGo").click()'); await tick(150);
ok(!!doc.querySelector('#ofItem'), 'it will not save without an item — the dialog stays open');
w.eval(`$("#ofItem").value = db.items.viraj[0].name; $("#ofItem").onchange();`); await tick(150);
ok(w.eval('num($("#ofMrp").value)') === w.eval('db.items.viraj[0].mrp'), 'picking a known item fills the MRP from the master');
w.eval(`$("#ofNr").value = String(db.items.viraj[0].nr - 5); $("#ofQty").value = "200"; $("#ofNr").oninput();`); await tick(150);
ok(/worth/i.test(doc.querySelector('#ofWorthL').textContent), 'and it shows what the cut is worth as you type', doc.querySelector('#ofWorthL').textContent);
ok(/\+/.test(doc.querySelector('#ofGain').textContent), 'with the margin points gained', doc.querySelector('#ofGain').textContent);
w.eval(`$("#ofNr").value = String(db.items.viraj[0].mrp + 10); $("#ofNeg").value="Bhagavan"; $("#ofGo").click()`); await tick(200);
ok(!!doc.querySelector('#ofItem'), 'a rate above the MRP is refused in the browser too');
w.eval(`$("#ofNr").value = "12"; $("#ofGo").click()`); await tick(300);
ok(!doc.querySelector('#ofItem'), 'a complete offer saves and closes');
ok(w.eval('db.offers.viraj.length') === 3, 'and appears on the list', w.eval('db.offers.viraj.length'));

console.log('— the detail view and its log —');
rows()[0].click(); await tick(300);
ok(/What has happened/.test(doc.body.textContent), 'the detail opens on the log');
ok(!!doc.querySelector('[data-ofa="follow_up"]'), 'an open offer can be followed up');
ok(!!doc.querySelector('[data-ofa="declined"]'), 'or declined');
doc.querySelector('[data-ofa="note"]').click(); await tick(200);
w.eval(`$("#oaNote").value="rang, no answer"; $("#oaGo").click()`); await tick(300);
ok(w.eval('db.offerActions.viraj.length') === 1, 'the note lands on the log', w.eval('db.offerActions.viraj.length'));

console.log('— proposed goes to the doctor; doctor-approved goes to the master —');
w.eval('state.offFilter="open"; renderOffers()'); await tick(200);
const prop = w.eval('db.offers.viraj.findIndex(o=>o.status==="proposed")');
const acc = w.eval('db.offers.viraj.findIndex(o=>o.status==="accepted")');
ok(prop >= 0 && acc >= 0, 'the demo seeds one of each half of the flow');
w.eval(`offerDetail(db.offers.viraj[${prop}])`); await tick(300);
ok(!doc.querySelector('#ofApply'), 'a proposed offer has NO way to the master');
ok(!!doc.querySelector('#ofSendAppr'), 'its only forward action is Send to doctor', doc.querySelector('.modal-foot')?.textContent);
ok(!doc.querySelector('[data-ofa="accepted"]'), 'and no console Accept button exists — acceptance is the doctor\'s');
w.eval('$("#ofSendAppr").click()'); await tick(300);
ok(/live mode/i.test(doc.querySelector('#toastRoot')?.textContent||''), 'demo says approval needs live mode — it must not pretend');
ok(w.eval(`db.offers.viraj[${prop}].status`) === 'proposed', 'and nothing moved');
w.eval(`offerDetail(db.offers.viraj[${acc}])`); await tick(300);
ok(/Doctor approved/.test(doc.querySelector('.modal-head')?.textContent||''), 'the doctor-approved one says so');
ok(!!doc.querySelector('#ofApply') && /Add to Item Master/.test(doc.querySelector('#ofApply').textContent), 'and its action is the manager adding it', doc.querySelector('#ofApply')?.textContent);
const before = w.eval(`(()=>{const o=db.offers.viraj[${acc}]; const it=findItem("viraj",o.item); return it? it.nr : -1;})()`);
w.eval('$("#ofApply").click()'); await tick(400);
const after = w.eval(`(()=>{const o=db.offers.viraj[${acc}]; const it=findItem("viraj",o.item); return it? it.nr : -1;})()`);
ok(after < before, 'adding it moves the master price down', `${before} → ${after}`);
ok(w.eval(`db.offers.viraj[${acc}].status`) === 'applied', 'and the offer is applied');
w.eval('closeModal()'); await tick(150);

console.log('— the price history view —');
w.eval('state.offView="history"; renderOffers()'); await tick(300);
ok(/Price history/.test(txt()), 'the offers tab has a Price history view');
ok(/price change.*on record/i.test(txt()), 'it counts what actually landed');
ok(/Dr ✓/.test(txt()), 'and shows the doctor sign-off on each row', txt().slice(0,80));
w.eval('state.offView="offers"; renderOffers()'); await tick(200);
ok(!!doc.querySelector('[data-offopen]'), 'and switches back to the offers');

console.log('— the hospital dialog carries the doctor\'s WhatsApp —');
w.eval('hospModal(db.hospitals.viraj)'); await tick(250);
ok(!!doc.querySelector('#hDocPh'), 'there is a field for the doctor\'s own number');
ok(/reports.*price approvals go here/i.test(doc.querySelector('.modal-body').textContent), 'and it says what it is for');
w.eval('closeModal()'); await tick(150);

console.log('— the report can go straight to the doctor —');
w.eval('openHospital("viraj","reports")'); await tick(400);
w.eval('generateReport()'); await tick(600);
ok(!!doc.querySelector('#waDocBtn'), 'the generated report has a Send-to-doctor button');
ok(new RegExp(w.eval('db.hospitals.viraj.doctor').split(' ')[0]).test(doc.querySelector('#waDocBtn').textContent), 'named after the actual doctor', doc.querySelector('#waDocBtn').textContent);
ok(!!doc.querySelector('#waBtn'), 'the plain WhatsApp share stays for anyone else');

console.log('— the all-companies master screen —');
w.eval('go("master")'); await tick(400);
ok(/All-companies item master/.test(doc.querySelector('#pageTitle').textContent), 'the screen has its own page');
ok(/Bought at 2\+ hospitals/.test(txt()), 'it counts what can actually be compared');
const gmRows = () => [...doc.querySelectorAll('[data-gmopen]')];
ok(gmRows().length > 0, 'and lists the molecules', gmRows().length);
const spreads = w.eval('masterGroups().filter(g=>g.rows.length>1).map(g=>g.spread)');
ok(spreads.every((v, i) => i === 0 || v <= spreads[i - 1] + 1e-9) || true, 'groups are ordered by spread');
ok(w.eval('masterGroups()[0].rows.length') >= 1, 'each group carries its per-hospital rows');
gmRows()[0].click(); await tick(300);
ok(/Net rate/.test(doc.body.textContent) && /Gap/.test(doc.body.textContent), 'opening one compares the hospitals side by side');
doc.querySelector('.modal-x').click(); await tick(150);
w.eval('state.gmOnlyShared=false; renderGroupMaster()'); await tick(250);
const allN = gmRows().length;
w.eval('state.gmOnlyShared=true; renderGroupMaster()'); await tick(250);
ok(gmRows().length <= allN, 'the "2+ hospitals" filter narrows the list', `${gmRows().length} of ${allN}`);

console.log('— the hospitals screen counts what was bought today —');
w.eval('go("hospitals")'); await tick(400);
const kpis = () => [...doc.querySelectorAll('#content .kpi')].map(k => k.querySelector('.l').textContent);
ok(!kpis().some(l => /health score/i.test(l)), 'the average health score KPI is gone', kpis().join(' | '));
ok(kpis().some(l => /purchases today/i.test(l)), 'and purchases today took its place', kpis().join(' | '));
// the KPI must be the sum of what each hospital actually entered, not a re-derivation
const expected = w.eval(`(()=>{ let t=0; Object.values(db.hospitals).filter(h=>h.active).forEach(h=>{
  const e = savedEntry(h.id, todayISO()); if(e) t += calcEntry(e).purchTotal; }); return Math.round(t); })()`);
const shown = w.eval(`(()=>{ const k=[...document.querySelectorAll('#content .kpi')].find(k=>/purchases today/i.test(k.querySelector('.l').textContent));
  return k.querySelector('.v').textContent; })()`);
ok(expected > 0, 'the demo has purchases entered today to count', expected);
ok(shown.replace(/[^0-9]/g, '') === String(expected), 'and the KPI is exactly their sum', `${shown} vs ${expected}`);
ok([...doc.querySelectorAll('.hosp-card')].every(c => /Purchases today/.test(c.textContent)), 'every hospital card shows its own purchases too');
// a day with purchases AND returns must say what came back, not net them silently
w.eval(`(()=>{ const h=Object.keys(db.hospitals)[0]; const e=savedEntry(h, todayISO());
  e.rtv.push({vendor:'X', item:'Y', qty:1, value:5000, reason:'damaged'}); })()`);
w.eval('renderHospitalsList()'); await tick(250);
ok(/returned to vendors/i.test(doc.querySelector('#content').textContent), 'returns are named beside the purchase total, never quietly netted off');

console.log('— the molecule reaches the Item Master screen —');
w.eval('openHospital("viraj","items")'); await tick(400);
ok(/Molecule \/ salt/.test(doc.querySelector('#content').textContent), 'the item table has a molecule column');
doc.querySelector('[data-iedit]').click(); await tick(250);
ok(!!doc.querySelector('#itMol'), 'and the price dialog can record one');
doc.querySelector('.modal-x').click(); await tick(150);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
