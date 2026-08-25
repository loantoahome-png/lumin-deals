# Runbook — Add a user (and restrict them to the Processing Desk)

Logins are Supabase Auth (email + password). There is no self-signup — accounts
are created by hand in the Supabase dashboard. This runbook covers both a normal
teammate and a restricted processor account.

Written 2026-08-10 for adding **Hanh Nguyen**.

---

## Before you start

Hanh's work email is **`hnguyen@lucentmg.com`** (Efrain, 2026-08-10). Note the
domain — it is *not* `@luminlending.com` like Brianne's. Everything below keys
off this address.

## 1. Create the account

1. Supabase dashboard → the **lumin-deals** project → **Authentication** → **Users**.
2. **Add user** → **Create new user**.
3. Email: `hnguyen@lucentmg.com`.
4. Password: type one. Use a generated password, not a memorable one — she can
   change it later from the app's **Forgot password** link.
5. Tick **Auto Confirm User**. Without it she can't sign in until she clicks a
   confirmation email, and confirmation email delivery depends on SMTP being
   configured on the project.
6. **Create user**.

## 2. Make it a *processor* account (this is the restriction step)

By default a new account is an **admin** and sees the entire app — including
Lead ROI, lead spend, and compensation. That is deliberate (every existing
teammate account has empty metadata and must keep working), which means an
account you forget to restrict is a wide-open one. Do this step immediately.

**⚠️ There is no dashboard field for this.** Older Supabase dashboards had an
editable *Raw App Meta Data* box on the user panel; current ones don't. The
`Raw JSON` tab beside `Overview` will *show* `app_metadata`, but read-only. That
is not an oversight — `app_metadata` is writable only with the service-role key,
which is exactly why the role lives there and not in `user_metadata` (that one
IS writable from a signed-in browser, so a restricted account could promote
itself).

Use the script:

```bash
npx tsx scripts/set-user-role.ts hnguyen@lucentmg.com processor "Hanh Nguyen"
```

Run it with no role first to see the current state without changing anything:

```bash
npx tsx scripts/set-user-role.ts hnguyen@lucentmg.com
```

To lift the restriction later, `... admin` — which *removes* the `role` key,
since absence of the key is what means admin.

The script **merges** into `app_metadata` rather than replacing it. That matters:
the block also holds `provider` / `providers`, which Supabase uses for sign-in.
Overwrite those and the account can't log in.

`display_name` must match the **Processor** value on her deals *exactly* —
`Hanh Nguyen`. It's what pins her desk to her own files and what gets stamped on
tasks she creates. A typo here shows her an empty desk.

Have her sign out and back in if she was already signed in — the role is read
from the session, so one issued before the change still carries the old (admin)
value until it refreshes.

**Status: done for Hanh, 2026-08-10.** `app_metadata` is now
`{"display_name":"Hanh Nguyen","provider":"email","providers":["email"],"role":"processor"}`.
Efrain, Brianne, Moe, Matt and Randy verified still admin.

## 3. Task emails — already done

`PROCESSOR_EMAIL_HANH = hnguyen@lucentmg.com` was set on Production 2026-08-10
and deployed. Nothing to do here unless her address changes, in which case:
Vercel → lumin-deals → Settings → Environment Variables → Production, then
redeploy (env vars are baked in at build time — editing the value alone does
nothing until the next deploy).

There is intentionally no hard-coded fallback address in
`app/api/tasks/notify/route.ts` (guessing one would mail a stranger). If the
variable ever goes missing, tasks assigned to her still appear on her desk and
on `/tasks` — she just stops getting the email, silently.

## 4. Verify — takes two minutes, do it

Sign in as her (or have her share her screen):

| Check | Expected |
|---|---|
| Lands on | `/processing`, showing her active escrows |
| Sidebar | **Processing** and **Bulletin/Tasks** only — no Dashboard, Lead ROI, Funded, Reports, Import |
| Visit `/lead-roi` directly | Bounces to `/processing` |
| Visit `/` directly | Bounces to `/processing` |
| Open a file from her desk | Deal page and checklist both open, fields editable |
| Create a task assigned to Brianne | Appears in Brianne's column on `/tasks`, "by Hanh Nguyen" |

If she sees the full sidebar, `app_metadata` didn't save or she's on a stale
session — recheck step 2 and have her sign out and in.

---

## Adding a normal (admin) teammate

Step 1 only. Skip step 2 entirely — no `role` key means full access, same as
Efrain, Brianne, Moe and Matt today. Optionally give them a display name so it's
stamped on tasks they create instead of being derived from their email:

