// GrantKeep — Phase 4: deadlines screen, a grant's deadlines, reminder + calendar settings.
// Report due dates are made automatically by the database from each grant's
// reporting schedule (see supabase/phase4.sql). People can add their own too.

const TYPES = { narrative: 'Report', financial: 'Financial report', renewal: 'Renewal / reapply', draw: 'Payment request (draw)', other: 'Other' };

const daysUntil = (d, today) => Math.round((new Date(d + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);

function whenLabel(d, today) {
  if (d.status === 'submitted') return '<span class="ok">✓ Submitted</span>';
  const n = daysUntil(d.due_date, today);
  if (n < 0) return `<span class="late">⚠ ${-n} day${n === -1 ? '' : 's'} late</span>`;
  if (n === 0) return '<span class="late">⚠ Due today</span>';
  return `<span class="${n <= 7 ? 'soon' : ''}">In ${n} day${n === 1 ? '' : 's'}</span>`;
}

function item(d, h, showGrant) {
  const { esc, fmtDate, canEdit, today } = h;
  return `<li>
    <div class="row"><b>${esc(d.title || TYPES[d.type] || 'Deadline')}</b>${whenLabel(d, today())}</div>
    <div>${fmtDate(d.due_date)}${showGrant ? ` · <a href="#/grant/${d.grant_id}">${esc(d.grants?.title || 'Grant')}</a>` : ''}${d.auto ? '' : ' · added by hand'}</div>
    ${d.notes ? `<div class="small">${esc(d.notes)}</div>` : ''}
    ${canEdit() ? `<div class="actions">
      ${d.status === 'submitted'
        ? `<button class="btn ghost small" data-undo="${d.id}">Undo submitted</button>`
        : `<button class="btn small" data-submit="${d.id}">Mark submitted</button>`}
      <button class="btn danger small" data-del-dl="${d.id}">Delete</button></div>` : ''}
  </li>`;
}

function wire(box, h, reload) {
  const { sb, toast, friendlyError, confirmTap } = h;
  const set = async (id, status) => {
    const { error } = await sb.from('deadlines').update({ status }).eq('id', id);
    if (error) return toast(friendlyError(error), true);
    toast(status === 'submitted' ? 'Marked submitted' : 'Marked not submitted');
    reload();
  };
  box.querySelectorAll('[data-submit]').forEach((b) => b.onclick = () => set(b.dataset.submit, 'submitted'));
  box.querySelectorAll('[data-undo]').forEach((b) => b.onclick = () => set(b.dataset.undo, 'open'));
  box.querySelectorAll('[data-del-dl]').forEach((b) => b.onclick = () => confirmTap(b, async () => {
    const { error } = await sb.from('deadlines').delete().eq('id', b.dataset.delDl);
    if (error) return toast(friendlyError(error), true);
    toast('Deadline deleted'); reload();
  }));
}

// ---------- Deadlines tab (all grants) ----------
export async function viewDeadlines(h) {
  const { app, sb, state, fetchAll, today } = h;
  app.innerHTML = '<p class="loading">Loading deadlines…</p>';
  const rows = await fetchAll(() => sb.from('deadlines').select('*, grants(title, status)')
    .eq('org_id', state.org.id).order('due_date').order('id'));
  const t = today();
  const open = rows.filter((d) => d.status !== 'submitted' && d.grants?.status !== 'closed');
  const late = open.filter((d) => daysUntil(d.due_date, t) < 0);
  const soon = open.filter((d) => { const n = daysUntil(d.due_date, t); return n >= 0 && n <= 30; });
  const later = open.filter((d) => daysUntil(d.due_date, t) > 30);
  const done = rows.filter((d) => d.status === 'submitted').reverse().slice(0, 20);
  const list = (arr, empty) => arr.length ? `<ul class="list">${arr.map((d) => item(d, h, true)).join('')}</ul>` : `<p>${empty}</p>`;

  app.innerHTML = `
    <h1>Deadlines</h1>
    ${!rows.length ? `<div class="note">No deadlines yet. Give a grant a start date, end date and reporting schedule,
      and set its status to awarded or active — the report due dates appear here by themselves.</div>` : ''}
    ${late.length ? `<h2>⚠ Late (${late.length})</h2><div class="card">${list(late, '')}</div>` : ''}
    <h2>Next 30 days (${soon.length})</h2><div class="card">${list(soon, 'Nothing due in the next 30 days.')}</div>
    <h2>Later (${later.length})</h2><div class="card">${list(later, 'Nothing else scheduled.')}</div>
    ${done.length ? `<h2>Recently submitted</h2><div class="card">${list(done, '')}</div>` : ''}
    <p class="small">Reminder emails and your calendar link are in <a href="#/settings">Settings</a>.</p>`;
  wire(app, h, () => viewDeadlines(h));
}

// ---------- one grant's deadlines (shown on the grant page) ----------
export async function mountGrantDeadlines(el, g, h) {
  const { sb, state, esc, fetchAll, toast, friendlyError, canEdit, today } = h;
  const rows = await fetchAll(() => sb.from('deadlines').select('*').eq('grant_id', g.id).order('due_date').order('id'));
  const reload = () => mountGrantDeadlines(el, g, h);
  el.innerHTML = `
    <div class="card">
      ${rows.length ? `<ul class="list">${rows.map((d) => item(d, h, false)).join('')}</ul>`
        : `<p>No deadlines yet.${g.report_frequency === 'none' || !g.start_date || !g.end_date
          ? ' Add a start date, end date and reporting schedule to this grant and the report due dates are made for you.' : ''}</p>`}
      ${g.report_frequency !== 'none' ? `<p class="small">Report due dates come from the reporting schedule
        (${Number(g.report_due_days ?? 30)} days after each period ends). Changing the grant's dates or schedule updates them.</p>` : ''}
    </div>
    ${canEdit() ? `
    <form id="f-dl" class="card">
      <h3>Add a deadline</h3>
      <div class="two">
        <label>Kind<select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>Due date<input type="date" name="due_date" required value="${today()}"></label>
      </div>
      <label>What is due<input name="title" maxlength="200" placeholder="e.g. Site visit paperwork"></label>
      <label>Notes (optional)<input name="notes" maxlength="500"></label>
      <button class="btn" type="submit">Add deadline</button>
    </form>` : ''}`;
  wire(el, h, reload);
  const f = el.querySelector('#f-dl');
  if (f) f.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f).entries());
    const { error } = await sb.from('deadlines').insert({
      org_id: state.org.id, grant_id: g.id, type: d.type, due_date: d.due_date,
      title: d.title.trim() || null, notes: d.notes.trim() || null, auto: false,
    });
    if (error) return toast(friendlyError(error), true);
    toast('Deadline added'); reload();
  };
}

// ---------- Settings: reminder emails + calendar link ----------
export async function mountReminderSettings(el, h) {
  const { sb, state, esc, toast, friendlyError, isAdmin, confirmTap } = h;
  const [{ data: me }, { data: org }] = await Promise.all([
    sb.from('members').select('email_reminders').eq('id', state.member.id).maybeSingle(),
    sb.from('organizations').select('calendar_token').eq('id', state.org.id).maybeSingle(),
  ]);
  if (!org?.calendar_token) {
    el.innerHTML = '<div class="alert">Deadlines aren\'t set up in the database yet. Run supabase/phase4.sql in the Supabase SQL Editor.</div>';
    return;
  }
  const https = `${location.origin}/cal/${org.calendar_token}.ics`;
  const webcal = https.replace(/^https?:/, 'webcal:');
  el.innerHTML = `
    <div class="card">
      <label class="check"><input type="checkbox" id="rem" ${me?.email_reminders !== false ? 'checked' : ''}>
        Email me 30, 14, 7 and 1 days before each deadline</label>
      <p class="small">Admin and Finance get emails for every grant. Program staff get them for grants they own.
        Emails go to ${esc(state.member.email || state.session.user.email)}.</p>
    </div>
    <div class="card">
      <h3>Calendar link</h3>
      <p>Add this link to Google Calendar or Outlook and every deadline shows up there, and stays up to date.</p>
      <p class="mono">${esc(https)}</p>
      <div class="actions">
        <button class="btn small" id="copy-cal">Copy link</button>
        <a class="btn ghost small" href="${esc(webcal)}">Open in calendar app</a>
      </div>
      <p class="small"><b>Google Calendar:</b> on a computer, Other calendars → + → From URL → paste the link.
        <b>Outlook:</b> Add calendar → Subscribe from web → paste the link.</p>
      <p class="small">Keep this link private — anyone who has it can see your deadline dates and grant names (no money amounts).</p>
      ${isAdmin() ? '<button class="btn danger small" id="new-cal">Make a new link (the old one stops working)</button>' : ''}
    </div>`;
  el.querySelector('#rem').onchange = async (ev) => {
    const { error } = await sb.rpc('set_my_reminders', { p_org: state.org.id, p_on: ev.target.checked });
    if (error) { ev.target.checked = !ev.target.checked; return toast(friendlyError(error), true); }
    toast(ev.target.checked ? 'Reminder emails on' : 'Reminder emails off');
  };
  el.querySelector('#copy-cal').onclick = async () => {
    try { await navigator.clipboard.writeText(https); toast('Calendar link copied'); }
    catch { toast('Press and hold the link above to copy it', true); }
  };
  const reset = el.querySelector('#new-cal');
  if (reset) reset.onclick = () => confirmTap(reset, async () => {
    const { error } = await sb.rpc('reset_calendar_token', { p_org: state.org.id });
    if (error) return toast(friendlyError(error), true);
    toast('New calendar link made'); mountReminderSettings(el, h);
  });
}
