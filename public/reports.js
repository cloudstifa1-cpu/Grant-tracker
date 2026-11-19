// GrantKeep — Phase 5: report builder (budget vs. actual for any date range,
// variance notes) with PDF, Word and Excel export. Files are made right in the
// browser, so grant data never goes to any other server.

const LIB = {
  pdf: 'https://esm.sh/jspdf@2.5.2',
  table: 'https://esm.sh/jspdf-autotable@3.8.4?deps=jspdf@2.5.2',
  docx: 'https://esm.sh/docx@8.5.0',
  xlsx: 'https://esm.sh/xlsx@0.18.5',
};
const VARIANCE_POINTS = 15; // flag a line when % spent is this far from % of time used

const sum = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const pctText = (n) => `${Math.round(n)}%`;
const safeName = (s) => String(s || 'report').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'report';

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// How much of the grant's time has passed by the end of the report period.
function timeUsed(g, end) {
  if (!g.start_date || !g.end_date) return null;
  const s = new Date(g.start_date + 'T00:00:00'), e = new Date(g.end_date + 'T00:00:00'), p = new Date(end + 'T00:00:00');
  const total = e - s; if (total <= 0) return null;
  return Math.min(100, Math.max(0, ((p - s) / total) * 100));
}

// Builds all the numbers for the report.
function buildReport(g, lines, expenses, start, end) {
  const inPeriod = expenses.filter((x) => x.date >= start && x.date <= end);
  const toDate = expenses.filter((x) => x.date <= end);
  const t = timeUsed(g, end);
  const rows = (lines.length ? lines : [{ id: '__all', name: 'Whole grant', approved_amount: g.amount_awarded }]).map((l) => {
    const match = (x) => l.id === '__all' || x.budget_line_id === l.id;
    const approved = Number(l.approved_amount) || 0;
    const period = sum(inPeriod.filter(match), (x) => x.amount);
    const spent = sum(toDate.filter(match), (x) => x.amount);
    const p = pct(spent, approved);
    let flag = '';
    if (spent > approved + 0.005) flag = 'Over budget';
    else if (t != null && approved > 0 && Math.abs(p - t) >= VARIANCE_POINTS) flag = p > t ? 'Spending ahead of schedule' : 'Spending behind schedule';
    return { id: l.id, name: l.name, approved, period, spent, remaining: approved - spent, pct: p, flag };
  });
  if (lines.length) {
    const untagged = (arr) => sum(arr.filter((x) => !x.budget_line_id), (x) => x.amount);
    const up = untagged(inPeriod), ut = untagged(toDate);
    if (up || ut) rows.push({ id: '__none', name: 'Not tagged to a budget line', approved: 0, period: up, spent: ut, remaining: -ut, pct: 0, flag: 'Needs a budget line' });
  }
  const total = {
    name: 'TOTAL', approved: sum(rows, (r) => r.approved), period: sum(rows, (r) => r.period),
    spent: sum(rows, (r) => r.spent),
  };
  total.remaining = total.approved - total.spent; total.pct = pct(total.spent, total.approved);
  return { rows, total, timeUsed: t, expenses: inPeriod.slice().sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

export async function viewReport(grantId, h) {
  const { app, sb, state, esc, money, toast, friendlyError, fetchAll, canEdit, fmtDate, today } = h;
  app.innerHTML = '<p class="loading">Loading report…</p>';
  const [{ data: g, error }, lines, expenses] = await Promise.all([
    sb.from('grants').select('*, funders(name)').eq('id', grantId).maybeSingle(),
    fetchAll(() => sb.from('budget_lines').select('*').eq('grant_id', grantId).order('created_at')),
    fetchAll(() => sb.from('expenses').select('*').eq('grant_id', grantId).order('date')),
  ]);
  if (error) throw error;
  if (!g) { app.innerHTML = '<div class="alert">Grant not found.</div><a class="btn" href="#/grants">Back to grants</a>'; return; }

  // Dates and notes are saved on this phone/browser, so no extra database setup is needed.
  const KEY = `gk_report_${grantId}`;
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const prev = saved.start ? saved : null;
  const notes = { ...(saved.notes || {}) };
  const t0 = today();
  const defStart = g.start_date || `${t0.slice(0, 4)}-01-01`;
  const defEnd = g.end_date && g.end_date < t0 ? g.end_date : t0;
  let start = prev?.start || defStart, end = prev?.end || defEnd;
  let narrative = saved.summary || '';
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify({ start, end, notes, summary: narrative })); } catch { /* storage full or blocked */ } };

  app.innerHTML = `
    <a href="#/grant/${g.id}">← Back to grant</a>
    <h1>Report: ${esc(g.title)}</h1>
    <div class="note">Pick the dates the funder asked about. Add a note on any line marked ⚠, then tap a button at the bottom to download the report.</div>
    <form id="f-period" class="card">
      <div class="two">
        <label>From<input type="date" name="start" required value="${esc(start)}"></label>
        <label>To<input type="date" name="end" required value="${esc(end)}"></label>
      </div>
      <div class="actions">
        <button class="btn" type="submit">Update report</button>
        <button class="btn ghost" type="button" id="whole">Whole grant</button>
      </div>
    </form>
    <div id="rep"></div>
    <label class="card">Summary note (optional, goes at the top of the report)
      <textarea id="summary" rows="3" maxlength="3000" placeholder="e.g. Program is on track. Supply costs ran high in March.">${esc(narrative)}</textarea></label>
    <label class="check card"><input type="checkbox" id="withExp" checked> Include the list of expenses for these dates</label>
    <h2>Download</h2>
    <div class="actions">
      <button class="btn" data-fmt="pdf">PDF</button>
      <button class="btn" data-fmt="docx">Word</button>
      <button class="btn" data-fmt="xlsx">Excel</button>
    </div>
    <p class="small" id="dl-msg"></p>`;

  const rep = app.querySelector('#rep');
  let data;
  const render = () => {
    data = buildReport(g, lines, expenses, start, end);
    const { rows, total, timeUsed: t } = data;
    rep.innerHTML = `
      <h2>Budget vs. actual</h2>
      <p><b>${fmtDate(start)} → ${fmtDate(end)}</b>${t != null ? ` · ${pctText(t)} of the grant's time used by the end date` : ''}</p>
      ${rows.map((r) => `
        <div class="card">
          <div class="row"><h3>${esc(r.name)}</h3>${r.flag ? `<span class="${r.flag === 'Over budget' || r.id === '__none' ? 'late' : 'soon'}">⚠ ${esc(r.flag)}</span>` : ''}</div>
          <div class="two small">
            <div>Approved<br><b>${money(r.approved)}</b></div>
            <div>Spent in these dates<br><b>${money(r.period)}</b></div>
            <div>Spent to date<br><b>${money(r.spent)}</b></div>
            <div>Remaining<br><b class="${r.remaining < 0 ? 'late' : ''}">${money(r.remaining)}</b></div>
          </div>
          <p><b>${r.approved ? pctText(r.pct) + ' spent' : ''}</b></p>
          <label>Variance note${r.flag ? ' (funders usually want one here)' : ''}
            <textarea rows="2" maxlength="1000" data-note="${esc(r.id)}">${esc(notes[r.id] || '')}</textarea></label>
        </div>`).join('')}
      <div class="card">
        <h3>Total</h3>
        <div class="two small">
          <div>Approved<br><b>${money(total.approved)}</b></div>
          <div>Spent in these dates<br><b>${money(total.period)}</b></div>
          <div>Spent to date<br><b>${money(total.spent)}</b></div>
          <div>Remaining<br><b class="${total.remaining < 0 ? 'late' : ''}">${money(total.remaining)}</b></div>
        </div>
        <p><b>${pctText(total.pct)} spent</b> · ${data.expenses.length} expense${data.expenses.length === 1 ? '' : 's'} in these dates</p>
      </div>`;
    rep.querySelectorAll('[data-note]').forEach((ta) => ta.addEventListener('input', () => { notes[ta.dataset.note] = ta.value; keep(); }));
  };
  render();

  const form = app.querySelector('#f-period');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const s = form.start.value, en = form.end.value;
    if (!s || !en || en < s) return toast('The "To" date must be on or after the "From" date.', true);
    start = s; end = en; keep(); render();
  });
  app.querySelector('#whole').addEventListener('click', () => {
    form.start.value = g.start_date || defStart; form.end.value = g.end_date || defEnd;
    form.requestSubmit();
  });
  app.querySelector('#summary').addEventListener('input', (e) => { narrative = e.target.value; keep(); });

  const msg = app.querySelector('#dl-msg');
  app.querySelectorAll('[data-fmt]').forEach((btn) => btn.addEventListener('click', async () => {
    const fmt = btn.dataset.fmt;
    const info = {
      org: state.org?.name || '', grant: g.title, funder: g.funders?.name || '', awarded: Number(g.amount_awarded) || 0,
      start, end, startText: fmtDate(start), endText: fmtDate(end), grantDates: `${fmtDate(g.start_date)} – ${fmtDate(g.end_date)}`,
      made: fmtDate(today()), summary: narrative.trim(), withExp: app.querySelector('#withExp').checked,
      lineName: Object.fromEntries(lines.map((l) => [l.id, l.name])),
    };
    const name = `${safeName(g.title)}_${start}_to_${end}.${fmt}`;
    app.querySelectorAll('[data-fmt]').forEach((b) => { b.disabled = true; });
    msg.textContent = 'Making your file…';
    try {
      const blob = await ({ pdf: makePdf, docx: makeDocx, xlsx: makeXlsx }[fmt])(data, notes, info, money);
      download(blob, name);
      msg.textContent = `Downloaded ${name}. Check your phone's Downloads folder.`;
      if (canEdit()) {
        // Keep a simple history of which reports were made.
        const { error: e2 } = await sb.from('report_exports').insert({
          org_id: g.org_id, grant_id: g.id, period_start: start, period_end: end, file_path: name,
        });
        if (e2) console.warn('Report history not saved:', e2.message);
      }
    } catch (e) {
      console.error(e);
      msg.textContent = '';
      toast(`Couldn't make the file: ${friendlyError(e)}`, true);
    } finally {
      app.querySelectorAll('[data-fmt]').forEach((b) => { b.disabled = false; });
    }
  }));
}

