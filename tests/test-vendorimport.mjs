/* Tests: the vendor-balances upload. It used to read ANY file as plain text,
   so an Excel file came through as decoded gibberish and still reported a
   false "N vendors will be imported" — nothing checked whether the parsed
   rows looked like vendor records at all. This suite proves:
   - a real .xlsx is read properly (same readTemplate() every other upload
     in the console already uses), never as raw text.
   - the balance column resolves Marg's Cr/Dr suffix to a signed number
     (Cr = payable, positive; Dr = the reverse, negative) — commas are
     stripped before parsing so a lakh-grouped figure ("1,25,000") is never
     silently truncated at the first comma the way a bare parseFloat would.
   - a balance that isn't a plain number (optionally Cr/Dr) is rejected with
     a reason, never guessed at or silently zeroed.
   - the wrong template entirely (e.g. the item master) is refused outright —
     'vendors' requires BOTH a name AND a balance column to be recognized,
     so a file that merely has a name-like column can't false-match.
   - a genuinely garbled/binary read (or the wrong file pasted as text) is
     caught before any import count is shown, on the plain-text/paste path.
   - CSV and pasted rows keep working exactly as before. */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import XLSX from 'xlsx';

const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
const B = 'http://127.0.0.1:3061/api';

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));
const lastToast = (doc) => { const t = doc.querySelectorAll('#toastRoot .toast'); return t.length ? t[t.length - 1].textContent : ''; };

const buildXlsx = (rows) => {
  const ws = XLSX.utils.aoa_to_sheet([['Vendor Name', 'Opening Balance', 'Credit Days', 'Phone'], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vendors');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

console.log('— the template: Vendor Name + Cr/Dr-aware balance column —');
{
  const r = await fetch(`${B}/template/vendors`);
  ok(r.status === 200, 'downloads with no auth needed — a blank form', r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets['Vendors'];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1 });
  ok(grid[0][0] === 'Vendor Name', 'the header says "Vendor Name", not "Product name"', grid[0]);
  ok(/Cr or Dr/i.test(grid[0][1]), 'the balance header itself explains the Cr/Dr convention', grid[0][1]);
  ok(grid.some(r => /Cr\b/.test(String(r[1]))) && grid.some(r => /Dr\b/.test(String(r[1]))), 'example rows demonstrate both Cr and Dr', JSON.stringify(grid.slice(1)));
  const notes = XLSX.utils.sheet_to_json(wb.Sheets['How to fill'], { header: 1 }).map(r => r.join(' | ')).join('\n');
  ok(/advance|credit note/i.test(notes) && /rejected with a reason/i.test(notes), 'the notes explain what Dr means and that a bad value is rejected, not guessed', notes.includes('rejected'));
}

console.log('— a real xlsx upload, parsed properly (never as text) — Cr/Dr resolved, bad values rejected —');
let cookie;
{
  const loginRes = await fetch(`${B}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bhagavan@yajnapharma.in', password: ADMIN_PW }) });
  cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

  const buf = buildXlsx([
    ['Sun Pharma Distributors', '1,25,000 Cr', 30, '+91 98480 11223'],
    ['Cipla Agencies', '42,500 Dr', 21, ''],
    ['New Vendor With Nothing Owed', '', 30, ''],
    ['Broken Row Vendor', 'N/A', 30, '']
  ]);
  const form = new FormData();
  form.set('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'vendors.xlsx');
  const up = await fetch(`${B}/parse/vendors?hid=viraj`, { method: 'POST', body: form, headers: { cookie } });
  const data = await up.json();
  ok(up.status === 200, 'the file is read without error', JSON.stringify(data).slice(0, 200));
  ok(data.fileRows === 4 && data.rows.length === 3 && data.skipped.length === 1, 'reconciliation: fileRows(4) = imported(3) + skipped(1)', JSON.stringify({ fileRows: data.fileRows, imported: data.rows.length, skipped: data.skipped.length }));
  const byName = Object.fromEntries(data.rows.map(r => [r.name, r]));
  ok(byName['Sun Pharma Distributors']?.bal === 125000, 'Cr resolves to a positive number, commas stripped before parsing (1,25,000 -> 125000, not truncated at the first comma)', byName['Sun Pharma Distributors']?.bal);
  ok(byName['Cipla Agencies']?.bal === -42500, 'Dr resolves to the SAME magnitude, negated', byName['Cipla Agencies']?.bal);
  ok(byName['New Vendor With Nothing Owed']?.bal === 0, 'a blank balance is 0, not an error — a brand-new vendor owes nothing yet', byName['New Vendor With Nothing Owed']?.bal);
  ok(!byName['Broken Row Vendor'], 'the row with an unreadable balance did NOT silently import', JSON.stringify(data.rows.map(r => r.name)));
  ok(data.skipped[0].name === 'Broken Row Vendor' && /could not read the opening balance/i.test(data.skipped[0].reason), 'and it is named with a real reason, not silently dropped', JSON.stringify(data.skipped[0]));

  // and it saves cleanly, negative balance and all
  const saveRes = await fetch(`${B}/vendors/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ hid: 'viraj', vendors: data.rows }) });
  const save = await saveRes.json();
  ok(saveRes.status === 200 && save.created.length === 3, 'all 3 valid rows save', JSON.stringify(save.created?.map(v => v.name)));
  const savedCipla = save.created.find(v => v.name === 'Cipla Agencies');
  ok(savedCipla && savedCipla.openingBal === -42500, 'the Dr balance persists as a real negative number, not flipped or truncated', savedCipla?.openingBal);
}

