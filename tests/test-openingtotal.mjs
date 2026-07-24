/* Tests: the opening-stock template's TOTAL row + live formulas, and the
   upload's second-load warning + persisted load record. Opening stock is
   loaded ONCE and everything downstream is built on it, so:
   - the template's calculated columns and TOTAL row are live formulas (not
     static illustrations), checked against the Marg report before anything
     uploads — and MUST NOT pollute the reconciliation: a formula cell that
     resolves to "" reads back as a non-blank row once a real spreadsheet
     recalculates it, so only the 4 example rows and the TOTAL row itself may
     ever carry a formula — nothing in between.
   - the TOTAL row is never loaded as a product and never counted as one.
   - a second opening-stock load on a pharmacy that already has one warns,
     naming the first load's date and totals, and requires explicit
     confirmation to replace it.
   - the load itself (count date, item count, value at cost, value at MRP,
     who loaded it) is written down and stays visible afterwards — on the
     Inventory tab, not just inside the modal that closed. */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import XLSX from 'xlsx';

const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const USER_PW = process.env.SEED_USER_PW || 'Test@User#1';
const B = 'http://127.0.0.1:3061/api';

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));
const todayISO = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return d.toISOString().slice(0, 10); };
const T = todayISO();

function jar() {
  let cookie = '';
  return { async req(method, path, body) {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }};
}