// ---------- shared table content ----------
const HEAD = ['Budget line', 'Approved', 'Spent in period', 'Spent to date', 'Remaining', '% spent', 'Variance note'];
function tableRows(data, notes, money) {
  const out = data.rows.map((r) => [r.name, money(r.approved), money(r.period), money(r.spent), money(r.remaining),
    r.approved ? pctText(r.pct) : '—', [r.flag ? `⚠ ${r.flag}` : '', notes[r.id] || ''].filter(Boolean).join(' — ')]);
  const t = data.total;
  out.push([t.name, money(t.approved), money(t.period), money(t.spent), money(t.remaining), pctText(t.pct), '']);
  return out;
}
const expRows = (data, info, money) => data.expenses.map((x) => [x.date, x.vendor || '', info.lineName[x.budget_line_id] || 'Not tagged', x.memo || '', money(x.amount)]);
const headerLines = (info, data, money) => [
  info.org && `Organization: ${info.org}`,
  `Grant: ${info.grant}`,
  info.funder && `Funder: ${info.funder}`,
  `Amount awarded: ${money(info.awarded)}`,
  `Grant dates: ${info.grantDates}`,
  `Report period: ${info.startText} – ${info.endText}`,
  data.timeUsed != null && `Grant time used by end of period: ${pctText(data.timeUsed)}`,
  `Prepared: ${info.made}`,
].filter(Boolean);
// jsPDF's built-in font can't draw ⚠, so swap it for plain text there.
const plain = (s) => String(s).replace(/⚠ ?/g, '! ');

