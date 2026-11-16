// GrantKeep — Phase 3: import expenses from a CSV file (QuickBooks, Xero, bank).
// The column mapping is saved per source in the csv_mappings table, so next time
// the same kind of file maps itself. Everything runs on the phone; the file is
// never uploaded anywhere — only the expense rows you choose get saved.

const FIELDS = [
  ['date', 'Date', true],
  ['amount', 'Amount', false],
  ['out', 'Money out (debit / spent)', false],
  ['in', 'Money in (credit / deposit)', false],
  ['vendor', 'Vendor / paid to', false],
  ['memo', 'Memo / description', false],
  ['line', 'Budget line (names must match)', false],
];
const PRESETS = ['QuickBooks', 'Xero', 'Bank'];

// ---------- CSV reading ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

// QuickBooks reports put a few title lines on top. Find the row with the column names.
function guessHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if (rows[i].some((x) => /date/i.test(x)) && rows[i].filter(Boolean).length >= 2) return i;
  }
  return 0;
}

function guessMap(headers) {
  const find = (re, not = []) => {
    const i = headers.findIndex((h, k) => re.test(h) && !not.includes(k));
    return i;
  };
  const m = { date: find(/date/i) };
  m.out = find(/debit|withdraw|money out|paid out|spent|payment/i);
  m.in = find(/credit|deposit|money in|received/i);
  m.amount = find(/^amount$|amount|total/i, [m.out, m.in]);
  m.vendor = find(/vendor|payee|merchant|paid to|^name$|contact/i);
  if (m.vendor < 0) m.vendor = find(/description/i);
  m.memo = find(/memo|description|details|note|reference/i, [m.vendor]);
  m.line = find(/budget line|category|class|account/i, [m.vendor, m.memo]);
  const cols = {};
  for (const [k] of FIELDS) cols[k] = m[k] >= 0 ? headers[m[k]] : '';
  return {
    cols,
    amountMode: m.amount < 0 && m.out >= 0 ? 'two' : 'one',
    negSpent: false, dateOrder: 'mdy', refunds: false,
  };
}

