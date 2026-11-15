// GrantKeep — Phase 1 (login, MFA, organization) + Phase 2 (grants, budget lines,
// expenses, budget-left meter). Plain JS, no build step.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const configured = SUPABASE_URL.startsWith('https://') && !SUPABASE_ANON_KEY.startsWith('PASTE_');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const state = { session: null, member: null, org: null, loadedFor: null };
const STATUSES = ['prospect', 'applied', 'awarded', 'active', 'closed'];
const SORT_RANK = { active: 0, awarded: 1, applied: 2, prospect: 3, closed: 4 };
const FUNDER_TYPES =['foundation', 'state', 'federal', 'corporate', 'local'];
const FREQS = { none: 'No set schedule', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every 6 months', annual: 'Yearly', final_only: 'Final report only' };
const WARN_AT = 90; // % spent where the red warning starts

// ---------- small helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n) => usd.format(Number(n) || 0);
const num = (v) => { const n = parseFloat(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : NaN; };
const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const canEdit = () => ['admin', 'finance'].includes(state.member?.role);
const isAdmin = () => state.member?.role === 'admin';
const sum = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 3000);
}

function friendlyError(e) {
  const m = e?.message || String(e);
  if (/expenses_budget_line_id_grant_id_fkey/.test(m)) return 'This budget line still has expenses. Delete or move those expenses first.';
  if (/row-level security/.test(m)) return 'Your role is not allowed to make this change.';
  return m;
}