console.log('— the template: TOTAL row + live formulas, structurally correct —');
let templateBuf;
{
  const r = await fetch(B + '/template/opening');
  ok(r.status === 200, 'the template downloads with no auth needed — it is a blank form', r.status);
  templateBuf = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(templateBuf, { type: 'buffer', cellFormula: true });
  const ws = wb.Sheets['Opening stock'];
  ok(ws['!ref'] === 'A1:M3002', 'the sheet reports its full range through the TOTAL row — M for the appended Batch/Expiry columns, 3002 for headroom over multi-batch files', ws['!ref']);

  ok(ws['A3002'] && ws['A3002'].v === 'TOTAL' && !ws['A3002'].f, 'the TOTAL row\'s name cell is a plain value — always readable even before any spreadsheet recalculates it', JSON.stringify(ws['A3002']));

  // the xlsx package's own reader drops a formula-only cell entirely (no
  // cached <v>, since this library never evaluates formulas) — so formula
  // CONTENT is checked against the raw sheet XML directly, not the parsed
  // cell objects, which is how a real spreadsheet actually sees the file
  const tmpFile = path.join(os.tmpdir(), `opening-check-${Date.now()}.xlsx`);
  fs.writeFileSync(tmpFile, templateBuf);
  const sheetXml = execFileSync('unzip', ['-p', tmpFile, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8' });
  fs.unlinkSync(tmpFile);
  ok(/<c r="E2">/.test(sheetXml) && sheetXml.includes('C2+IF'), 'row 2\'s Total-strips cell is a live formula, not a static number', sheetXml.match(/<c r="E2"[^]*?<\/c>/)?.[0]);
  ok(sheetXml.includes('E2*F2'), 'row 2\'s Value-at-cost cell derives from Total-strips × net rate');
  ok(sheetXml.includes('E5*G5'), 'row 5\'s (the vial) Value-at-MRP cell is a formula too');
  ok(sheetXml.includes('SUM(J2:J3000)'), 'the TOTAL row sums Value-at-cost over a generous row range');
  ok(sheetXml.includes('SUM(K2:K3000)'), 'and Value-at-MRP the same way');
  ok(sheetXml.includes('COUNTA(A2:A3000)'), 'and a batch-line count, from the same kind of range — batches, not products, since one product can now span several rows');

  // the safety property: NOTHING is touched between row 5 and row 1002 — a
  // fresh, never-recalculated read must show only the header + 4 examples +
  // TOTAL, never thousands of phantom blank rows in between
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  ok(grid.length === 6, 'a fresh read shows exactly header + 4 example rows + TOTAL — nothing in the 995-row gap leaks through', grid.length);

  const notes = wb.Sheets['How to fill'];
  const notesGrid = XLSX.utils.sheet_to_json(notes, { header: 1, blankrows: false }).map(r => r.join(' | '));
  const notesText = notesGrid.join('\n');
  ok(/drag the fill handle/i.test(notesText), 'the notes tell the person how to extend the live formulas to their own rows', notesText.includes('drag'));
  ok(/never loads it as a product/i.test(notesText), 'the notes explain the TOTAL row is built-in and safe to leave in place');
  ok(/excluding GST/i.test(notesText) && /not a data problem/i.test(notesText), 'the notes carry the GST caveat so the next person loading a pharmacy isn\'t surprised by it', notesText.includes('GST'));
}

console.log('— uploading the fresh, UNMODIFIED template: exactly 4 real rows, TOTAL correctly ignored —');
{
  const loginRes = await fetch(`${B}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bhagavan@yajnapharma.in', password: ADMIN_PW }) });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const form = new FormData();
  form.set('file', new Blob([templateBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'yajna-opening-stock-template.xlsx');
  const up = await fetch(`${B}/parse/stock?hid=viraj`, { method: 'POST', body: form, headers: { cookie } });
  const data = await up.json();
  ok(up.status === 200, 'the file is read without error', JSON.stringify(data).slice(0, 200));
  ok(data.fileRows === 5 && data.items.length === 4 && data.skipped.length === 1, 'reconciliation: fileRows(5) = imported(4) + skipped(1) — the TOTAL row is the +1', JSON.stringify({ fileRows: data.fileRows, imported: data.items.length, skipped: data.skipped.length }));
  ok(data.ignored === 1, 'and it is counted as an IGNORED row (noise, not a data problem), not a real rejection', data.ignored);
  ok(data.skipped[0].name === 'TOTAL' && /total row/i.test(data.skipped[0].reason), 'the skip reason names it for what it is', JSON.stringify(data.skipped[0]));
  // the TOTAL row's reported address must be its REAL row in the sheet
  // (3002, past ~2,500 blank rows) — not a count of non-blank rows seen so
  // far (which would read 5). Opening a real file at "row 5" to find TOTAL
  // sitting at row 3002 is exactly the bug this pins.
  ok(data.skipped[0].row === 3002, 'TOTAL is reported at its real sheet row, not the position among non-blank rows processed', data.skipped[0].row);
  ok(data.items.every(i => i.row >= 2 && i.row <= 5), 'the 4 real rows keep their own true row numbers too (2–5)', JSON.stringify(data.items.map(i => i.row)));
  const byName = Object.fromEntries(data.items.map(i => [i.name, i]));
  ok(byName['Tab. Rifaximin 550']?.qty === 120, 'plain strips row reads correctly', byName['Tab. Rifaximin 550']?.qty);
  ok(byName['Tab. Sample Combo 10']?.qty === 10.3, 'full strips + loose tablets sums to a part strip, 10.3', byName['Tab. Sample Combo 10']?.qty);
  ok(byName['Tab. Metformin 500']?.qty === 300, 'loose tablets alone divides by the pack (4500 / 15s)', byName['Tab. Metformin 500']?.qty);
  ok(byName['Inj. Pantoprazole 40']?.qty === 45, 'a vial with no strip size just carries its count as-is', byName['Inj. Pantoprazole 40']?.qty);

  // and it saves cleanly too — not just parses
  const saveRes = await fetch(`${B}/items/opening`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ hid: 'viraj', stockDate: T, rows: data.items, fileName: 'yajna-opening-stock-template.xlsx', source: 'template' }) });
  const save = await saveRes.json();
  ok(saveRes.status === 200 && save.created.length === 4 && save.skipped.length === 0, 'all 4 real rows save as new items — the TOTAL row was never in this list to begin with', JSON.stringify({ created: save.created?.length, skipped: save.skipped }));
}

console.log('— opening_loads: persisted, listed newest-first, role-gated —');
{
  const adm = jar();
  await adm.req('POST', '/login', { email: 'bhagavan@yajnapharma.in', password: ADMIN_PW });
  const first = await adm.req('POST', '/opening-loads', { hid: 'viraj', stockDate: T, itemsCount: 4, valueNr: 48890.275, valueMrp: 68639.7, fileName: 'yajna-opening-stock-template.xlsx', source: 'template' });
  ok(first.status === 200 && first.data.load.itemsCount === 4 && first.data.load.loadedBy === 'Bhagavan', 'the first load record is written, naming who loaded it', JSON.stringify(first.data.load));

  const bad = await adm.req('POST', '/opening-loads', { hid: 'viraj', stockDate: 'not-a-date', itemsCount: 1, valueNr: 1, valueMrp: 1 });
  ok(bad.status === 400, 'a bad stock date is refused, not silently accepted', JSON.stringify(bad.data));

  const usr = jar();
  await usr.req('POST', '/login', { email: 'staff.mithra@yajnapharma.in', password: USER_PW });
  const blocked = await usr.req('POST', '/opening-loads', { hid: 'mithra', stockDate: T, itemsCount: 1, valueNr: 1, valueMrp: 1 });
  ok(blocked.status === 403, 'a data-entry user cannot write a load record — recording one is an admin action', JSON.stringify(blocked.data));

  const second = await adm.req('POST', '/opening-loads', { hid: 'viraj', stockDate: T, itemsCount: 5, valueNr: 50000, valueMrp: 70000, fileName: 'corrected.xlsx', source: 'template' });
  ok(second.status === 200, 'a second load (a correction) is allowed to record too — the app never blocks it, only warns in the UI', second.status);

  const list = await adm.req('GET', '/opening-loads?hid=viraj');
  ok(list.status === 200 && list.data.loads.length === 2, 'both loads for viraj are listed', list.data.loads?.length);
  ok(list.data.loads[0].itemsCount === 5 && list.data.loads[0].fileName === 'corrected.xlsx', 'newest load first', JSON.stringify(list.data.loads.map(l => l.fileName)));
  ok(list.data.loads[1].itemsCount === 4, 'and the original load is still there, in order', list.data.loads[1].itemsCount);

  // a hospital with no load at all reports an empty history, not an error
  const none = await adm.req('GET', '/opening-loads?hid=siri');
  ok(none.status === 200 && none.data.loads.length === 0, 'a hospital that was never loaded shows no history — not a crash', JSON.stringify(none.data));
}

console.log('— the UI: the second-load warning, the confirm gate, and the persisted record staying visible —');
{
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  let domCookie = '';
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null; w.confirm = () => true;
      w.fetch = async (url, opts = {}) => {
        const r = await fetch(new URL(url, 'http://127.0.0.1:3061'), { ...opts, headers: { ...(opts.headers || {}), ...(domCookie ? { cookie: domCookie } : {}) } });
        const sc = r.headers.get('set-cookie'); if (sc) domCookie = sc.split(';')[0];
        return r;
      }; } });
  const w = dom.window, doc = w.document;
  await tick(400);
  doc.querySelector('#loginEmail').value = 'bhagavan@yajnapharma.in';
  doc.querySelector('#loginPw').value = ADMIN_PW;
  doc.querySelector('#loginBtn').click(); await tick(900);
  doc.querySelector('[data-open2="viraj"]').click(); await tick(250);
  // freeform (paste) sources default to counting tablets — force strips so a
  // pasted strip count isn't divided by the pack a second time
  w.eval(`setFileUnits('viraj','paste','strips');`);
  w.eval(`state.hospTab='inventory'; renderApp();`); await tick(500);

  let body = doc.querySelector('#content').textContent;
  ok(/Opening stock counted as on/.test(body) && /5 items/.test(body), 'the Inventory tab shows the LATEST load\'s own figures, persisted from the raw-HTTP section above', body.slice(0, 300));
  ok(/50,000|50000|₹50,000/.test(body.replace(/\s/g, '')) || /50,000/.test(body), 'including its value at cost', body.slice(0, 400));

  doc.querySelector('#invOpening').click(); await tick(300);
  let modalBody = doc.querySelector('.modal').textContent;
  ok(/already loaded here/.test(modalBody) && /5 items/.test(modalBody), 'opening the modal on an already-loaded pharmacy warns, naming the prior load, before any row is read', modalBody.slice(0, 300));

  doc.querySelector('#osPaste').value = 'Tab. Correction Item,50,20,30,10s';
  doc.querySelector('#osRead').click(); await tick(300);
  let prevBody = doc.querySelector('#osPrev').textContent;
  ok(/excluding GST/i.test(prevBody), 'the GST/MRP-trust caveat appears right in the live preview, under the cost figure', prevBody.slice(0, 400));
  ok(/1,000|1000/.test(prevBody) && /1,500|1500/.test(prevBody), 'this file\'s own totals show — 50 strips × ₹20 = 1000 at cost, × ₹30 = 1500 at MRP', prevBody.slice(0, 300));

  doc.querySelector('#osGo').click(); await tick(1200);
  ok(!!doc.querySelector('#osDone'), 'saving completes (the confirm-gate auto-accepts, matching this suite\'s stubbed window.confirm)');
  let doneBody = doc.querySelector('.modal').textContent;
  ok(/Recorded/.test(doneBody) && /1 item/.test(doneBody), 'the Done screen shows the persisted record — the same figures just uploaded', doneBody.slice(0, 400));

  const listAfter = await (await fetch(`${B}/opening-loads?hid=viraj`, { headers: { cookie: domCookie } })).json();
  ok(listAfter.loads.length === 3 && listAfter.loads[0].itemsCount === 1 && listAfter.loads[0].valueNr === 1000, 'a third load record now exists on the server, written by the real click through the real button', JSON.stringify(listAfter.loads[0]));

  doc.querySelector('#osDone').click(); await tick(200);
  w.eval(`renderInventory();`); await tick(300);
  body = doc.querySelector('#content').textContent;
  ok(/1 item/.test(body), 'back on the Inventory tab, the banner now reflects the correction — not the stale earlier figures', body.slice(0, 300));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