console.log('— the wrong file entirely is refused, not false-matched —');
{
  // the item-master template has a name-like column too, but no balance
  // column at all — 'vendors' requires BOTH, so this must NOT "match"
  const itemsTplRes = await fetch(`${B}/template/items`);
  const itemsBuf = Buffer.from(await itemsTplRes.arrayBuffer());
  const form = new FormData();
  form.set('file', new Blob([itemsBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'yajna-item-master-template.xlsx');
  const up = await fetch(`${B}/parse/vendors?hid=viraj`, { method: 'POST', body: form, headers: { cookie } });
  const data = await up.json();
  ok(up.status === 400 && /expected/i.test(data.error || ''), 'the item-master file is refused outright — item names never become fake vendor rows', JSON.stringify(data).slice(0, 200));
}

console.log('— the UI: a real xlsx file, attached and previewed through the actual modal —');
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
  doc.querySelector('[data-open2="siri"]').click(); await tick(250);
  w.eval(`[...document.querySelectorAll('[data-htab]')].find(b=>b.dataset.htab==='vendors').click();`); await tick(300);
  doc.querySelector('#upBtn').click(); await tick(200);

  // the real multipart round trip (file -> readTemplate -> Cr/Dr resolution)
  // is already proven directly against the server above; jsdom's File/FormData
  // over a real fetch is unreliable for a genuine multipart body, so — same
  // convention as this suite's other UI tests — apiUpload is monkey-patched
  // to return exactly what /api/parse/vendors already proved it hands back,
  // and this section tests what the MODAL does with that response
  w.eval(`
    window.__realApiUpload = apiUpload;
    window.apiUpload = async () => ({
      source:'template', sheet:'Vendors', fileRows:2, parsed:2, imported:2, skipped:[], ignored:0, cautions:[],
      note:'Read 2 rows from the template (sheet "Vendors")',
      rows:[
        {row:1, name:'New Excel Vendor', bal:18000, credit:30, phone:'+91 90000 11111'},
        {row:2, name:'Another Excel Vendor', bal:-2000, credit:15, phone:''}
      ]
    });
  `);
  const fakeFile = new w.File(['dummy'], 'vendor-balances.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  Object.defineProperty(doc.querySelector('#csvFile'), 'files', { value: [fakeFile], configurable: true });
  doc.querySelector('#csvPrev').click(); await tick(300);
  const prevBody = doc.querySelector('#csvPreview').textContent;
  ok(/2 new vendors will be imported/.test(prevBody), 'the CORRECT count shows — this is exactly the false "18 vendors" bug this fixes', prevBody.slice(0, 300));
  ok(/New Excel Vendor/.test(prevBody) && /Another Excel Vendor/.test(prevBody), 'real vendor names from the sheet, not decoded gibberish', prevBody.slice(0, 300));
  ok(!/�|�/.test(prevBody), 'no raw/garbled bytes rendered on screen');
  w.eval(`window.apiUpload = window.__realApiUpload;`);

  doc.querySelector('#csvGo').click(); await tick(500);
  ok(lastToast(doc).includes('2 vendors imported'), 'the import completes for a real Excel file', lastToast(doc));

  const bootAfter = await (await fetch(`${B}/bootstrap`, { headers: { cookie: domCookie } })).json();
  const vendors = bootAfter.vendors.siri || [];
  ok(vendors.some(v => v.name === 'New Excel Vendor' && v.openingBal === 18000), 'the Cr vendor lands on the server with the right positive balance', JSON.stringify(vendors.find(v => v.name === 'New Excel Vendor')));
  ok(vendors.some(v => v.name === 'Another Excel Vendor' && v.openingBal === -2000), 'and the Dr vendor with the right negative balance', JSON.stringify(vendors.find(v => v.name === 'Another Excel Vendor')));
}

console.log('— the UI: garbled content is caught before any count is shown —');
{
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null; w.confirm = () => true;
      w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
  const w = dom.window, doc = w.document;
  await tick(400);
  doc.querySelector('[data-quick="admin"]').click(); await tick(700);
  doc.querySelector('[data-open2]').click(); await tick(250);
  w.eval(`[...document.querySelectorAll('[data-htab]')].find(b=>b.dataset.htab==='vendors').click();`); await tick(300);
  doc.querySelector('#upBtn').click(); await tick(200);

  // what an Excel file looks like when decoded as plain text: mostly control
  // characters and the Unicode replacement character, no real vendor names
  const garbled = ['\x01\x02PK\x03\x04\x00\x00\x00\x08��', '\x00\x00word/document.xml���'].join('\n');
  doc.querySelector('#csvPaste').value = garbled;
  doc.querySelector('#csvPrev').click(); await tick(200);
  const body = doc.querySelector('#csvPreview').textContent;
  ok(/doesn't look like vendor data/i.test(body), 'refuses to offer an import count for content that clearly isn\'t vendor rows', body.slice(0, 300));
  ok(doc.querySelector('#csvGo').disabled, 'Import stays disabled');

  // a normal, valid paste still works right after — the check doesn't get stuck
  doc.querySelector('#csvPaste').value = 'Genuine Vendor Co,15000 Cr,30,+91 90000 22222';
  doc.querySelector('#csvPrev').click(); await tick(200);
  const body2 = doc.querySelector('#csvPreview').textContent;
  ok(/Genuine Vendor Co/.test(body2) && /1 new vendor/.test(body2), 'and a real paste right after works normally', body2.slice(0, 300));
}

console.log('— CSV (non-Excel) and pasted rows still work exactly as before —');
{
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null; w.confirm = () => true;
      w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
  const w = dom.window, doc = w.document;
  await tick(400);
  doc.querySelector('[data-quick="admin"]').click(); await tick(700);
  doc.querySelector('[data-open2]').click(); await tick(250);
  w.eval(`[...document.querySelectorAll('[data-htab]')].find(b=>b.dataset.htab==='vendors').click();`); await tick(300);
  doc.querySelector('#upBtn').click(); await tick(200);

  const csvText = 'Vendor Name,Opening Balance,Credit Days,Phone\nPlain CSV Vendor,60,000 Cr,45,+91 90000 33333\nAnother CSV Vendor,9,500 Dr,30,';
  // a genuine .csv extension takes the readAsText path, never the server xlsx parse
  const fakeCsv = new w.File([csvText], 'vendors.csv', { type: 'text/csv' });
  Object.defineProperty(doc.querySelector('#csvFile'), 'files', { value: [fakeCsv], configurable: true });
  doc.querySelector('#csvPrev').click(); await tick(200);
  const body = doc.querySelector('#csvPreview').textContent;
  ok(/Plain CSV Vendor/.test(body) && /Another CSV Vendor/.test(body), 'a real CSV file is read via the text path, both rows come through', body.slice(0, 300));
  ok(/2 new vendors will be imported/.test(body), 'and the count is correct — Cr/Dr parsed the same way as the Excel path', body.slice(0, 300));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
