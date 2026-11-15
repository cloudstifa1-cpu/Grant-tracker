# Grant Tracker for Small Nonprofits — Research & Build Blueprint

Prepared November 15, 2026. Working name: **GrantKeep** (change it anytime).

---

## 1. The honest verdict first

The research changed the picture from the first pass. The cheap end of grant software is **more crowded than it looked**:

| Tool | What it's best at | Price (as checked in 2026) |
|---|---|---|
| Grantseeker (Fluxx) | Basic tracking | Free plan; Classic Premium $19.99/mo; Prospecting $51.99/mo |
| Grantable | AI writing + funder search | Free plan; $50/mo; $150/mo; 50% off first year for orgs under $500K |
| CharityIQ | Discovery + AI writing | Free finder; Starter $69/mo |
| GrantPipe | Grants + donor CRM | From $99/mo |
| Instrumentl | Funder search, full lifecycle | $299/mo and up (billed annually) |
| Foundant GrantHub | Was the small-org favorite (~$99/mo) | **Shut down January 31, 2026** |

**Finding grants** and **AI grant writing** are covered, and funded competitors are racing there (Instrumentl took a $55M growth investment). **Do not build those.**

**The real gap is after the grant is won**: budget left, report deadlines, reports in each funder's format, documents, and handoff when staff leave. That's where the pain numbers are worst, and the cheap tools are weakest.

---

## 2. What grant professionals need most (ranked by evidence)

Main source: Instrumentl's March 2026 survey of 1,031 grant professionals ("Beyond Shadow Work"). Note: it's a non-random sample, so treat the numbers as direction, not exact. Second source: GrantStation's 2026 State of Grantseeking.

**The big picture:**
- The typical grant pro spends **29.5 hours/week** on manual, repetitive work.
- **96%** rely on at least one workaround outside their official systems.
- **86%** use spreadsheets, and the average pro touches **5+ disconnected tools per grant**.
- **87%** walked away from, delayed, or shrank a grant because the process was too heavy. The median grant lost was worth about **$75,000**.
- **89%** had at least one operational incident in two years (a missed report deadline, a budget mismatch, an application error).

**Ranked needs → the feature each one points to:**

| # | Need (evidence) | Feature |
|---|---|---|
| 1 | Only **18%** can answer "do we have budget left for this expense?" within minutes. **61%** keep a personal spreadsheet for budgets. **54%** have low-to-moderate confidence in their financial tracking. | **Budget-left meter** per grant and per budget line |
| 2 | Top "magic wand" wish: **better tracking and deadline management (18%)**. Missed report deadlines are a top incident. | **Deadline engine** that catches every report, renewal, and draw date, with email reminders |
| 3 | Funders each want reports in their own format. Every report needs budget vs. actual plus a narrative. | **Report builder**: budget-vs-actual table + narrative draft in the funder's format |
| 4 | **68%** use email folders as the place they keep grant documents. | **Document vault** attached to each grant and funder |
| 5 | **55%** depend on knowledge held by one person; **57%** report disruption when a grant pro leaves; only **14%** have documented processes. | **Handoff mode**: every grant has its terms, contacts, notes, and history in one place |
| 6 | Wish #2: **better financial visibility (12%)**; wish #3: **cross-team collaboration (11%)** | Program staff see their grant's spending (no salaries); finance flags miscoded expenses |
| 7 | Restricted funds mixed with unrestricted can trigger repayment. | Restricted-fund tagging and warnings |

**Who you're selling to:** at small nonprofits, the Executive Director or Development Director usually runs the whole grants function alone. They have no IT staff and no time for setup, and most "grant management software" is built for funders giving money, not nonprofits receiving it.

---

## 3. The product (what to build)

**One sentence:** *"Know what's left, what's due, and what to send, for every grant, in two minutes."*