// Supabase returns at most 1000 rows per request — page through everything.
async function fetchAll(makeQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// ---------- budget-left meter ----------
function meter(spent, approved, label = '') {
  const pct = approved > 0 ? (spent / approved) * 100 : (spent > 0 ? 100 : 0);
  const left = approved - spent;
  const cls = pct >= 100 ? 'over' : pct >= WARN_AT ? 'warn' : '';
  let flag = '';
  if (approved <= 0 && spent > 0) flag = '⚠ Spending with no approved budget';
  else if (pct > 100) flag = `⚠ OVER BUDGET by ${money(-left)}`;
  else if (pct >= 100) flag = '⚠ Fully spent — nothing left';
  else if (pct >= WARN_AT) flag = `⚠ ${pct.toFixed(0)}% used — almost out`;
  return `
    <div class="meter ${cls}" role="img" aria-label="${esc(label)} ${pct.toFixed(0)} percent spent">
      <div class="bar"><div class="fill" style="width:${Math.min(pct, 100).toFixed(1)}%"></div></div>
      <div class="nums"><span>${money(left)} left</span><span>${pct.toFixed(0)}% spent</span></div>
      <div class="small">Spent ${money(spent)} of ${money(approved)}</div>
      ${flag ? `<div class="flag">${flag}</div>` : ''}
    </div>`;
}

// ---------- routing ----------
window.addEventListener('hashchange', route);

async function route() {
  try {
    if (!configured) return viewSetupNeeded();
    if (!state.session) { nav.hidden = true; return viewLogin(); }

    // Two-step login: if the user has an authenticator app turned on, ask for the code.
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') { nav.hidden = true; return viewMfaChallenge(); }

    if (state.loadedFor !== state.session.user.id) await loadMembership();
    if (!state.member) { nav.hidden = true; return viewOnboarding(); }

    nav.hidden = false;
    const [, page, id] = (location.hash || '#/grants').split('/');
    nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${page}`));
    window.scrollTo(0, 0);
    if (page === 'grant' && id) return viewGrant(id);
    if (page === 'grant-new') return viewGrantForm(null);
    if (page === 'grant-edit' && id) return viewGrantForm(id);
    if (page === 'settings') return viewSettings();
    return viewGrants();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="alert">Something went wrong: ${esc(friendlyError(e))}</div>
      <button class="btn" onclick="location.reload()">Try again</button>`;
  }
}

async function loadMembership() {
  const { data, error } = await sb.from('members')
    .select('id, role, email, org_id, organizations(*)')
    .eq('user_id', state.session.user.id);
  if (error) throw error;
  const saved = localStorage.getItem('gk_org');
  const m = data.find((x) => x.org_id === saved) || data[0] || null;
  state.member = m;
  state.org = m?.organizations || null;
  state.loadedFor = state.session.user.id;
}

// ---------- views: setup / login / MFA / onboarding ----------
function viewSetupNeeded() {
  app.innerHTML = `
    <h1>Almost ready</h1>
    <div class="note">GrantKeep isn't connected to its database yet. Open <b>public/config.js</b> and paste
    your Supabase URL and anon public key. The README has the steps.</div>`;
}

function viewLogin() {
  app.innerHTML = `
    <h1>Sign in</h1>
    <p>Know what's left, what's due, and what to send, for every grant.</p>
    <form id="f-email" class="card">
      <label>Your email<input type="email" name="email" required autocomplete="email" inputmode="email"></label>
      <button class="btn" type="submit">Email me a sign-in link</button>
    </form>
    <form id="f-code" class="card" hidden>
      <p>Check your email. Tap the link, <b>or</b> type the 6-digit code from the email here.</p>
      <label>Code from email<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required></label>
      <button class="btn" type="submit">Sign in with code</button>
      <button class="btn ghost" type="button" id="b-again">Use a different email</button>
    </form>`;
  const fEmail = app.querySelector('#f-email');
  const fCode = app.querySelector('#f-code');
  let email = '';
  fEmail.onsubmit = async (ev) => {
    ev.preventDefault();
    email = formData(fEmail).email.trim();
    const btn = fEmail.querySelector('button'); btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    btn.disabled = false;
    if (error) return toast(error.message, true);
    fEmail.hidden = true; fCode.hidden = false;
    toast('Sign-in email sent');
  };
  fCode.onsubmit = async (ev) => {
    ev.preventDefault();
    const { error } = await sb.auth.verifyOtp({ email, token: formData(fCode).code.trim(), type: 'email' });
    if (error) toast(error.message, true);
  };
  app.querySelector('#b-again').onclick = () => { fCode.hidden = true; fEmail.hidden = false; };
}

async function viewMfaChallenge() {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  const factor = data.totp.find((f) => f.status === 'verified');
  app.innerHTML = `
    <h1>Two-step sign-in</h1>
    <form id="f" class="card">
      <label>6-digit code from your authenticator app
        <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus></label>
      <button class="btn" type="submit">Verify</button>
      <button class="btn ghost" type="button" id="out">Sign out</button>
    </form>`;
  app.querySelector('#out').onclick = () => sb.auth.signOut();
  app.querySelector('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: formData(ev.target).code.trim() });
    if (e2) return toast(e2.message, true);
    route();
  };
}

function viewOnboarding() {
  app.innerHTML = `
    <h1>Set up your organization</h1>
    <p>You'll be the Admin. You can invite your team later.</p>
    <form id="f" class="card">
      <label>Organization name<input name="name" required maxlength="200"></label>
      <label>EIN (optional)<input name="ein" maxlength="20" placeholder="12-3456789"></label>
      <label>Fiscal year starts in
        <select name="fy">${monthOptions(1)}</select></label>
      <button class="btn" type="submit">Create organization</button>
    </form>
    <button class="btn ghost" id="out">Sign out</button>`;
  app.querySelector('#out').onclick = () => sb.auth.signOut();
  app.querySelector('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const d = formData(ev.target);
    const { data, error } = await sb.rpc('create_organization', { p_name: d.name, p_ein: d.ein, p_fy_start: Number(d.fy) });
    if (error) return toast(friendlyError(error), true);
    localStorage.setItem('gk_org', data);
    state.loadedFor = null;
    location.hash = '#/grants';
    route();
  };
}

function monthOptions(selected) {
  return Array.from({ length: 12 }, (_, i) => {
    const name = new Date(2000, i, 1).toLocaleDateString('en-US', { month: 'long' });
    return `<option value="${i + 1}" ${selected === i + 1 ? 'selected' : ''}>${name}</option>`;
  }).join('');
}

// ---------- views: grants list ----------
async function viewGrants() {
  app.innerHTML = '<p class="loading">Loading grants…</p>';
  const org = state.org.id;
  const [grants, lines, expenses] = await Promise.all([
    fetchAll(() => sb.from('grants').select('*, funders(name)').eq('org_id', org).order('created_at')),
    fetchAll(() => sb.from('budget_lines').select('grant_id, approved_amount').eq('org_id', org).order('id')),
    fetchAll(() => sb.from('expenses').select('grant_id, amount').eq('org_id', org).order('id')),
  ]);

  const rows = grants.map((g) => {
    const gl = lines.filter((l) => l.grant_id === g.id);
    const approved = gl.length ? sum(gl, (l) => l.approved_amount) : Number(g.amount_awarded);
    const spent = sum(expenses.filter((x) => x.grant_id === g.id), (x) => x.amount);
    return { g, approved, spent };
  }).sort((a, b) => SORT_RANK[a.g.status] - SORT_RANK[b.g.status]
    || (a.g.end_date || '9999').localeCompare(b.g.end_date || '9999'));

  const live = rows.filter((r) => ['awarded', 'active'].includes(r.g.status));
  const totalApproved = sum(live, (r) => r.approved);
  const totalSpent = sum(live, (r) => r.spent);
  const programNote = state.member.role === 'program'
    ? '<div class="note">Your role is Program. Salary lines are hidden, so totals show non-salary spending only.</div>' : '';

  app.innerHTML = `
    <div class="row"><h1>${esc(state.org.name)}</h1>
      ${canEdit() ? '<a class="btn" href="#/grant-new">+ New grant</a>' : ''}</div>
    ${programNote}
    ${live.length ? `<div class="card"><h3>All awarded &amp; active grants</h3>${meter(totalSpent, totalApproved, 'All grants')}</div>` : ''}
    ${rows.length ? '' : `<div class="card"><p class="big">No grants yet.</p>
      <p>Add your first grant: funder, amount, dates, and the budget lines from the award letter.</p></div>`}
    ${rows.map(({ g, approved, spent }) => `
      <a class="card" href="#/grant/${g.id}">
        <div class="row"><h3>${esc(g.title)}</h3><span class="pill s-${g.status}">${g.status}</span></div>
        <div class="small">${esc(g.funders?.name || 'No funder set')} · ${money(g.amount_awarded)}
          ${g.restricted ? ' · <span class="tag">Restricted</span>' : ''}</div>
        <div class="small">${fmtDate(g.start_date)} → ${fmtDate(g.end_date)}${daysLeft(g)}</div>
        ${['awarded', 'active', 'closed'].includes(g.status) ? meter(spent, approved, g.title) : ''}
      </a>`).join('')}`;
}

function daysLeft(g) {
  if (!g.end_date || g.status === 'closed') return '';
  const d = Math.round((new Date(g.end_date + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
  if (d < 0) return ` · <b style="color:var(--bad)">ended ${-d} days ago</b>`;
  return ` · <b>${d} days left</b>`;
}

// ---------- views: one grant ----------
async function viewGrant(id) {
  app.innerHTML = '<p class="loading">Loading grant…</p>';
  const [{ data: g, error }, lines, expenses] = await Promise.all([
    sb.from('grants').select('*, funders(name, type, contact)').eq('id', id).maybeSingle(),
    fetchAll(() => sb.from('budget_lines').select('*').eq('grant_id', id).order('created_at')),
    fetchAll(() => sb.from('expenses').select('*').eq('grant_id', id).order('date', { ascending: false }).order('created_at', { ascending: false })),
  ]);
  if (error) throw error;
  if (!g) { app.innerHTML = '<div class="alert">Grant not found.</div><a class="btn" href="#/grants">Back to grants</a>'; return; }

  const spentByLine = {};
  expenses.forEach((x) => { const k = x.budget_line_id || 'none'; spentByLine[k] = (spentByLine[k] || 0) + Number(x.amount); });
  const approved = lines.length ? sum(lines, (l) => l.approved_amount) : Number(g.amount_awarded);
  const spent = sum(expenses, (x) => x.amount);
  const lineTotal = sum(lines, (l) => l.approved_amount);
  const mismatch = lines.length && Math.abs(lineTotal - g.amount_awarded) >= 0.01 && state.member.role !== 'program';
  const lineName = Object.fromEntries(lines.map((l) => [l.id, l.name]));
  const edit = canEdit();

  app.innerHTML = `
    <a href="#/grants">← All grants</a>
    <div class="row"><h1>${esc(g.title)}</h1><span class="pill s-${g.status}">${g.status}</span></div>
    <div class="card">
      <p><b>Funder:</b> ${esc(g.funders?.name || 'Not set')}${g.funders?.type ? ` (${esc(g.funders.type)})` : ''}</p>
      ${g.funders?.contact ? `<p><b>Contact:</b> ${esc(g.funders.contact)}</p>` : ''}
      <p><b>Awarded:</b> ${money(g.amount_awarded)} ${g.restricted ? '· <span class="tag">Restricted funds</span>' : '· Unrestricted'}</p>
      <p><b>Dates:</b> ${fmtDate(g.start_date)} → ${fmtDate(g.end_date)}${daysLeft(g)}</p>
      <p><b>Reports:</b> ${FREQS[g.report_frequency] || 'No set schedule'}</p>
      ${g.indirect_rate != null ? `<p><b>Indirect rate:</b> ${Number(g.indirect_rate)}%</p>` : ''}
      ${g.allowed_costs ? `<p><b>Allowed costs:</b> ${esc(g.allowed_costs)}</p>` : ''}
      ${g.notes ? `<p><b>Notes:</b> ${esc(g.notes)}</p>` : ''}
      ${edit ? `<div class="actions"><a class="btn ghost small" href="#/grant-edit/${g.id}">Edit grant</a></div>` : ''}
    </div>

    <h2>Budget left</h2>
    <div class="card">${meter(spent, approved, 'Whole grant')}</div>
    ${mismatch ? `<div class="alert">Budget lines add up to ${money(lineTotal)}, but the award is ${money(g.amount_awarded)}. Check the award letter.</div>` : ''}
    ${!lines.length ? '<div class="note">No budget lines yet. Add the lines from the award letter so you can see what\'s left on each one.</div>' : ''}
    ${lines.map((l) => `
      <div class="card">
        <div class="row"><h3>${esc(l.name)}${l.is_salary ? ' <span class="tag small">(salary)</span>' : ''}</h3>
          ${edit ? `<span class="actions">
            <button class="btn ghost small" data-edit-line="${l.id}">Edit</button>
            <button class="btn danger small" data-del-line="${l.id}">Delete</button></span>` : ''}</div>
        ${meter(spentByLine[l.id] || 0, Number(l.approved_amount), l.name)}
      </div>`).join('')}
    ${spentByLine.none ? `<div class="alert">${money(spentByLine.none)} in expenses isn't tagged to a budget line.</div>` : ''}

    ${edit ? `
    <form id="f-line" class="card">
      <h3 id="line-title">Add a budget line</h3>
      <input type="hidden" name="id">
      <label>Line name<input name="name" required maxlength="200" placeholder="e.g. Supplies, Program Director salary"></label>
      <label>Approved amount<input name="approved" required inputmode="decimal" placeholder="0.00"></label>
      <label class="check"><input type="checkbox" name="is_salary"> This is a salary line (hidden from Program staff)</label>
      <div class="actions"><button class="btn" type="submit">Save line</button>
        <button class="btn ghost" type="reset" id="line-cancel">Clear</button></div>
    </form>` : ''}

    <h2>Add an expense</h2>
    <form id="f-exp" class="card">
      <div class="two">
        <label>Date<input type="date" name="date" required value="${today()}"></label>
        <label>Amount<input name="amount" required inputmode="decimal" placeholder="0.00"></label>
      </div>
      <label>Vendor / paid to<input name="vendor" maxlength="200"></label>
      <label>Budget line
        <select name="line" ${lines.length ? 'required' : ''}>
          ${lines.length ? '<option value="">Choose a line…</option>' : '<option value="">(no budget lines yet)</option>'}
          ${lines.map((l) => `<option value="${l.id}">${esc(l.name)} — ${money(l.approved_amount - (spentByLine[l.id] || 0))} left</option>`).join('')}
        </select></label>
      <div id="exp-preview"></div>
      <label>Memo (optional)<input name="memo" maxlength="500"></label>
      <button class="btn" type="submit">Add expense</button>
    </form>

    <h2>Expenses (${expenses.length})</h2>
    <div class="card">
      ${expenses.length ? `<ul class="list">${expenses.map((x) => `
        <li><div class="row"><b>${money(x.amount)}</b><span>${fmtDate(x.date)}</span></div>
          <div>${esc(x.vendor || 'No vendor')} · ${esc(lineName[x.budget_line_id] || 'No line')}${x.source === 'csv' ? ' · imported' : ''}</div>
          ${x.memo ? `<div class="small">${esc(x.memo)}</div>` : ''}
          ${edit ? `<button class="btn danger small" data-del-exp="${x.id}">Delete</button>` : ''}
        </li>`).join('')}</ul>` : '<p>No expenses yet.</p>'}
    </div>
    ${isAdmin() ? '<button class="btn danger" id="del-grant">Delete this grant</button>' : ''}`;

  // live "after this expense" warning — catches a line going over before it happens
  const fExp = app.querySelector('#f-exp');
  const preview = () => {
    const d = formData(fExp);
    const amt = num(d.amount);
    const l = lines.find((x) => x.id === d.line);
    const box = app.querySelector('#exp-preview');
    if (!l || !Number.isFinite(amt)) { box.innerHTML = ''; return; }
    const after = (spentByLine[l.id] || 0) + amt;
    const pct = l.approved_amount > 0 ? (after / l.approved_amount) * 100 : 100;
    box.innerHTML = pct >= WARN_AT
      ? `<div class="alert">After this expense, "${esc(l.name)}" will be ${pct.toFixed(0)}% spent${pct > 100 ? ` — over by ${money(after - l.approved_amount)}` : ''}.</div>`
      : `<div class="note">After this expense: ${money(l.approved_amount - after)} left on "${esc(l.name)}".</div>`;
  };
  fExp.addEventListener('input', preview);
  fExp.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = formData(fExp);
    const amount = num(d.amount);
    if (!Number.isFinite(amount) || amount === 0) return toast('Enter an amount, like 125.50', true);
    const { error: e } = await sb.from('expenses').insert({
      org_id: state.org.id, grant_id: g.id, budget_line_id: d.line || null,
      date: d.date, vendor: d.vendor.trim() || null, amount, memo: d.memo.trim() || null, source: 'manual',
    });
    if (e) return toast(friendlyError(e), true);
    toast('Expense added');
    viewGrant(id);
  };

  if (edit) {
    const fLine = app.querySelector('#f-line');
    fLine.onsubmit = async (ev) => {
      ev.preventDefault();
      const d = formData(fLine);
      const approvedAmt = num(d.approved);
      if (!Number.isFinite(approvedAmt) || approvedAmt < 0) return toast('Enter the approved amount, like 5000', true);
      const row = { name: d.name.trim(), approved_amount: approvedAmt, is_salary: !!d.is_salary };
      const { error: e } = d.id
        ? await sb.from('budget_lines').update(row).eq('id', d.id)
        : await sb.from('budget_lines').insert({ ...row, org_id: state.org.id, grant_id: g.id });
      if (e) return toast(friendlyError(e), true);
      toast('Budget line saved');
      viewGrant(id);
    };
    fLine.addEventListener('reset', () => { app.querySelector('#line-title').textContent = 'Add a budget line'; fLine.elements.id.value = ''; });
    app.querySelectorAll('[data-edit-line]').forEach((b) => b.onclick = () => {
      const l = lines.find((x) => x.id === b.dataset.editLine);
      fLine.elements.id.value = l.id;
      fLine.elements.name.value = l.name;
      fLine.elements.approved.value = l.approved_amount;
      fLine.elements.is_salary.checked = l.is_salary;
      app.querySelector('#line-title').textContent = `Edit "${l.name}"`;
      fLine.scrollIntoView({ behavior: 'smooth' });
    });
    app.querySelectorAll('[data-del-line]').forEach((b) => b.onclick = () => confirmTap(b, async () => {
      const { error: e } = await sb.from('budget_lines').delete().eq('id', b.dataset.delLine);
      if (e) return toast(friendlyError(e), true);
      toast('Budget line deleted'); viewGrant(id);
    }));
    app.querySelectorAll('[data-del-exp]').forEach((b) => b.onclick = () => confirmTap(b, async () => {
      const { error: e } = await sb.from('expenses').delete().eq('id', b.dataset.delExp);
      if (e) return toast(friendlyError(e), true);
      toast('Expense deleted'); viewGrant(id);
    }));
  }
  const delGrant = app.querySelector('#del-grant');
  if (delGrant) delGrant.onclick = () => confirmTap(delGrant, async () => {
    const { error: e } = await sb.from('grants').delete().eq('id', g.id);
    if (e) return toast(friendlyError(e), true);
    toast('Grant deleted'); location.hash = '#/grants';
  }, 'Tap again to delete the grant, its lines and expenses');
}

// Tap once to arm, tap again within 4 seconds to confirm (no pop-up dialogs).
function confirmTap(btn, action, text = 'Tap again to confirm') {
  if (btn.dataset.armed) { action(); return; }
  btn.dataset.armed = '1';
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 4000);
}

// ---------- views: create / edit grant ----------
async function viewGrantForm(id) {
  if (!canEdit()) { app.innerHTML = '<div class="alert">Your role can\'t edit grants.</div>'; return; }
  app.innerHTML = '<p class="loading">Loading…</p>';
  const [funders, grantRes] = await Promise.all([
    fetchAll(() => sb.from('funders').select('id, name').eq('org_id', state.org.id).order('name')),
    id ? sb.from('grants').select('*').eq('id', id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (grantRes.error) throw grantRes.error;
  const g = grantRes.data || { status: 'active', restricted: true, report_frequency: 'quarterly' };

  app.innerHTML = `
    <a href="${id ? `#/grant/${id}` : '#/grants'}">← Back</a>
    <h1>${id ? 'Edit grant' : 'New grant'}</h1>
    <form id="f" class="card">
      <label>Grant title<input name="title" required maxlength="200" value="${esc(g.title)}" placeholder="e.g. 2027 Youth Literacy Program"></label>
      <label>Funder
        <select name="funder_id">
          <option value="">— None —</option>
          ${funders.map((f) => `<option value="${f.id}" ${f.id === g.funder_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
          <option value="__new">+ Add a new funder…</option>
        </select></label>
      <div id="new-funder" hidden class="two">
        <label>New funder name<input name="funder_name" maxlength="200"></label>
        <label>Funder type<select name="funder_type">${FUNDER_TYPES.map((t) => `<option>${t}</option>`).join('')}</select></label>
        <label>Contact (optional)<input name="funder_contact" maxlength="300" placeholder="Name, email, phone"></label>
      </div>
      <div class="two">
        <label>Amount awarded<input name="amount" required inputmode="decimal" value="${g.amount_awarded ?? ''}" placeholder="0.00"></label>
        <label>Status<select name="status">${STATUSES.map((s) => `<option ${s === g.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>Start date<input type="date" name="start_date" value="${esc(g.start_date)}"></label>
        <label>End date<input type="date" name="end_date" value="${esc(g.end_date)}"></label>
      </div>
      <label class="check"><input type="checkbox" name="restricted" ${g.restricted ? 'checked' : ''}> Restricted funds (can only be spent as the funder allows)</label>
      <label>Reporting schedule<select name="report_frequency">
        ${Object.entries(FREQS).map(([k, v]) => `<option value="${k}" ${k === g.report_frequency ? 'selected' : ''}>${v}</option>`).join('')}
      </select></label>
      <label>Indirect rate % (optional)<input name="indirect_rate" inputmode="decimal" value="${g.indirect_rate ?? ''}" placeholder="Federal de minimis is up to 15"></label>
      <label>Allowed costs (from the award letter)<textarea name="allowed_costs" rows="3" maxlength="2000">${esc(g.allowed_costs)}</textarea></label>
      <label>Notes (contacts, terms, history — helps whoever takes over)<textarea name="notes" rows="4" maxlength="5000">${esc(g.notes)}</textarea></label>
      <button class="btn" type="submit">${id ? 'Save changes' : 'Create grant'}</button>
    </form>`;

  const f = app.querySelector('#f');
  const newBox = app.querySelector('#new-funder');
  f.elements.funder_id.onchange = () => { newBox.hidden = f.elements.funder_id.value !== '__new'; };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = formData(f);
    const amount = num(d.amount);
    if (!Number.isFinite(amount) || amount < 0) return toast('Enter the amount awarded, like 25000', true);
    const rate = d.indirect_rate.trim() === '' ? null : num(d.indirect_rate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) return toast('Indirect rate must be between 0 and 100', true);
    if (d.start_date && d.end_date && d.end_date < d.start_date) return toast('End date is before start date', true);

    let funderId = d.funder_id || null;
    if (funderId === '__new') {
      if (!d.funder_name.trim()) return toast('Type the new funder\'s name', true);
      const { data: fn, error: fe } = await sb.from('funders')
        .insert({ org_id: state.org.id, name: d.funder_name.trim(), type: d.funder_type, contact: d.funder_contact.trim() || null })
        .select('id').single();
      if (fe) return toast(friendlyError(fe), true);
      funderId = fn.id;
    }
    const row = {
      title: d.title.trim(), funder_id: funderId, amount_awarded: amount, status: d.status,
      start_date: d.start_date || null, end_date: d.end_date || null, restricted: !!d.restricted,
      report_frequency: d.report_frequency, indirect_rate: rate,
      allowed_costs: d.allowed_costs.trim() || null, notes: d.notes.trim() || null,
    };
    const res = id
      ? await sb.from('grants').update(row).eq('id', id).select('id').single()
      : await sb.from('grants').insert({ ...row, org_id: state.org.id, owner_member_id: state.member.id }).select('id').single();
    if (res.error) return toast(friendlyError(res.error), true);
    toast(id ? 'Grant saved' : 'Grant created — now add its budget lines');
    location.hash = `#/grant/${res.data.id}`;
  };
}

// ---------- views: settings ----------
async function viewSettings() {
  app.innerHTML = '<p class="loading">Loading…</p>';
  const [{ data: factors, error }, team] = await Promise.all([
    sb.auth.mfa.listFactors(),
    fetchAll(() => sb.from('members').select('id, email, role').eq('org_id', state.org.id).order('created_at')),
  ]);
  if (error) throw error;
  const verified = factors.totp.filter((f) => f.status === 'verified');
  const o = state.org;

  app.innerHTML = `
    <h1>Settings</h1>
    <div class="card">
      <p><b>Signed in as:</b> ${esc(state.session.user.email)}</p>
      <p><b>Your role:</b> ${esc(state.member.role)}</p>
      <button class="btn ghost" id="out">Sign out</button>
    </div>

    <h2>Organization</h2>
    <form id="f-org" class="card">
      <label>Name<input name="name" required value="${esc(o.name)}" ${isAdmin() ? '' : 'disabled'}></label>
      <label>EIN<input name="ein" value="${esc(o.ein)}" ${isAdmin() ? '' : 'disabled'}></label>
      <label>Fiscal year starts in<select name="fy" ${isAdmin() ? '' : 'disabled'}>${monthOptions(o.fiscal_year_start)}</select></label>
      <p><b>Plan:</b> ${esc(o.plan)}</p>
      ${isAdmin() ? '<button class="btn" type="submit">Save organization</button>' : ''}
    </form>

    <h2>Team (${team.length})</h2>
    <div class="card"><ul class="list">${team.map((m) => `<li><b>${esc(m.email || 'Member')}</b> — ${esc(m.role)}</li>`).join('')}</ul>
      <p class="small">Inviting teammates comes in a later update.</p></div>

    <h2>Two-step sign-in</h2>
    <div class="card" id="mfa">
      ${verified.length
        ? `<p>✅ On. You'll be asked for a code from your authenticator app when you sign in.</p>
           ${verified.map((f) => `<button class="btn danger small" data-unenroll="${f.id}">Turn off (${esc(f.friendly_name || 'app')})</button>`).join('')}`
        : `<p>Adds a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy) at sign-in.
           Federal grant rules call for multi-factor login, so this is recommended.</p>
           <button class="btn" id="mfa-start">Turn on two-step sign-in</button>`}
    </div>`;

  app.querySelector('#out').onclick = async () => { await sb.auth.signOut(); location.hash = ''; };
  const fOrg = app.querySelector('#f-org');
  fOrg.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!isAdmin()) return;
    const d = formData(fOrg);
    const { data, error: e } = await sb.from('organizations')
      .update({ name: d.name.trim(), ein: d.ein.trim() || null, fiscal_year_start: Number(d.fy) })
      .eq('id', o.id).select().single();
    if (e) return toast(friendlyError(e), true);
    state.org = data;
    toast('Organization saved');
  };

  app.querySelectorAll('[data-unenroll]').forEach((b) => b.onclick = () => confirmTap(b, async () => {
    const { error: e } = await sb.auth.mfa.unenroll({ factorId: b.dataset.unenroll });
    if (e) return toast(e.message, true);
    toast('Two-step sign-in turned off'); viewSettings();
  }));

  const start = app.querySelector('#mfa-start');
  if (start) start.onclick = async () => {
    // clear out any half-finished setup first
    for (const f of factors.totp.filter((x) => x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error: e } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator ' + Date.now().toString().slice(-4) });
    if (e) return toast(e.message, true);
    const box = app.querySelector('#mfa');
    box.innerHTML = `
      <p><b>1.</b> In your authenticator app, add an account and scan this code
        (or type the setup key).</p>
      <img class="qr" src="${esc(data.totp.qr_code)}" alt="QR code for authenticator app">
      <p><b>Setup key:</b> <span class="mono">${esc(data.totp.secret)}</span></p>
      <form id="f-mfa">
        <label><b>2.</b> Type the 6-digit code it shows
          <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
        <button class="btn" type="submit">Finish turning on</button>
      </form>`;
    box.querySelector('#f-mfa').onsubmit = async (ev) => {
      ev.preventDefault();
      const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: formData(ev.target).code.trim() });
      if (e2) return toast(e2.message, true);
      toast('Two-step sign-in is on'); viewSettings();
    };
  };
}

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

if (!configured) {
  route();
} else {
  sb.auth.onAuthStateChange((event, session) => {
    const userChanged = (state.session?.user.id || null) !== (session?.user.id || null);
    state.session = session;
    if (userChanged) { state.loadedFor = null; state.member = null; state.org = null; }
    // Don't re-render on silent token refreshes (would wipe half-typed forms).
    if (event === 'TOKEN_REFRESHED' || (event === 'SIGNED_IN' && !userChanged)) return;
    if (event === 'MFA_CHALLENGE_VERIFIED') return; // the view that verified will re-render
    setTimeout(route, 0); // let Supabase finish before querying
  });
}
