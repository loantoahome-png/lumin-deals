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

1. Still in **Authentication → Users**, click the new user.
2. Find **Raw App Meta Data** — the `app_metadata` block. **Not** *Raw User Meta
   Data*; user metadata is rewritable by the browser and the app ignores it for
   permissions on purpose.
3. It will contain something like `{"provider":"email","providers":["email"]}`.
   Add the two keys, keeping whatever's already there:

```json
{
  "provider": "email",
  "providers": ["email"],
  "role": "processor",
  "display_name": "Hanh Nguyen"
}
```

4. Save.

`display_name` must match the **Processor** value on her deals *exactly* —
`Hanh Nguyen`. It's what pins her desk to her own files and what gets stamped on
tasks she creates. A typo here shows her an empty desk.

Have her sign out and back in if she was already signed in — `app_metadata` is
read from the session, so a session issued before the change still carries the
old (admin) value until it refreshes.

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

Steps 1 only. Skip step 2 entirely — no `role` key means full access, same as
Efrain, Brianne, Moe and Matt today. Optionally set `display_name` so their name
is stamped on tasks they create instead of being derived from their email.

## Adding another processor later

Same as above with their own `display_name`, which must match a value in
`PROCESSORS` (`lib/types.ts`) — currently `Self Processing`, `Susan Lim`,
`Hanh Nguyen`, `Jessica Ching`. The Processing Desk supports all of them with no
code change; a name outside that list gets an empty desk.

## What this does NOT do

The restriction is a **routing** gate (`middleware.ts` + `lib/roles.ts`). Row
level security on `deals` is unchanged, so a restricted account still holds a
Supabase anon key that could query other rows directly if someone went looking
with the browser console. That's the same trust boundary every teammate account
already operates under — it is not a defense against a determined insider. If
that matters, the fix is per-role RLS policies on `deals`, which is a separate
piece of work.

## Removing access

Supabase → Authentication → Users → the user → **Delete user**. Their tasks and
any `done_by` / `assigned_by` stamps stay (they're plain text on the rows), which
is what you want for the record.
