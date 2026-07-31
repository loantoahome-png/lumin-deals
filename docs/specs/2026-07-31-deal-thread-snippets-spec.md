# Spec — Deal-page conversation: real GHL snippets + from-number picker

**Date:** 2026-07-31
**Status:** scoped, not started
**Origin:** Efrain, after noticing the GHL button takes a while to load — "scope the
conversation thread on the deal page, are able to also bring over the text snippets?
And choose which number we are sending the message from?"

---

## 0. Correction to the premise

**The thread is already on the deal page, and so is the from-number picker.** I told
Efrain this would be a "real feature, not a tweak" — that was wrong, and it changes
the size of the job. What exists today, verified in the code and against the live GHL
API on 2026-07-31:

| Piece | Where | State |
|---|---|---|
| Inline thread (texts, calls, emails) | `components/ConversationThread.tsx`, mounted at `app/deals/[id]/page.tsx:881` under "Text Conversation (GHL)" | **Live.** Renders whenever the deal has a `ghl_contact_id`. |
| Thread fetch | `app/api/ghl/thread/route.ts` — `/conversations/search` → messages, Version `2021-04-15` | **Live.** |
| Reply composer + send | `app/api/ghl/send-message/route.ts` → `POST /conversations/messages` | **Live**, with a server-side Do-Not-Contact guard that re-checks `dnd`/`dnd_settings` before sending. |
| From-number picker | `app/api/ghl/numbers/route.ts` → `/phone-system/numbers` | **Live.** Returns real numbers (see §2). |
| Snippets | 3 strings **hardcoded** in `ConversationThread.tsx:27` | **This is the actual gap.** |

So the ask is two upgrades to a working feature, not a build.

---

## 1. Snippets — YES, the API exposes them (22 per sub-account)

**Endpoint:** `GET /locations/{locationId}/templates?type=sms&limit=200`
Version header `2021-07-28`, scope `locations/templates.readonly`.

**Verified live 2026-07-31** with our existing keys — this is real data, not the docs:

| Sub-account | SMS snippets | With `{{merge fields}}` | Email templates |
|---|---|---|---|
| Moe (`PKEBK2NX…`) | **22** | 14 | 2 |
| Matt (`84fCsPjM…`) | **22** | 13 | 2 |

Real names returned: `**Quick Quote Text`, `App Follow Up`, `Application Link`,
`Borrower's Goal`, `Cancel Text`, `Check Out My Reviews`, `Connect W/ Later`,
`Fico Cashout Reply`, `Figure Loan Reply`, `500 fico Benefit Analysis`,
`Did you get the equity you needed?`, `Bwr's Goal Rebuttal`, … Each returns
`{ id, name, type, template: { body, attachments }, originId, locationId, dateAdded }`.

### ⚠️ Gotcha — `originId` is documented as REQUIRED and must be OMITTED

The OpenAPI spec marks `originId` `required: true`. Passing it (the location id) returns
`{"templates":[],"totalCount":0}` — a **silent empty list, HTTP 200**. Omitting it returns
all 22. A future maintainer "fixing" the missing required param would quietly zero the
snippet list with no error. This must be a comment in the route and a line in `GOTCHAS.md`.

### ⚠️ Open question — merge fields

14 of 22 snippets contain `{{contact.first_name}}`, `{{user.first_name}}`,
`{{ custom_values.company_name }}`, `{{ custom_values.preferred_… }}`. **Unknown whether
GHL renders those when a message is sent through `POST /conversations/messages`, or
sends the braces literally.** Cannot be settled by reading — it needs one real text.

Two ways forward, pick one:

- **(a) Resolve them ourselves before sending** — safe, no test send needed. We already
  have `contact.first_name` (`deals.first_name`) and the LO name; `custom_values.*` come
  from `GET /locations/{locationId}/customValues` (verified to exist in the spec). Any
  token we can't resolve gets flagged in the composer **before** send, so nobody texts a
  borrower a raw `{{ }}`.
