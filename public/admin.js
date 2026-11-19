// GrantKeep — Phase 6: team roles + invites, activity log, and "download all my data".

import { BUCKET } from './documents.js';

const ROLES = {
  admin: 'Admin — everything, including team and billing',
  finance: 'Finance — edit grants, money and documents',
  program: 'Program — view only, can add expenses, no salary lines',
};
const ROLE_SHORT = { admin: 'Admin', finance: 'Finance', program: 'Program' };

// ---------- Team ----------
export async function mountTeam(el, h, appUrl) {
  const { sb, state, esc, toast, friendlyError, fetchAll, isAdmin, confirmTap } = h;
  const admin = isAdmin();

  async function render() {
    let team, invites = [];
    try {
      team = await fetchAll(() => sb.from('members').select('id, email, role, user_id').eq('org_id', state.org.id).order('created_at'));
      if (admin) {
        const r = await sb.from('invites').select('*').eq('org_id', state.org.id).order('created_at');
        invites = r.error ? null : r.data; // null = phase6.sql not run yet
      }
    } catch (e) { el.innerHTML = `<div class="alert">${esc(friendlyError(e))}</div>`; return; }
    const me = state.session.user.id;

    el.innerHTML = `
      <div class="card"><ul class="list">${team.map((m) => `
        <li>
          <div class="row"><b>${esc(m.email || 'Member')}${m.user_id === me ? ' (you)' : ''}</b>
            ${admin ? '' : `<span>${ROLE_SHORT[m.role]}</span>`}</div>
          ${admin ? `<label>Role<select data-role="${m.id}">${Object.keys(ROLES).map((r) =>
            `<option value="${r}" ${r === m.role ? 'selected' : ''}>${ROLE_SHORT[r]}</option>`).join('')}</select></label>
            ${m.user_id === me ? '' : `<button class="btn danger small" data-remove="${m.id}">Remove from team</button>`}` : ''}
        </li>`).join('')}</ul></div>
      ${admin && invites === null ? '<div class="alert">Inviting needs a database update. Run supabase/phase6.sql in Supabase.</div>' : ''}
      ${admin && invites?.length ? `<h3>Waiting to join</h3><div class="card"><ul class="list">${invites.map((i) => `
        <li><div class="row"><b>${esc(i.email)}</b><span>${ROLE_SHORT[i.role]}</span></div>
          <button class="btn danger small" data-cancel="${i.id}">Cancel invite</button></li>`).join('')}</ul></div>` : ''}
      ${admin && invites ? `
      <form id="f-invite" class="card">
        <h3>Invite someone</h3>
        <label>Their email<input type="email" name="email" required maxlength="200" autocomplete="off"></label>
        <label>Role<select name="role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === 'program' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <button class="btn" type="submit">Invite</button>
        <p class="small">Then tell them to open <b>${esc(appUrl)}</b> and sign in with that email. They'll join your team automatically.</p>
      </form>` : ''}`;

    el.querySelectorAll('[data-role]').forEach((s) => s.addEventListener('change', async () => {
      const m = team.find((x) => x.id === s.dataset.role);
      const { error } = await sb.from('members').update({ role: s.value }).eq('id', m.id);
      if (error) { toast(friendlyError(error), true); s.value = m.role; return; }
      toast(`${m.email || 'Member'} is now ${ROLE_SHORT[s.value]}`);
      if (m.user_id === me) location.reload(); else render();
    }));
    el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => confirmTap(b, async () => {
      const { error } = await sb.from('members').delete().eq('id', b.dataset.remove);
      if (error) return toast(friendlyError(error), true);
      toast('Removed from team'); render();
    }, 'Tap again to remove')));
    el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      const { error } = await sb.from('invites').delete().eq('id', b.dataset.cancel);
      if (error) return toast(friendlyError(error), true);
      render();
    }));
    const f = el.querySelector('#f-invite');
    f?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = f.email.value.trim().toLowerCase();
      if (team.some((m) => (m.email || '').toLowerCase() === email)) return toast('That person is already on the team.', true);
      const { error } = await sb.from('invites').insert({ org_id: state.org.id, email, role: f.role.value });
      if (error) return toast(/duplicate|unique/i.test(error.message) ? 'That email is already invited.' : friendlyError(error), true);
      toast('Invite saved'); render();
    });
  }
  render();
}

