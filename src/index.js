// GrantKeep Worker (Phase 4).
// - Serves the app files in ./public (Cloudflare does this before the Worker runs).
// - /cal/<code>.ics  → private calendar feed of an organization's deadlines.
// - Daily cron      → emails reminders 30, 14, 7 and 1 days before each deadline.
// - /api/run-reminders?key=<CRON_SECRET> → run the reminders now (for testing).
//
// Settings (Cloudflare > Workers > grant-tracker > Settings > Variables and Secrets):
//   SUPABASE_SERVICE_KEY  secret  Supabase > Project Settings > API keys > secret key
//   RESEND_API_KEY        secret  resend.com > API Keys
//   REMINDER_FROM         text    e.g. GrantKeep <reminders@yourdomain.com>
//   CRON_SECRET           secret  any long random text (only needed for the test link)

const STAGES = [30, 14, 7, 1];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cal = url.pathname.match(/^\/cal\/([a-f0-9]{36})\.ics$/);
    if (cal) return calendar(cal[1], env);
    if (url.pathname === '/api/run-reminders') {
      if (!env.CRON_SECRET || url.searchParams.get('key') !== env.CRON_SECRET) return new Response('Not allowed', { status: 403 });
      const result = await runReminders(env);
      return Response.json(result);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).then((r) => console.log('reminders', JSON.stringify(r))));
  },
};

// ---------- Supabase (server side, bypasses row-level security — keep the key secret) ----------
async function db(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const headers = { apikey: key, 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // older JWT-style keys
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ---------- calendar feed ----------
async function calendar(token, env) {
  try {
    const orgs = await db(env, `organizations?calendar_token=eq.${token}&select=id,name`);
    if (!orgs.length) return new Response('Calendar link not found. Get the current link in GrantKeep > Settings.', { status: 404 });
    const org = orgs[0];
    const rows = await db(env, `deadlines?org_id=eq.${org.id}&select=id,title,type,due_date,status,notes,grants(title)&order=due_date`);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GrantKeep//Deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${ics(`GrantKeep – ${org.name}`)}`, 'X-PUBLISHED-TTL:PT6H', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    ];
    for (const d of rows) {
      const day = d.due_date.replace(/-/g, '');
      const next = new Date(d.due_date + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
      const done = d.status === 'submitted';
      lines.push(
        'BEGIN:VEVENT', `UID:${d.id}@grantkeep`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`,
        `SUMMARY:${ics(`${done ? '✓ ' : ''}${d.grants?.title || 'Grant'}: ${d.title || d.type + ' deadline'}`)}`,
        `DESCRIPTION:${ics(`${done ? 'Submitted. ' : ''}${d.notes || ''}`.trim() || 'From GrantKeep')}`,
        'TRANSP:TRANSPARENT',
      );
      if (!done) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Grant deadline tomorrow', 'TRIGGER:-PT15H', 'END:VALARM');
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return new Response(lines.map(fold).join('\r\n') + '\r\n', {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=1800' },
    });
  } catch (e) {
    console.error(e);
    return new Response('Calendar is not available right now.', { status: 500 });
  }
}
const ics = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = (line) => {
  const out = [];
  let chars = [...line];
  while (chars.length > 70) { out.push(chars.slice(0, 70).join('')); chars = chars.slice(70); }
  out.push(chars.join(''));
  return out.join('\r\n ');
};

// ---------- reminder emails ----------
async function runReminders(env) {
  const today = new Date().toISOString().slice(0, 10);
  const last = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const deadlines = await db(env,
    `deadlines?status=eq.open&due_date=gte.${today}&due_date=lte.${last}` +
    '&select=id,org_id,title,type,due_date,reminders_sent,grant_id,grants(title,owner_member_id,status)&order=due_date');

  const due = [];
  for (const d of deadlines) {
    if (d.grants?.status === 'closed') continue;
    const days = Math.round((new Date(d.due_date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
    const sent = d.reminders_sent || [];
    const hit = STAGES.filter((s) => days <= s && !sent.includes(s));
    if (hit.length) due.push({ ...d, days, newSent: [...new Set([...sent, ...hit])] });
  }
  if (!due.length) return { today, checked: deadlines.length, emails: 0 };

  const orgIds = [...new Set(due.map((d) => d.org_id))];
  const members = await db(env, `members?org_id=in.(${orgIds.join(',')})&email_reminders=is.true&email=not.is.null&select=id,org_id,email,role`);

  // one email per person, listing every deadline that hit a reminder day today
  const inbox = new Map();
  for (const d of due) {
    for (const m of members) {
      if (m.org_id !== d.org_id) continue;
      if (!['admin', 'finance'].includes(m.role) && m.id !== d.grants?.owner_member_id) continue;
      if (!inbox.has(m.email)) inbox.set(m.email, []);
      inbox.get(m.email).push(d);
    }
  }

  const from = env.REMINDER_FROM || 'GrantKeep <onboarding@resend.dev>';
  const emails = [...inbox].map(([to, list]) => ({
    from, to: [to],
    subject: list.length === 1
      ? `Due in ${dayWord(list[0].days)}: ${list[0].grants?.title || 'Grant'} – ${list[0].title || 'deadline'}`
      : `${list.length} grant deadlines coming up`,
    html: emailHtml(list, env.APP_URL),
    text: list.map((d) => `${d.grants?.title}: ${d.title || d.type} — due ${d.due_date} (${dayWord(d.days)})`).join('\n') +
      `\n\nOpen GrantKeep: ${env.APP_URL}/#/deadlines\nTurn these emails off in GrantKeep > Settings.`,
  }));

  let sentCount = 0;
  for (let i = 0; i < emails.length; i += 100) {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(emails.slice(i, i + 100)),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`); // nothing marked → tries again tomorrow
    sentCount += emails.slice(i, i + 100).length;
  }

  for (const d of due) {
    await db(env, `deadlines?id=eq.${d.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ reminders_sent: d.newSent, reminder_sent_at: new Date().toISOString() }),
    });
  }
  return { today, checked: deadlines.length, reminders: due.length, emails: sentCount };
}

const dayWord = (n) => (n <= 0 ? 'today' : n === 1 ? '1 day' : `${n} days`);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function emailHtml(list, appUrl) {
  const rows = list.map((d) => `
    <tr><td style="padding:12px;border-bottom:2px solid #333">
      <div style="font-size:18px;font-weight:800;color:#ffd60a">${h(d.grants?.title || 'Grant')}</div>
      <div style="font-size:16px;color:#ffffff">${h(d.title || d.type + ' deadline')}</div>
      <div style="font-size:16px;font-weight:700;color:${d.days <= 7 ? '#ff5252' : '#ffffff'}">Due ${h(d.due_date)} · ${dayWord(d.days)}</div>
    </td></tr>`).join('');
  return `<div style="background:#0b0b10;padding:20px;font-family:Arial,sans-serif;color:#ffffff">
    <div style="font-size:22px;font-weight:900;color:#ffffff">Grant<span style="color:#ffd60a">Keep</span> reminder</div>
    <table style="width:100%;border-collapse:collapse;margin:14px 0">${rows}</table>
    <a href="${h(appUrl)}/#/deadlines" style="display:inline-block;background:#ffd60a;color:#000;font-weight:800;padding:12px 18px;border-radius:10px;text-decoration:none">Open deadlines</a>
    <p style="font-size:14px;color:#ffffff;margin-top:18px">Turn these emails off in GrantKeep &gt; Settings.</p></div>`;
}