### Version 1 (the core — build this first, nothing else)
1. **Grants list**: funder, amount, dates, status (prospect → applied → awarded → active → closed), restricted yes/no.
2. **Award terms capture**: budget lines from the award letter, reporting schedule, allowed costs, indirect rate (e.g. federal de minimis up to 15%).
3. **Budget-left meter**: enter or import expenses, tag each one to a grant and budget line, and see remaining $ and % spent instantly, with a red warning before a line goes over.
4. **Deadline engine**: report due dates are created automatically from the award terms, with email reminders at 30/14/7/1 days, plus a calendar feed (.ics) for Google/Outlook.
5. **Expense import from CSV**: QuickBooks, Xero, and bank exports. Map columns once and remember the mapping.
6. **Report builder**: a budget-vs-actual table (Approved / Spent to Date / Remaining / % Spent) plus variance notes, exported to PDF, Word, and Excel.
7. **Document vault**: upload award letters, receipts, and past reports to each grant.
8. **Team**: unlimited users, roles (Admin, Finance, Program — program staff can't see salary lines).

### Version 2 (after paying customers ask for it)
- AI narrative draft for reports, pulled from your notes and outcome numbers
- Outcome/metrics tracking per grant (targets vs. actuals)
- Funder report templates library (save each funder's format once, reuse forever)
- Direct QuickBooks Online / Xero sync (see costs in section 6 — do this later)
- "Grant consultant" plan: one login, many client nonprofits

### Do NOT build
- Grant search databases (Instrumentl, Candid, GrantStation own this)
- Full AI proposal writing (Grantable gives it away free)
- Full accounting (stay a layer on top of their accounting, never replace it)

---

## 4. Data model (database tables)

```
organizations     id, name, ein, fiscal_year_start, plan
members           id, org_id, user_id, role (admin|finance|program)
funders           id, org_id, name, type (foundation|state|federal|corporate|local), contact, notes
grants            id, org_id, funder_id, title, amount_awarded, start_date, end_date,
                  status, restricted (bool), indirect_rate, owner_member_id
budget_lines      id, grant_id, name, approved_amount, is_salary (bool)
expenses          id, org_id, grant_id, budget_line_id, date, vendor, amount,
                  memo, source (manual|csv), receipt_doc_id
deadlines         id, grant_id, type (narrative|financial|renewal|draw|other),
                  due_date, status (open|submitted|late), reminder_sent_at
documents         id, org_id, grant_id, funder_id, file_path, kind, uploaded_by
report_exports    id, grant_id, period_start, period_end, file_path, created_at
csv_mappings      id, org_id, source_name, column_map (json)
activity_log      id, org_id, member_id, action, target, created_at   ← audit trail
```

Every table carries `org_id`, and database **row-level security** ensures an organization can only ever see its own rows.

---

## 5. Most efficient build: tech stack

Built for one person directing Claude Code, low cost, and easy to keep private.

| Piece | Choice | Why |
|---|---|---|
| Front end | Phone-first web app (PWA): React + Vite, or plain HTML/JS if you prefer | Works on phone and desktop, installs like an app, one codebase |
| Hosting | **Cloudflare** Workers/Pages | Free plan: 100,000 requests/day; Paid: $5/mo for 10M requests |
| Database + login + file storage | **Supabase** | Postgres + auth + storage + row-level security in one. Free: 500 MB database, pauses after 1 week idle (testing only). **Pro: $25/mo** for launch |
| Email reminders | **Resend** | Free: 3,000 emails/mo, 100/day; Pro $20/mo for 50,000 |
| Scheduled reminders | Cloudflare Cron Trigger (runs daily, checks deadlines, sends emails) | No extra service |
| Payments | **Stripe** Checkout + Billing | 2.9% + 30¢ per card charge, plus Billing 0.7% |
| AI (Version 2) | **Claude Haiku 5.5** via API | $0.10 per million input tokens / $0.50 per million output tokens (prompts under 100K) |
| PDF/Word/Excel export | Generated in the browser (e.g. jsPDF, docx, SheetJS) | No server cost |

### Monthly running cost at launch
- Supabase Pro $25 + Cloudflare $5 + Resend $0–20 + domain (~$1) ≈ **$31–51/month**
- **Break-even: 2 paying customers** at $29/mo.

### AI cost per report (Version 2)
A report draft is about 20,000 tokens in + 3,000 out on Haiku 5.5 ≈ **$0.0035** (a third of a cent). Even 1,000 reports/month ≈ $3.50.

---

## 6. Integrations — the smart order

1. **Start with CSV import** (free, works with every accounting system).
2. **Calendar feed (.ics)**: free, and it puts deadlines in Google/Outlook calendars.
3. **QuickBooks Online direct sync: later.** Intuit's App Partner Program (since July 2025) made the API no longer free: a free Builder tier with read limits, then paid tiers from about $300 up to $4,500/month plus usage fees. Only add it once revenue covers it.
4. Xero also charges partners by connected organizations and data. Same rule: later.

---

## 7. Security & trust (nonprofits will ask)

- Row-level security on every table (one org can't see another's data).
- Multi-factor login (Supabase auth supports it). The 2024 federal Uniform Guidance revision calls for cybersecurity measures like encryption and multi-factor authentication for federal fund recipients, so this is a selling point.
- Encrypted storage for documents; signed, expiring links for downloads.
- Activity log (who changed what, when): auditors love it.
- **One-click full export** (CSV + all files in a zip). GrantHub users got stranded; promise "your data is always yours."
- Daily backups (Supabase Pro). Keep the code repo **private** on GitHub.
- Don't claim SOC 2 until you have it. Supabase's SOC 2 is on its $599/mo Team plan — not needed at start.

### Federal grant facts to build in (2024 Uniform Guidance, 2 CFR 200)
- Single Audit threshold raised from $750,000 to **$1,000,000** in federal spending per year → the app can warn when an org is close.
- Equipment threshold raised from $5,000 to **$10,000**.
- De minimis indirect rate raised from 10% to **up to 15%** of modified total direct costs.

---

## 8. Pricing plan

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | 1 active grant, 1 user: enough to fall in love |
| Small Org | **$29/mo** or $290/yr | Unlimited grants, unlimited users, reminders, reports, vault |
| Consultant | $79/mo | Up to 10 client orgs from one login |

Reasoning: under Grantable's $50 and far under Instrumentl's $299, and unlimited users beats per-seat tools. Grantseeker's $19.99 is cheaper, but it's a general tracker; you win on budget-left and reports. Offer a nonprofit-friendly annual price (2 months free).

Stripe cost on a $29 charge ≈ $1.14 card fee + $0.20 Billing ≈ **$1.34**.

---

## 9. Build phases (with Claude Code)

Each phase is a separate Claude Code session. Push to a **private** GitHub repo and set the branch to main for deploys.

**Phase 1 — Foundation (database + login)**
Prompt idea: *"Create a Supabase schema for the tables in section 4 of this blueprint with row-level security by org_id, plus email + magic-link login and multi-factor auth. Phone-first PWA shell with bright, high-contrast text."*

**Phase 2 — Grants, budget lines, expenses, budget-left meter**
*"Build grant create/edit, budget lines, manual expense entry, and a budget-left meter per grant and per line with red warnings at 90% and 100%."*

**Phase 3 — CSV import with saved column mapping**
*"Add CSV import for expenses with a column-mapping screen that is saved per source (QuickBooks, Xero, bank)."*

**Phase 4 — Deadline engine + email reminders + calendar feed**
*"Generate deadlines from each grant's reporting schedule, send Resend emails at 30/14/7/1 days via a daily Cloudflare cron, and provide a private .ics calendar feed."*

**Phase 5 — Report builder + exports**
*"Budget-vs-actual report for any date range with variance notes; export PDF, Word, Excel."*

**Phase 6 — Documents, roles, activity log, full export**

**Phase 7 — Stripe billing + free plan limits + landing page**

**Phase 8 (Version 2) — AI narrative drafts with Claude Haiku 5.5, funder templates, outcomes**

Test on your phone after every phase. Don't start the next phase until the last one works.

---

## 10. Getting customers (built so others can operate it)

You build; partners sell and support. Channels found in research:
- **GrantHub refugees.** Thousands of small nonprofits were left without a home on January 31, 2026, and many already kept a spreadsheet on the side. Make a "Moving from GrantHub? Import your spreadsheet in 5 minutes" page.
- **Grant consultants.** They manage many clients and recommend tools to them. The Consultant plan plus a referral cut (e.g. 20%) turns them into your sales team.
- **TechSoup.** The main channel nonprofits use for discounted tech; it also offers nonprofit validation tools (some zero-cost) to confirm customers are real nonprofits.
- **State nonprofit associations.** Member-discount listings.
- **Free spreadsheet bait.** People pay $3–$20 for grant tracker spreadsheets on Gumroad, which proves interest. Give a free one that says "outgrew this? import it into GrantKeep."
- A partner or contractor can handle demos and support emails. The app should be self-serve enough to need almost none.

---

## 11. Risks (pushback, honestly)

1. **Competitors can copy this.** Instrumentl already added budget versioning and lets program staff see grant spending, but at $299+/mo. Your moat is price, simplicity, and focus on orgs under $2M budgets.
2. **Small nonprofits are price-sensitive.** In the AI tools market, many expect free. Keep the free plan real.
3. **Trust.** It's financial data. Security, export, and backups must be solid from day one.
4. **Support load.** CSV imports are where users get stuck. Make the mapping screen excellent and add sample files.
5. **Validate before Phase 5.** Put up a landing page with a waitlist after Phase 2. If fewer than ~40–50 signups come from ~1,000 targeted visitors, rethink before building further. (That's a common rule of thumb from SaaS validation guides, not a law.)

---

## 12. Sources

- Instrumentl, "Beyond Shadow Work: 1,000+ Grant Professionals…" (March 31, 2026) — instrumentl.com/blog/beyond-shadow-work-1000-grant-professionals-on-the-work-that-matters-most-and-the-systems-holding-them-back
- GrantStation, 2026 State of Grantseeking Report — grantstation.com
- GrantHub shutdown: Toolradar (toolradar.com/tools/granthub); getgrantwise.ca GrantHub alternatives guide; business-software.com grant management guide; grantsights.com
- Competitor pricing: grantsights.com Grantseeker review (Nov 6, 2026); grantable.co pricing pages; charityiq.us; grantpipe-site.pages.dev; sagnikbhattacharya.com tool comparison
- Small nonprofit software gap: grantpipe-site.pages.dev "Best Grant Management Software for Small Nonprofits"; beancount.io grant software guide (Sept 2026)
- Supabase pricing: toolradar.com/tools/supabase/pricing (verified Nov 2026); schematichq.com
- Cloudflare Workers pricing: developers.cloudflare.com/workers/platform/pricing
- Resend pricing: automationatlas.io/answers/resend-free-tier-explained-2026; costbench.com
- Stripe pricing: stripe.com/pricing; checkoutpage.com/blog/stripe-processing-fees
- Claude Haiku 5.5 pricing: platform.claude.com/docs/en/about-claude/pricing; apidog.com/blog/claude-haiku-5-5-pricing
- QuickBooks API fees: apideck.com/blog/quickbooks-api-pricing-and-the-intuit-app-partner-program; supergood.ai
- Uniform Guidance 2024: ohioauditor.gov bulletin 2024-006; nonprofitaccountingbasics.org; EPA grants page
- TechSoup partner validation: page.techsoup.org/validation-services
- Gumroad grant spreadsheets: giantsquidgroup.gumroad.com, remathegreat.gumroad.com