// ---------- PDF ----------
async function makePdf(data, notes, info, money) {
  const [{ jsPDF }, at] = await Promise.all([import(LIB.pdf), import(LIB.table)]);
  // The table add-on loads a little differently depending on the server, so find it either way.
  const fn = [at.autoTable, at.default, at.default?.default, at.default?.autoTable].find((f) => typeof f === 'function');
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  if (!fn) (at.applyPlugin || at.default?.applyPlugin)(jsPDF);
  const autoTable = fn || ((d, o) => d.autoTable(o));
  const W = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  doc.text('Budget vs. Actual Report', 40, 50);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  let y = 72;
  headerLines(info, data, money).forEach((l) => { doc.text(l, 40, y); y += 15; });
  if (info.summary) {
    y += 6; doc.setFont('helvetica', 'bold'); doc.text('Summary', 40, y); y += 15; doc.setFont('helvetica', 'normal');
    const wrapped = doc.splitTextToSize(info.summary, W - 80); doc.text(wrapped, 40, y); y += wrapped.length * 14;
  }
  const body = tableRows(data, notes, money).map((r) => r.map(plain));
  autoTable(doc, {
    startY: y + 10, head: [HEAD], body, theme: 'grid',
    styles: { fontSize: 9, cellPadding: 4, textColor: 0, lineColor: 0, lineWidth: 0.5 },
    headStyles: { fillColor: [0, 0, 0], textColor: 255, fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { cellWidth: 220 } },
    didParseCell: (c) => { if (c.section === 'body' && c.row.index === body.length - 1) c.cell.styles.fontStyle = 'bold'; },
  });
  if (info.withExp && data.expenses.length) {
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 24, head: [['Date', 'Vendor', 'Budget line', 'Memo', 'Amount']],
      body: expRows(data, info, money), theme: 'grid',
      styles: { fontSize: 9, cellPadding: 3, textColor: 0, lineColor: 0, lineWidth: 0.5 },
      headStyles: { fillColor: [0, 0, 0], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 4: { halign: 'right' } },
    });
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFontSize(9);
    doc.text(`${info.grant} · Page ${i} of ${pages}`, 40, doc.internal.pageSize.getHeight() - 20);
  }
  return doc.output('blob');
}

