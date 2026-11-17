# GrantKeep (grant-tracker)

*Know what's left, what's due, and what to send, for every grant, in two minutes.*

A phone-first web app (PWA) for small nonprofits that tracks grants **after they're won**:
budget left, deadlines, reports, documents, and handoff.

## What's built so far

| Phase | What | Status |
|---|---|---|
| 1 | Database (all tables, row-level security by org), email sign-in link / code, two-step sign-in (authenticator app), organization setup | ✅ Done |
| 2 | Grants list, grant create/edit, funders, budget lines, expenses, **budget-left meter** (red warnings at 90% and 100%, plus a warning *before* an expense pushes a line over) | ✅ Done |
| 3 | CSV expense import: column-matching screen saved per source (QuickBooks, Xero, bank), duplicate check, sample file | ✅ Done |
| 4 | Deadline engine (report due dates made from each grant's schedule), Deadlines tab, email reminders at 30/14/7/1 days (Resend, daily Cloudflare cron), private calendar link (.ics) | ✅ Done |
| 5 | Report builder + PDF/Word/Excel export | Next |
| 6 | Documents, team invites, activity log screen, full export | |
| 7 | Stripe billing, free plan limits, landing page | |

**Roles:** Admin (everything), Finance (grants and money), Program (read-only, can add
non-salary expenses, **can't see salary lines**). These rules are enforced inside the
database, not just hidden in the app.

## Files

```
public/            the app (plain HTML/JS, no build step)
  index.html       page shell
  app.js           all screens
  import.js        CSV expense import (Phase 3)
  deadlines.js     deadlines, reminder + calendar settings (Phase 4)
  samples/         sample CSV file for testing imports
  styles.css       bright, high-contrast styles
  config.js        ← paste your Supabase URL + anon key here
  sw.js            lets it install like an app
supabase/schema.sql  the whole database + security rules
supabase/phase4.sql  Phase 4 database additions (run once after schema.sql)
src/index.js       Worker: calendar feed + daily reminder emails
wrangler.jsonc     Cloudflare settings
```

## Setup (one time)

### 1. Supabase (database + sign-in)
1. Go to supabase.com → **New project**. Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, tap **Run**.
3. **Project Settings → API**: copy the **Project URL** and the **anon public** key into
   `public/config.js`. (Never use the `service_role` key in the app.)
4. **Authentication → URL Configuration**: set **Site URL** to your Cloudflare app address
   (from step 2 below), and add it under **Redirect URLs** too.
5. **Authentication → Email Templates → Magic Link**: add this line so the email also
   shows a 6-digit code (handy when the link opens in the wrong browser on a phone):
   `Your code: {{ .Token }}`
6. Free plan is fine for testing (it pauses after a week idle). Switch to Pro ($25/mo)
   before real customers.

### 2. Cloudflare (hosting)
1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository**.
2. Pick **grant-tracker**, set the branch to **main**. Leave the build command empty;
   the deploy command is `npx wrangler deploy`.
3. Every push to main redeploys automatically.

### 3. Test on your phone
Open the app address, sign in with your email, create your organization, add a grant,
add budget lines, add expenses, and watch the meters.

## Security notes
- Row-level security on every table: one organization can never see another's rows
  (tested: cross-org reads and writes are blocked).
- Users can't change their own plan, fake the activity log, or attach expenses to another
  org's grant.
- Activity log records every add/change/delete on grants, lines, expenses, funders, members.
- Keep this repo **private**.

## Phase 4 setup (reminder emails + calendar)

1. Supabase > SQL Editor > New query: paste `supabase/phase4.sql` > Run.
2. Cloudflare > Workers > grant-tracker > Settings > Variables and Secrets > Add:
   - `SUPABASE_SERVICE_KEY` (Secret): Supabase > Project Settings > API Keys > secret key
   - `RESEND_API_KEY` (Secret): resend.com > API Keys
   - `REMINDER_FROM` (Text): `GrantKeep <reminders@your-verified-domain>`
   - `CRON_SECRET` (Secret, optional): any long random text, to test with
     `/api/run-reminders?key=YOUR_CRON_SECRET`
3. Reminders run every day at 13:00 UTC (7 AM Central).

Until a domain is verified in Resend, emails only go to the email address on your Resend account.
