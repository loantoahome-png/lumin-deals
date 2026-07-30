# Plan: Follow-Up Cockpit v1

**Spec:** `docs/specs/2026-07-30-follow-up-cockpit-spec.md` · **Date:** 2026-07-30

| # | Task | Files | Verify |
|---|------|-------|--------|
| 1 | `fub_people` DDL (table + indexes + RLS `team_rw` like contacts) | `supabase-fub-people.sql` | applied via GOTCHAS Management-API recipe; select count works |
| 2 | FUB API client: both keys, keyset pagination, 429 Retry-After, pacing; person→row mapper; ownership by `assignedUserId` (72/73? no — 72 Moe, 13 Matt, 35 Randy); merge/dedupe by `fub_id`; change detection | `lib/followUpBoss.ts` | fixtures in follow-up-check |
| 3 | Queue model: sections (reply-waiting / new / due / stale buckets / past-client / cold), LO scoping, ranking, reason chips | `lib/followUpQueue.ts` | fixtures in follow-up-check |
| 4 | Fixture suite | `scripts/follow-up-check.ts` | `npx tsx scripts/follow-up-check.ts` exit 0 |
| 5 | Sync route: sweep→upsert (insert 500-chunk / update changed / `missing_since` diff), deals cross-match via `normEmail`/`normPhone`, `sync_state.fub_sync_last`, never touches cockpit-state columns | `app/api/sync/fub/route.ts` | `?force=1` populates; re-run idempotent |
| 6 | Cron piggyback (55-min `isDue` gate, non-fatal) | `app/api/cron/ghl-sync/route.ts` | log line on next cron pass |
| 7 | Pages: `/follow-up` index (manager cards) + `/follow-up/[lo]` cockpit (sections, snooze via TriageDateModal pattern, touched-logging, deep links, Sync-now) + Sidebar item | `app/follow-up/**`, `components/Sidebar.tsx` | local dev-bypass browser check |
| 8 | Env to Vercel prod (`FUB_API_KEY_MOE/MATT`), deploy, prod sync + spot-check counts vs research census | — | prod page renders; counts sane |
| 9 | Logs: VERIFICATION-LOG, handoff, memory (fub reference + project state) | — | — |

Rules honored: no new cron jobs (piggyback), cockpit-state columns owned by UI (sync never writes),
Randy excluded from pages but present in data, `.env*` never committed.