// ---------- Activity log ----------
const WHAT = { grants: 'Grant', expenses: 'Expense', budget_lines: 'Budget line', deadlines: 'Deadline',
  documents: 'Document', members: 'Team member', funders: 'Funder' };
const DID = { insert: 'Added', update: 'Changed', delete: 'Deleted' };
const PAGE = 100;

export async function viewActivity(h) {
  const { app, sb, state, esc, isAdmin, friendlyError } = h;
  if (!isAdmin()) { app.innerHTML = '<div class="alert">Only Admins can see the activity log.</div>'; return; }
  app.innerHTML = `<a href="#/settings">← Settings</a>
    <h1>Activity log</h1>
    <div class="note">Every change to grants, money, deadlines, documents and the team, newest first. It's written automatically, so nobody can edit it.</div>
    <div class="card"><ul class="list" id="act"></ul></div>
    <button class="btn ghost" id="more" hidden>Show more</button>`;
  const list = app.querySelector('#act'), more = app.querySelector('#more');
  let from = 0;
  const when = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  async function load() {
    more.disabled = true;
    const { data, error } = await sb.from('activity_log').select('*, members(email)').eq('org_id', state.org.id)
      .order('created_at', { ascending: false }).range(from, from + PAGE - 1);
    if (error) { list.insertAdjacentHTML('beforeend', `<li class="late">${esc(friendlyError(error))}</li>`); return; }
    if (!from && !data.length) list.innerHTML = '<li>Nothing yet.</li>';
    list.insertAdjacentHTML('beforeend', data.map((a) => {
      const [table, id] = a.target.split(':');
      const label = `${DID[a.action] || a.action} ${(WHAT[table] || table).toLowerCase()}`;
      const link = table === 'grants' && a.action !== 'delete' ? ` · <a href="#/grant/${esc(id)}">open</a>` : '';
      return `<li><div class="row"><b>${esc(label)}</b><span class="small">${esc(when(a.created_at))}</span></div>
        <div>${esc(a.details || '')}${link}</div>
        <div class="small">by ${esc(a.members?.email || 'the system')}</div></li>`;
    }).join(''));
    from += data.length;
    more.hidden = data.length < PAGE; more.disabled = false;
  }
  more.addEventListener('click', load);
  load();
}

// ---------- Download all my data ----------
const TABLES = ['grants', 'funders', 'budget_lines', 'expenses', 'deadlines', 'documents', 'report_exports',
  'csv_mappings', 'members', 'invites', 'activity_log'];

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}
const clean = (s) => String(s || 'file').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'file';

export async function fullExport(h, setMsg) {
  const { sb, state, fetchAll, today } = h;
  const { default: JSZip } = await import('https://esm.sh/jszip@3.10.1');
  const zip = new JSZip();
  const org = state.org;
  const data = {};
  for (const t of TABLES) {
    setMsg(`Gathering ${t.replace('_', ' ')}…`);
    try { data[t] = await fetchAll(() => sb.from(t).select('*').eq('org_id', org.id)); }
    catch { data[t] = []; } // table may not exist yet
    zip.file(`data/${t}.csv`, toCsv(data[t]));
  }
  zip.file('data/organization.csv', toCsv([org]));

  const titles = Object.fromEntries(data.grants.map((g) => [g.id, g.title]));
  const docs = data.documents;
  let missing = 0;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    setMsg(`Adding file ${i + 1} of ${docs.length}…`);
    const { data: blob, error } = await sb.storage.from(BUCKET).download(d.file_path);
    if (error) { missing++; continue; }
    const name = d.name || d.file_path.split('/').pop();
    zip.file(`files/${clean(titles[d.grant_id] || 'No grant')}/${d.id.slice(0, 8)}-${clean(name)}`, blob);
  }
  zip.file('README.txt', [
    `GrantKeep export for ${org.name}`, `Made ${today()}`, '',
    'data/  - one spreadsheet (CSV) per kind of record. Opens in Excel or Google Sheets.',
    'files/ - every uploaded document, in a folder per grant.',
    missing ? `\n${missing} file(s) could not be downloaded.` : '',
  ].join('\r\n'));
  setMsg('Zipping…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const name = `GrantKeep-${clean(org.name).replace(/\s+/g, '-')}-${today()}.zip`;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setMsg(`Downloaded ${name}${missing ? ` (${missing} file(s) missing)` : ''}. Check your phone's Downloads folder.`);
}
