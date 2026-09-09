# Dashboard + shared-chrome restyle — plan (2026-09-09)

Spec: `docs/specs/2026-09-09-dashboard-restyle-spec.md`. Worked on `main` per the project's
auto-deploy policy (no worktree — acknowledged skip).

| # | Task | Files | Verify |
|---|------|-------|--------|
| 1 | Add `STATUS_STRONG` + `LOAN_TYPE_COLORS` | `lib/types.ts` | tsc |
| 2 | Fonts via next/font + Tailwind `@theme inline`; page ground `#f4f6fb` | `app/layout.tsx`, `app/globals.css` | build, screenshot |
| 3 | Verse → one-line strip; home page no longer pads it | `components/DailyVerse.tsx`, `app/page.tsx` | screenshot |
| 4 | LO chips: dot + per-LO tint when selected (`LO_TINT`) | `components/LoFilter.tsx` | screenshot; lo-filter call sites unchanged |
| 5 | Task "today" tone violet → blue | `components/TaskBoard.tsx` | grep; /tasks unaffected otherwise |
| 6 | Sidebar navy + monogram + condensed footer; search/bell match the rail | `components/Sidebar.tsx`, `GlobalSearch.tsx`, `NotificationBell.tsx` | screenshot |
| 7 | Unread inbox: flat rows, badge header, stage pills via `STATUS_COLORS` | `components/UnreadInbox.tsx` | screenshot (loads under bypass — server route) |
| 8 | Dashboard JSX rewrite (logic untouched) | `components/Dashboard.tsx` | tsc, eslint, screenshot (chrome only — `deals` RLS empties metrics under bypass) |
| 9 | Fixtures + build + VERIFICATION-LOG + deploy | `VERIFICATION-LOG.md` | `for f in scripts/*-check.ts`, `npm run build`, `vercel --prod` |
