/* Tests: chunkedSaveUI — batched saves with live progress and an inline,
   editable retry table for whatever doesn't land on the first pass. Every
   original row is accounted for in exactly one bucket: imported + fixed +
   removed + remaining === fileRows, always. Section 1 drives the component
   directly with a mocked saveBatch (no server needed — pure UI mechanics).
   Section 2 is one real end-to-end pass through itemImportModal against the
   live test server, proving the wiring actually lands rows in inventory. */
import { JSDOM } from 'jsdom';
import fs from 'fs';

const ADMIN_PW = process.env.SEED_ADMIN_PW || 'Test@Admin#1';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

console.log('— chunkedSaveUI: batching, tally, editable retry, the invariant (mocked saveBatch, no server) —');
{
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null;
      w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }); } });
  const w = dom.window, doc = w.document;
  await tick(400);
  doc.querySelector('[data-quick="admin"]').click(); await tick(700);

  // a container the component renders into, exactly as a modal would supply
  w.eval(`document.body.insertAdjacentHTML('beforeend', '<div id="testChunk"></div>')`);

  console.log('  — a clean batch: everything imports, no retry table —');
  w.eval(`
    window.__u1 = chunkedSaveUI(document.getElementById('testChunk'), {
      batchSize: 2,
      fields: [{key:'name',label:'Name'}],
      validate: r => r.name? null : 'no product name',
      saveBatch: async (rows) => ({ created: rows.map(r=>({id:'x'+r.name})), filled: [], skipped: [] }),
      countImported: r => r.created.length,
      applyResult: () => {}
    });
    window.__batchCalls = [];
    const origSave = window.__u1;
  `);
  // wrap saveBatch to record call sizes — rebuild with a spy
  w.eval(`
    window.__calls = [];
    window.__u1b = chunkedSaveUI(document.getElementById('testChunk'), {
      batchSize: 2,
      fields: [{key:'name',label:'Name'}],
      validate: r => r.name? null : 'no product name',
      saveBatch: async (rows) => { window.__calls.push(rows.length); return { created: rows.map(r=>({id:'x'+r.name})), filled: [], skipped: [] }; },
      countImported: r => r.created.length,
      applyResult: () => {}
    });
  `);
  w.eval(`window.__done1 = window.__u1b.run({fileRows:5, rows:[{name:'A'},{name:'B'},{name:'C'},{name:'D'},{name:'E'}], preSkipped:[]})`);
  await tick(300);
  const calls = w.eval(`window.__calls`);
  ok(JSON.stringify(calls) === JSON.stringify([2, 2, 1]), 'five rows at batchSize 2 -> three batches of 2, 2, 1', JSON.stringify(calls));
  const tally1 = doc.querySelector('#testChunk').textContent;
  ok(/5 rows in file/.test(tally1) && /5 imported/.test(tally1) && /0 remaining/.test(tally1), 'the tally reads 5 in file, 5 imported, 0 remaining', tally1);
  ok(!doc.querySelector('#testChunk table'), 'nothing failed, so no retry table at all');

  console.log('  — a dirty batch: failures land in an editable table, pre-filled —');
  w.eval(`
    window.__u2 = chunkedSaveUI(document.getElementById('testChunk'), {
      batchSize: 10,
      fields: [{key:'name',label:'Product name'}, {key:'nr',label:'Net rate'}, {key:'mrp',label:'MRP'}],
      validate: r => { if(!r.name) return 'no product name'; const nr=Number(r.nr)||0, mrp=Number(r.mrp)||0; if(!(nr>0)||!(mrp>0)) return 'net rate and MRP must be positive'; if(nr>mrp) return 'net rate cannot exceed MRP'; return null; },
      saveBatch: async (rows) => {
        const created = [], skipped = [];
        rows.forEach((r,ix)=>{
          const nr=Number(r.nr)||0, mrp=Number(r.mrp)||0;
          if(!r.name) skipped.push({row:r.row??ix+1, name:'', reason:'no product name'});
          else if(!(nr>0)||!(mrp>0)||nr>mrp) skipped.push({...r, row:r.row??ix+1, reason:'net rate and MRP must be positive, and net rate cannot exceed MRP'});
          else created.push({id:'y'+r.name});
        });
        return { created, filled: [], skipped };
      },
      countImported: r => r.created.length,
      applyResult: () => {}
    });
    window.__done2 = window.__u2.run({fileRows:3, rows:[
      {row:1, name:'Good Item', nr:10, mrp:20},
      {row:2, name:'Bad Price Item', nr:100, mrp:50},
      {row:3, name:'', nr:5, mrp:10}
    ], preSkipped:[]});
  `);
  await tick(300);
  let body = doc.querySelector('#testChunk').textContent;
  ok(/3 rows in file/.test(body) && /1 imported/.test(body) && /2 remaining/.test(body), 'one imports, two remain, all three accounted for', body);
  const inputs = [...doc.querySelectorAll('#testChunk [data-fix-field="name"]')].map(i => i.value);
  ok(inputs.length === 2 && inputs.includes('Bad Price Item') && inputs.includes(''), 'the two failing rows are pre-filled, including the blank name', JSON.stringify(inputs));
  ok(!!doc.querySelector('#fixRetryBtn') && /Retry 2 rows/.test(doc.querySelector('#fixRetryBtn').textContent), 'a Retry button names the count');

  console.log('  — live validation clears the reason the moment a fix looks valid —');
  const badRow = [...doc.querySelectorAll('#testChunk tr[data-fix-row]')].find(tr => tr.querySelector('[data-fix-field="name"]').value === 'Bad Price Item');
  const mrpInput = badRow.querySelector('[data-fix-field="mrp"]');
  mrpInput.value = '150'; mrpInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  ok(/looks valid/i.test(badRow.querySelector('.fix-reason').textContent), 'the reason clears live once nr(100) <= mrp(150)', badRow.querySelector('.fix-reason').textContent);
  ok(badRow.querySelector('.fix-reason').style.color === 'var(--green)' || /green/.test(badRow.querySelector('.fix-reason').getAttribute('style')||''), 'and turns green', badRow.querySelector('.fix-reason').getAttribute('style'));

  console.log('  — remove: a row the user deletes is never resent, and counts as removed —');
  const blankRow = [...doc.querySelectorAll('#testChunk tr[data-fix-row]')].find(tr => tr.querySelector('[data-fix-field="name"]').value === '');
  blankRow.querySelector('[data-fix-remove]').click();
  body = doc.querySelector('#testChunk').textContent;
  ok(/1 removed/.test(body) && /1 remaining/.test(body), 'removing the blank row: 1 removed, 1 still remaining', body);

  console.log('  — retry: the corrected row is resent and now imports, folding into "fixed" —');
  const nameInputStillThere = doc.querySelector('#testChunk [data-fix-field="name"]');
  ok(nameInputStillThere.value === 'Bad Price Item', 'only the corrected row remains for retry', nameInputStillThere.value);
  w.eval(`document.getElementById('fixRetryBtn').click()`);
  await tick(200);
  body = doc.querySelector('#testChunk').textContent;
  ok(/3 rows in file/.test(body), 'fileRows never changes', body);
  ok(/1 imported/.test(body) && /1 fixed and imported/.test(body) && /1 removed/.test(body) && /0 remaining/.test(body),
    'final tally: 1 imported + 1 fixed + 1 removed + 0 remaining = 3, exactly the file — nothing vanished', body);
  ok(!doc.querySelector('#testChunk table'), 'and the retry table is gone now that nothing is left to fix');

  console.log('  — a row that never even passed reading the file (preSkipped) is fixable too —');
  w.eval(`document.getElementById('testChunk').innerHTML = ''`);
  w.eval(`
    window.__u3 = chunkedSaveUI(document.getElementById('testChunk'), {
      batchSize: 10,
      fields: [{key:'name',label:'Name'}, {key:'pack',label:'Pack'}],
      validate: r => r.pack? null : 'pack size needed to convert loose tablets',
      saveBatch: async (rows) => ({ created: rows.map(r=>({id:'z'+r.name})), filled: [], skipped: [] }),
      countImported: r => r.created.length,
      applyResult: () => {}
    });
    window.__done3 = window.__u3.run({fileRows:2, rows:[{name:'Real Row', pack:'10s'}],
      preSkipped:[{row:1, name:'Vial Row', reason:'pack size needed to convert loose tablets — a vial has no strip size'}]});
  `);
  await tick(200);
  body = doc.querySelector('#testChunk').textContent;
  ok(/2 rows in file/.test(body) && /1 imported/.test(body) && /1 remaining/.test(body), 'the pre-skipped row sits in the SAME failing table as any save-stage failure', body);
  ok(doc.querySelector('#testChunk [data-fix-field="name"]').value === 'Vial Row', 'pre-filled from what readTemplate captured, ready to fix and resend');

  console.log('  — a TOTAL row in preSkipped is tallied but NEVER shown in the failing/retry table —');
  // real bug reported by a user: a 473-row file's TOTAL row (readTemplate's
  // own 'skipped: total row' reason) landed in the SAME retry table as a
  // genuine bad row — "row 2997, TOTAL, ✕" sitting there forever, since a
  // label can never be "fixed" into a product and was never a real problem
  // to begin with (it was already tallied as `ignored`, not a rejection).
  w.eval(`document.getElementById('testChunk').innerHTML = ''`);
  w.eval(`
    window.__u4 = chunkedSaveUI(document.getElementById('testChunk'), {
      batchSize: 10,
      fields: [{key:'name',label:'Product name'}, {key:'pack',label:'Pack'}, {key:'qty',label:'Opening qty'}, {key:'nr',label:'Net rate'}, {key:'mrp',label:'MRP'}, {key:'batch',label:'Batch'}, {key:'exp',label:'Expiry'}],
      validate: r => r.name? null : 'no product name',
      saveBatch: async (rows) => ({ created: rows.map(r=>({id:'w'+r.name})), filled: [], skipped: [] }),
      countImported: r => r.created.length,
      applyResult: () => {}
    });
    window.__done4 = window.__u4.run({fileRows:474, rows: Array.from({length:473}, (_,i)=>({row:i+2, name:'Item'+i})),
      preSkipped:[{row:2997, name:'TOTAL', reason:'skipped: total row', pack:'', qty:0, nr:0, mrp:0, batch:'', exp:''}]});
  `);
  await tick(300);
  body = doc.querySelector('#testChunk').textContent;
  ok(/474 rows in file/.test(body) && /473 imported/.test(body), 'all 473 real rows import cleanly', body.slice(0, 200));
  ok(/0 remaining/.test(body), 'the TOTAL row is NOT counted as remaining/failing — it can never be "fixed"', body.slice(0, 250));
  ok(/1 total\/subtotal row ignored/.test(body), 'it is named plainly as ignored, not as a failure', body.slice(0, 250));
  ok(!doc.querySelector('#testChunk table'), 'and critically: NO retry table is rendered at all — "row 2997, TOTAL, ✕" never appears on screen');
}