// ---------- value cleanup ----------
function parseMoney(v) {
  let s = String(v ?? '').trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  s = s.replace(/[$€£\s,]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return NaN;
  const n = parseFloat(s);
  return neg ? -n : n;
}

function parseDate(v, order) {
  const s = String(v ?? '').trim();
  let y, mo, d, m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    [, mo, d, y] = m;
    if (order === 'dmy') [mo, d] = [d, mo];
    if (y.length === 2) y = '20' + y;
  } else {
    const t = new Date(s);
    if (!s || isNaN(t)) return null;
    y = t.getFullYear(); mo = t.getMonth() + 1; d = t.getDate();
  }
  y = +y; mo = +mo; d = +d;
  const check = new Date(y, mo - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------- the screen ----------
export async function viewImport(grantId, h) {
  const { app, sb, state, esc, money, toast, friendlyError, fetchAll, canEdit, fmtDate } = h;
  app.innerHTML = '<p class="loading">Loading…</p>';
  const org = state.org.id;
  const [{ data: g, error }, lines, existing, mapRes] = await Promise.all([
    sb.from('grants').select('id, title').eq('id', grantId).maybeSingle(),
    fetchAll(() => sb.from('budget_lines').select('id, name').eq('grant_id', grantId).order('created_at')),
    fetchAll(() => sb.from('expenses').select('date, amount, vendor').eq('grant_id', grantId).order('id')),
    sb.from('csv_mappings').select('*').eq('org_id', org).order('source_name'),
  ]);
  if (error) throw error;
  if (!g) { app.innerHTML = '<div class="alert">Grant not found.</div><a class="btn" href="#/grants">Back to grants</a>'; return; }
  const mapsMissing = !!mapRes.error;
  let saved = mapRes.data || [];

  const lineByName = Object.fromEntries(lines.map((l) => [l.name.trim().toLowerCase(), l.id]));
  const dupKey = (date, amount, vendor) => `${date}|${Number(amount).toFixed(2)}|${String(vendor || '').trim().toLowerCase()}`;
  const have = new Set(existing.map((x) => dupKey(x.date, x.amount, x.vendor)));
  const lineOptions = (sel) => `<option value="">${lines.length ? 'Choose a line…' : '(no budget lines yet)'}</option>` +
    lines.map((l) => `<option value="${l.id}" ${l.id === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('');

  const validLine = (id) => (lines.some((l) => l.id === id) ? id : '');
  let rows = [], headerRow = 0, headers = [], map = null, preview = [];

  app.innerHTML = `
    <a href="#/grant/${g.id}">← Back to ${esc(g.title)}</a>
    <h1>Import expenses</h1>
    <div class="note">Export your expenses as a CSV file from QuickBooks, Xero, or your bank, then pick it here.
      The file stays on your phone. Only the rows you choose get saved.
      <a href="samples/sample-expenses.csv" download>Download a sample file</a>.</div>
    ${mapsMissing ? '<div class="alert">Saved mappings aren\'t set up in the database yet, so this mapping can\'t be saved. Importing still works.</div>' : ''}

    <div class="card">
      <h2>1. Pick the file</h2>
      <label>CSV file<input type="file" id="file" accept=".csv,text/csv,text/plain"></label>
      <div id="file-info"></div>
    </div>
    <div id="map-card"></div>
    <div id="preview-card"></div>`;

  app.querySelector('#file').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('That file is over 5 MB. Export a shorter date range.', true);
    rows = parseCSV(await f.text());
    if (rows.length < 2) { app.querySelector('#file-info').innerHTML = '<div class="alert">No rows found in that file. Is it a CSV?</div>'; return; }
    headerRow = guessHeaderRow(rows);
    app.querySelector('#file-info').innerHTML = `<p>${esc(f.name)} · ${rows.length - headerRow - 1} rows</p>`;
    setHeaders();
    map = guessMap(headers);
    drawMap('');
  };

  function setHeaders() {
    headers = rows[headerRow].map((x, i) => x || `Column ${i + 1}`);
  }

  function drawMap(sourceName) {
    const colOpts = (sel) => '<option value="">(none)</option>' +
      headers.map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');
    const sources = [...new Set([...saved.map((s) => s.source_name), ...PRESETS])];
    const isSaved = saved.some((s) => s.source_name === sourceName);
    app.querySelector('#map-card').innerHTML = `
      <form class="card" id="f-map">
        <h2>2. Match the columns</h2>
        <label>Where is this file from?
          <select name="source">
            <option value="">Choose…</option>
            ${sources.map((s) => `<option value="${esc(s)}" ${s === sourceName ? 'selected' : ''}>${esc(s)}${saved.some((x) => x.source_name === s) ? ' (saved)' : ''}</option>`).join('')}
            <option value="__new" ${sourceName && !sources.includes(sourceName) ? 'selected' : ''}>Something else…</option>
          </select></label>
        <label id="new-src" ${sourceName && !sources.includes(sourceName) ? '' : 'hidden'}>Name for this source
          <input name="newsource" maxlength="60" placeholder="e.g. First National checking" value="${sourceName && !sources.includes(sourceName) ? esc(sourceName) : ''}"></label>
        ${isSaved ? '<div class="note">Using your saved mapping for this source. Change anything below if it looks wrong.</div>' : ''}
        <label>Column names are on row
          <input name="headerRow" inputmode="numeric" value="${headerRow + 1}"></label>
        <label>${FIELDS[0][1]} *<select name="c_date">${colOpts(map.cols.date)}</select></label>
        <label>Date style
          <select name="dateOrder">
            <option value="mdy" ${map.dateOrder === 'mdy' ? 'selected' : ''}>Month/Day/Year (US, like 3/25/2026)</option>
            <option value="dmy" ${map.dateOrder === 'dmy' ? 'selected' : ''}>Day/Month/Year (like 25/3/2026)</option>
          </select></label>
        <label>How are amounts shown?
          <select name="amountMode">
            <option value="one" ${map.amountMode === 'one' ? 'selected' : ''}>One amount column</option>
            <option value="two" ${map.amountMode === 'two' ? 'selected' : ''}>Two columns: money out and money in</option>
          </select></label>
        <div id="one" class="stack" ${map.amountMode === 'one' ? '' : 'hidden'}>
          <label>Amount *<select name="c_amount">${colOpts(map.cols.amount)}</select></label>
          <label class="check"><input type="checkbox" name="negSpent" ${map.negSpent ? 'checked' : ''}> Money spent shows as a minus number (most bank files)</label>
        </div>
        <div id="two" class="stack" ${map.amountMode === 'two' ? '' : 'hidden'}>
          <label>Money out *<select name="c_out">${colOpts(map.cols.out)}</select></label>
          <label>Money in<select name="c_in">${colOpts(map.cols.in)}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="refunds" ${map.refunds ? 'checked' : ''}> Also import refunds / money in (as minus expenses)</label>
        <label>Vendor / paid to<select name="c_vendor">${colOpts(map.cols.vendor)}</select></label>
        <label>Memo<select name="c_memo">${colOpts(map.cols.memo)}</select></label>
        <label>Budget line column (optional)<select name="c_line">${colOpts(map.cols.line)}</select></label>
        <label>Budget line for rows with no match
          <select name="defaultLine">${lineOptions(validLine(map.defaultLine) || (lines.length === 1 ? lines[0].id : ''))}</select></label>
      </form>`;
    const f = app.querySelector('#f-map');
    f.addEventListener('change', (ev) => {
      const name = ev.target.name;
      if (name === 'source') {
        const v = ev.target.value;
        app.querySelector('#new-src').hidden = v !== '__new';
        const s = saved.find((x) => x.source_name === v);
        if (s) { map = { ...guessMap(headers), ...s.column_map, cols: { ...guessMap(headers).cols, ...(s.column_map.cols || {}) } }; return drawMap(v); }
      }
      if (name === 'headerRow') {
        const n = parseInt(ev.target.value, 10);
        if (n >= 1 && n < rows.length) { headerRow = n - 1; setHeaders(); map = guessMap(headers); return drawMap(currentSource()); }
        return toast(`Enter a row number from 1 to ${rows.length - 1}`, true);
      }
      readMap();
      app.querySelector('#one').hidden = map.amountMode !== 'one';
      app.querySelector('#two').hidden = map.amountMode !== 'two';
      buildPreview();
    });
    f.addEventListener('submit', (ev) => ev.preventDefault());
    buildPreview();
  }

  function currentSource() {
    const f = app.querySelector('#f-map');
    if (!f) return '';
    return f.elements.source.value === '__new' ? f.elements.newsource.value.trim() : f.elements.source.value;
  }

  function readMap() {
    const e = app.querySelector('#f-map').elements;
    const cols = {};
    for (const [k] of FIELDS) cols[k] = e['c_' + k].value;
    map = {
      cols, amountMode: e.amountMode.value, negSpent: e.negSpent.checked,
      dateOrder: e.dateOrder.value, refunds: e.refunds.checked, defaultLine: e.defaultLine.value,
    };
  }

  function buildPreview() {
    const idx = (k) => map.cols[k] ? headers.indexOf(map.cols[k]) : -1;
    const at = (r, k) => (idx(k) >= 0 ? r[idx(k)] ?? '' : '');
    const box = app.querySelector('#preview-card');
    const needAmt = map.amountMode === 'one' ? idx('amount') : idx('out');
    if (idx('date') < 0 || needAmt < 0) {
      box.innerHTML = '<div class="alert">Choose the Date column and the amount column to see your rows.</div>';
      return;
    }
    const seen = new Set();
    preview = rows.slice(headerRow + 1).map((r, i) => {
      const date = parseDate(at(r, 'date'), map.dateOrder);
      let amount;
      if (map.amountMode === 'one') {
        amount = parseMoney(at(r, 'amount'));
        if (map.negSpent) amount = -amount;
      } else {
        const o = parseMoney(at(r, 'out')), n = parseMoney(at(r, 'in'));
        amount = Number.isFinite(o) && o !== 0 ? Math.abs(o) : Number.isFinite(n) && n !== 0 ? -Math.abs(n) : NaN;
      }
      const vendor = at(r, 'vendor').slice(0, 200);
      const memo = at(r, 'memo').slice(0, 500);
      const lineText = at(r, 'line').trim().toLowerCase();
      const lineId = lineByName[lineText] || validLine(map.defaultLine);
      let problem = '';
      if (!date) problem = `Can't read the date "${at(r, 'date')}"`;
      else if (!Number.isFinite(amount) || amount === 0) problem = 'No amount';
      else if (amount < 0 && !map.refunds) problem = 'Money in (skipped)';
      const key = date && Number.isFinite(amount) ? dupKey(date, amount, vendor) : '';
      const dup = key && (have.has(key) || seen.has(key));
      if (key) seen.add(key);
      return { n: headerRow + i + 2, date, amount, vendor, memo, lineId, problem, dup, on: !problem && !dup };
    });
    drawPreview();
  }

  function drawPreview() {
    const box = app.querySelector('#preview-card');
    const good = preview.filter((p) => !p.problem);
    const on = preview.filter((p) => p.on);
    const skipped = preview.length - good.length;
    const dups = good.filter((p) => p.dup).length;
    const src = currentSource();
    box.innerHTML = `
      <div class="card">
        <h2>3. Check the rows</h2>
        <p><b>${on.length}</b> to import · total <b>${money(on.reduce((t, p) => t + p.amount, 0))}</b></p>
        ${skipped ? `<p class="small">${skipped} row${skipped === 1 ? '' : 's'} skipped (shown at the bottom).</p>` : ''}
        ${dups ? `<div class="alert">${dups} row${dups === 1 ? ' looks' : 's look'} like ${dups === 1 ? 'it is' : 'they are'} already in this grant (same date, amount and vendor). Unchecked so you don't count ${dups === 1 ? 'it' : 'them'} twice.</div>` : ''}
        <div class="actions">
          <button class="btn ghost small" type="button" id="all-on">Check all</button>
          <button class="btn ghost small" type="button" id="all-off">Uncheck all</button>
        </div>
        <ul class="list">${preview.map((p, i) => p.problem ? '' : `
          <li>
            <label class="check"><input type="checkbox" data-on="${i}" ${p.on ? 'checked' : ''}>
              <span><b>${money(p.amount)}</b> · ${fmtDate(p.date)}${p.dup ? ' · <span class="tag">already added?</span>' : ''}</span></label>
            <div>${esc(p.vendor || 'No vendor')}${p.memo ? ` · <span class="small">${esc(p.memo)}</span>` : ''}</div>
            ${lines.length ? `<select data-line="${i}" aria-label="Budget line for row ${p.n}">${lineOptions(p.lineId)}</select>` : ''}
          </li>`).join('')}</ul>
        ${skipped ? `<h3>Skipped rows</h3><ul class="list">${preview.filter((p) => p.problem).map((p) => `
          <li class="small">Row ${p.n}: ${esc(p.problem)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="card">
        ${!mapsMissing && canEdit() ? `<label class="check"><input type="checkbox" id="save-map" checked> Save this column matching for "${esc(src || 'this source')}"</label>` : ''}
        ${!mapsMissing && !canEdit() ? '<p class="small">Only Admin or Finance can save the column matching.</p>' : ''}
        <button class="btn" type="button" id="do-import" ${on.length ? '' : 'disabled'}>Import ${on.length} expense${on.length === 1 ? '' : 's'}</button>
      </div>`;

    box.querySelectorAll('[data-on]').forEach((c) => c.onchange = () => { preview[c.dataset.on].on = c.checked; drawPreview(); });
    box.querySelectorAll('[data-line]').forEach((s) => s.onchange = () => { preview[s.dataset.line].lineId = s.value; });
    box.querySelector('#all-on').onclick = () => { preview.forEach((p) => { if (!p.problem) p.on = true; }); drawPreview(); };
    box.querySelector('#all-off').onclick = () => { preview.forEach((p) => { p.on = false; }); drawPreview(); };
    box.querySelector('#do-import').onclick = doImport;
  }

  async function doImport() {
    const btn = app.querySelector('#do-import');
    const pick = preview.filter((p) => p.on);
    if (lines.length && pick.some((p) => !p.lineId)) {
      return toast('Some checked rows have no budget line. Pick a line for each one, or set "Budget line for rows with no match".', true);
    }
    const saveBox = app.querySelector('#save-map');
    const src = currentSource();
    if (saveBox?.checked && !src) return toast('Choose where this file is from so the matching can be saved.', true);

    btn.disabled = true;
    btn.textContent = 'Importing…';
    let done = 0;
    for (let i = 0; i < pick.length; i += 200) {
      const batch = pick.slice(i, i + 200).map((p) => ({
        org_id: org, grant_id: g.id, budget_line_id: p.lineId || null, date: p.date,
        vendor: p.vendor || null, amount: Math.round(p.amount * 100) / 100, memo: p.memo || null, source: 'csv',
      }));
      const { error: e } = await sb.from('expenses').insert(batch);
      if (e) {
        btn.disabled = false;
        btn.textContent = 'Try again';
        return toast(`${done ? `${done} imported, then it stopped: ` : ''}${friendlyError(e)}`, true);
      }
      done += batch.length;
    }

    if (saveBox?.checked) {
      const { error: e } = await sb.from('csv_mappings').upsert(
        { org_id: org, source_name: src, column_map: { ...map, defaultLine: undefined } }, { onConflict: 'org_id,source_name' });
      if (e) toast(`Expenses imported, but the matching wasn't saved: ${friendlyError(e)}`, true);
      else toast(`${done} expenses imported. Matching saved for "${src}".`);
    } else toast(`${done} expenses imported`);
    location.hash = `#/grant/${g.id}`;
  }
}