```bash
npx tsx scripts/set-user-role.ts someone@luminlending.com admin "Their Name"
```

## Adding a reporting-only loan officer

Written 2026-08-25 for **Daniel McGrail-Granger**. This is the `reporting` role:
an LO who sees three report pages and nothing else. He sees the **whole
team's** figures on them — Efrain's explicit decision, so there is no per-LO data
lock. What's withheld is every other part of the app.

| Reaches | Blocked |
|---|---|
| `/reports` | `/reports/escrows` (operational, deliberately denied) |
| `/monthly-reports` | `/`, `/deals`, `/contacts`, `/pipeline`, `/funded` |
| `/lead-roi` (+ `/lead-roi/report`) | `/calls`, `/report-import`, `/import/*` |
| | `/lead-cohorts` (see below) |
| | `/tasks`, the Bulletin, `/tools`, `/processing` |

### 1. Wire his GHL sub-account (do this BEFORE the login exists)

Vercel → lumin-deals → Settings → Environment Variables → **Production**:

| Variable | Value |
|---|---|
| `GHL_API_KEY_3` | his sub-account's private integration token (`pit-…`) |
| `GHL_LOCATION_ID_3` | his GHL location id |
| `NEXT_PUBLIC_GHL_LOCATION_ID_3` | same location id (used for the contact-page GHL label) |
| `LO_EMAIL_DANIEL` | his work email (lock-expiry alerts) |

Then **redeploy** — env vars are baked in at build time. `getAccounts()` is
guarded on both `GHL_API_KEY_3` and `GHL_LOCATION_ID_3`, so until both exist the
fourth slot simply doesn't exist and nothing else changes. That inertness is why
the code can ship ahead of the credentials; it is also what made the first Randy
attempt look like a bug when it wasn't.

Confirm with one manual `POST /api/sync/ghl` and check the response's per-account
counts before trusting the 15-min cron.

### 2. Create the login and restrict it — in the same sitting

Create the user exactly as in step 1 at the top of this file, then immediately:

```bash
npx tsx scripts/set-user-role.ts daniel@... reporting "Daniel McGrail-Granger"
```

**⚠️ A brand-new account is an ADMIN until this runs.** No `role` key means full
access — Lead ROI, comp, every LO's numbers. Do not send him the password until
`set-user-role.ts <email>` (no role argument) reads back
`reporting (restricted — report pages only)`.

### 3. Verify

| Check | Expected |
|---|---|
| Lands on | `/reports` |
| Sidebar | Reports, Monthly Reports, Lead ROI — nothing else |
| Visit `/` | Bounces to `/reports` |
| Visit `/reports/escrows` | Bounces to `/reports` |
| Visit `/lead-roi` | Opens |
| His LO pill | Appears on the report filters in sky blue |

### What he is deliberately NOT part of

Same posture as Randy: his leads are **opt-in for viewing** but never enter the
Moe+Matt working set. He is not on the hot-leads triage clock, not in the
follow-up queue, not auto-tasked by the 2nd-callback cron, and excluded from
`/calls`. `DEFAULT_LOS` stays `['Matt Park', 'Moe Sefati']`.

### Why `/lead-cohorts` is excluded

Removed 2026-08-25 at Efrain's call. His GHL sub-account is not on the real-time
stage webhook, so that page would report his response rates as a flat **0.0%** —
wrong data, not missing data, which is worse than not having the page. To grant
it later: run `/api/stage-events/backfill` for his location per date range, put
`'/lead-cohorts'` back in `REPORTING_ALLOWED`, and flip the corresponding
assertion in `scripts/roles-check.ts`.

## Adding another processor later

Same as above with their own `display_name`, which must match a value in
`PROCESSORS` (`lib/types.ts`) — currently `Self Processing`, `Susan Lim`,
`Hanh Nguyen`, `Jessica Ching`. The Processing Desk supports all of them with no
code change; a name outside that list gets an empty desk.

## What this does NOT do

The restriction is a **routing** gate (`middleware.ts` + `lib/roles.ts`) — for
BOTH the `processor` and the `reporting` role. Row level security on `deals` is
unchanged, so a restricted account still holds a Supabase anon key that could
query other rows directly if someone went looking
with the browser console. That's the same trust boundary every teammate account
already operates under — it is not a defense against a determined insider. If
that matters, the fix is per-role RLS policies on `deals`, which is a separate
piece of work.

## Removing access

Supabase → Authentication → Users → the user → **Delete user**. Their tasks and
any `done_by` / `assigned_by` stamps stay (they're plain text on the rows), which
is what you want for the record.