// ---------- Word ----------
async function makeDocx(data, notes, info, money) {
  const d = await import(LIB.docx);
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, AlignmentType, PageOrientation, ShadingType } = d;
  const cell = (text, { bold = false, head = false, right = false } = {}) => new TableCell({
    shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: '000000' } : undefined,
    children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), bold: bold || head, color: head ? 'FFFFFF' : '000000', size: 18 })] })],
  });
  const table = (head, rows, rightCols, boldLast) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, { head: true, right: rightCols.includes(i) })) }),
      ...rows.map((r, ri) => new TableRow({ children: r.map((v, i) => cell(v, { right: rightCols.includes(i), bold: boldLast && ri === rows.length - 1 })) })),
    ],
  });
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Budget vs. Actual Report', bold: true, color: '000000' })] }),
    ...headerLines(info, data, money).map((l) => new Paragraph({ children: [new TextRun({ text: l, size: 22 })] })),
  ];
  if (info.summary) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200 }, children: [new TextRun({ text: 'Summary', bold: true, color: '000000' })] }));
    info.summary.split(/\n+/).forEach((p) => children.push(new Paragraph({ children: [new TextRun({ text: p, size: 22 })] })));
  }
  children.push(new Paragraph({ spacing: { before: 200 }, children: [] }), table(HEAD, tableRows(data, notes, money), [1, 2, 3, 4, 5], true));
  if (info.withExp && data.expenses.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 300 }, children: [new TextRun({ text: 'Expenses in this period', bold: true, color: '000000' })] }));
    children.push(table(['Date', 'Vendor', 'Budget line', 'Memo', 'Amount'], expRows(data, info, money), [4], false));
  }
  const doc = new Document({
    sections: [{ properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } }, children }],
  });
  return Packer.toBlob(doc);
}

// ---------- Excel ----------
async function makeXlsx(data, notes, info, money) {
  const X = await import(LIB.xlsx);
  const XLSX = X.utils ? X : X.default;
  const top = headerLines(info, data, money).map((l) => [l]);
  if (info.summary) top.push([], ['Summary'], [info.summary]);
  top.push([]);
  const headRow = top.length;
  // Real numbers (not text) so the funder can add them up.
  const rows = data.rows.map((r) => [r.name, r.approved, r.period, r.spent, r.remaining, r.approved ? r.pct / 100 : null,
    [r.flag ? `⚠ ${r.flag}` : '', notes[r.id] || ''].filter(Boolean).join(' — ')]);
  const t = data.total;
  rows.push([t.name, t.approved, t.period, t.spent, t.remaining, t.approved ? t.pct / 100 : null, '']);
  const ws = XLSX.utils.aoa_to_sheet([...top, HEAD, ...rows]);
  for (let r = headRow + 1; r <= headRow + rows.length; r++) {
    [1, 2, 3, 4].forEach((c) => { const a = XLSX.utils.encode_cell({ r, c }); if (ws[a]) ws[a].z = '$#,##0.00;[Red]-$#,##0.00'; });
    const p = XLSX.utils.encode_cell({ r, c: 5 }); if (ws[p]) ws[p].z = '0%';
  }
  ws['!cols'] = [{ wch: 32 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 9 }, { wch: 60 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Budget vs Actual');
  if (info.withExp) {
    const ex = XLSX.utils.aoa_to_sheet([['Date', 'Vendor', 'Budget line', 'Memo', 'Amount'],
      ...data.expenses.map((x) => [x.date, x.vendor || '', info.lineName[x.budget_line_id] || 'Not tagged', x.memo || '', Number(x.amount)])]);
    for (let r = 1; r <= data.expenses.length; r++) { const a = XLSX.utils.encode_cell({ r, c: 4 }); if (ex[a]) ex[a].z = '$#,##0.00'; }
    ex['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 28 }, { wch: 40 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ex, 'Expenses');
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