console.log('— end to end: itemImportModal really saves through chunkedSaveUI against the live server —');
{
  let cookie = '';
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3061/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {}; w.print = () => {}; w.open = () => null; w.confirm = () => true;
      w.fetch = async (u, o = {}) => { const res = await fetch(new URL(u, 'http://127.0.0.1:3061'), { method: o.method || 'GET', headers: { ...(o.headers || {}), ...(cookie ? { cookie } : {}) }, body: o.body });
        const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return res; }; } });
  const w = dom.window, doc = w.document;
  await tick(400);
  doc.querySelector('#loginEmail').value = 'bhagavan@yajnapharma.in';
  doc.querySelector('#loginPw').value = ADMIN_PW;
  doc.querySelector('#loginBtn').click(); await tick(900);
  doc.querySelector('[data-open2]').click(); await tick(250);
  w.eval(`itemImportModal(state.hospital)`); await tick(200);
  const setV = (s, v) => { const el = doc.querySelector(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  // one good row, one bad-price row, via the paste box
  setV('#icsvPaste', 'Chunk Test Good,15,25,10s,\nChunk Test Bad,90,50,10s,');
  doc.querySelector('#icsvPrev').click(); await tick(150);
  doc.querySelector('#icsvGo').click(); await tick(400);
  let body = doc.querySelector('#icsvChunked').textContent;
  ok(/1 imported/.test(body) && /1 remaining/.test(body), 'the good row imports, the bad-price row is left to fix', body);
  const mrpInput = doc.querySelector('#icsvChunked [data-fix-field="mrp"]');
  ok(!!mrpInput, 'the failing row is editable right there in the modal');
  mrpInput.value = '150'; mrpInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  doc.querySelector('#fixRetryBtn').click(); await tick(400);
  body = doc.querySelector('#icsvChunked').textContent;
  ok(/1 fixed and imported/.test(body) && /0 remaining/.test(body), 'retried and now imported', body);
  // check whether it ACTUALLY landed in inventory — the whole point of the ask
  const bootRes = await fetch('http://127.0.0.1:3061/api/bootstrap', { headers: { cookie } });
  const boot = await bootRes.json();
  const items = boot.items[w.eval('state.hospital')] || [];
  ok(items.some(i => i.name === 'Chunk Test Good'), 'the first-pass item is really on the Item Master now', items.map(i=>i.name).join(', '));
  const fixedItem = items.find(i => i.name === 'Chunk Test Bad');
  ok(!!fixedItem && fixedItem.mrp === 150, 'and the retried, corrected item landed too, with the FIXED value, not the original', JSON.stringify(fixedItem));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