- **(b) Send one test text to Efrain's own number** and see which arrives. Costs one
  message, settles it definitively, and if GHL does render them we skip building (a).

Recommendation: **(a)**, with (b) as a 5-minute confirmation if Efrain wants it. (a) is
strictly safer — it fails loudly in the UI instead of silently at the borrower.

### UI change

3 chips → 22 snippets doesn't fit inline. Proposal: a **"Snippets" button** next to Send
opening a searchable list (name + body preview), filtered as you type, click to insert at
the cursor (not replace the draft — today's chips *overwrite* whatever is typed).
Fetched per `locationId`, cached in component state for the session.

---

## 2. From-number picker — already there, three gaps

**Verified live 2026-07-31:**

| Sub-account | Numbers returned |
|---|---|
| Moe | Efrain's Number `(949) 867-4235`, Mohammad's number `(714) 978-4999`, Brianne's Number `(949) 749-5677` |
| Matt | Matthew's number `(949) 270-3350`, Brianne's Number `(949) 771-8630`, Efrain `(949) 816-1168` |
| Randy | `no_api_key_for_location` — see gap 2 |

The picker sits bottom-right of the composer, and `send-message` pins `fromNumber` into
the payload when set. Gaps:

1. **The default is a name-guess.** `ConversationThread.tsx:82` takes the LO's first name
   and looks for it inside the number's `title`. "Moe Sefati" → `moe`, but his line is
   titled **"Mohammad's number"** — no match, so it silently falls back to
   `numbers[0]` = **Efrain's Number**. *Moe's texts default to sending from Efrain's line.*
   Fix: an explicit LO → number map (env or `sync_state`), name-matching only as fallback.
2. **Randy has no key locally** (`GHL_API_KEY_2`/`GHL_LOCATION_ID_2` unset in `.env.local`;
   prod-only per the Randy memory). His deals show an empty picker locally — needs a check
   against prod before assuming it works there.
3. **The choice doesn't stick.** Re-picking on every message. Persist last-used per LO in
   `localStorage`, or per-deal if Efrain wants it pinned to the borrower.

---

## 3. Send scope — confirmed working

The route has a `needsScope` error path implying the write scope was once missing.
Probed both keys with a deliberately invalid contact id (**no message deliverable**):
both returned `400 "Contact with id … not found"`, not `401/403`. **The
conversations-messages write scope is present on Moe's and Matt's integrations.**
Randy's is unverified (no local key).

---

## 4. Proposed phases

| # | Work | Files | Rough size |
|---|---|---|---|
| 1 | `GET /api/ghl/snippets?locationId=` → `/locations/{id}/templates`, `originId` omitted + comment | new route | S |
| 2 | Snippet picker UI (searchable, insert-at-cursor, replaces the 3 hardcoded chips) | `ConversationThread.tsx` | M |
| 3 | Merge-field resolution + "unresolved token" guard before send (option (a)) | `ConversationThread.tsx`, new `lib/mergeFields.ts`, customValues fetch | M |
| 4 | Explicit LO → from-number map + persist last choice | `ConversationThread.tsx`, env or `sync_state` | S |
| 5 | Fixtures: `snippets-check.ts` (originId regression, merge-field resolution) | `scripts/` | S |

Phases 1–2 alone deliver the ask ("bring over the text snippets"). 3 is the safety net
that keeps a raw `{{contact.first_name}}` off a borrower's phone. 4 is the real bug —
**Moe's replies currently default to Efrain's number.**

## 5. Out of scope

- Email snippets. Both locations return 2 email templates, but the body came back empty in
  the SMS-shaped response (likely under `template.html`) — unverified, and the composer is
  SMS-only today.
- Attachments/MMS (`template.attachments` exists on every snippet; ignored for now).
- FollowUpBoss snippets — this is the GHL composer only.
- Anything that would make GHL's own app boot faster. It can't be done from here: GHL
  serves the shell in ~160–250 ms and the rest is their SPA booting.
