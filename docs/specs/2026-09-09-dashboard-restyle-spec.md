# Dashboard + shared-chrome restyle — spec (2026-09-09)

**Approved by Efrain 2026-09-09** ("go, implement v2 and deploy it") against the v2 mockup:
https://claude.ai/code/artifact/f3dcac6f-916e-4305-a73a-db442bde300f

## Direction (decided 2026-09-04 / revised 2026-09-09)
- Flat surfaces: white cards, hairline borders, one shadow level, no gradients.
- Color by meaning: blue = actions/active/today; red = overdue only; stage colors from the
  app's existing `STATUS_COLORS`; LO colors only on LO identity; orange only on Next Step.
  v1 (blue-only monochrome) was rejected — "more color wouldn't hurt".
- Scope: the dashboard page + shared chrome (sidebar, app font, LO filter chips, task tones).

## Acceptance criteria
1. `/` renders: one-line verse strip → header band (title, scope line, LO chips) → one
   four-cell stat strip (solid blue-700 hero + 3 badge tiles + stage-mix strip) → Today
   follow-ups (when any) → Tasks → stage chart + loan-type bars → LO / attention / recent →
   Next steps table → Unread inbox. Section ORDER and every METRIC unchanged.
2. Stage colors on pills, chart bars and the mix strip = `STATUS_COLORS` hues (`STATUS_STRONG`).
3. Loan types render as sorted bars with fixed `LOAN_TYPE_COLORS`, never a donut.
4. Sidebar: navy `#0f1a38`, "L" monogram tile, blue-600 active item, condensed footer, no ©.
5. Public Sans app-wide via next/font; `font-mono` = Geist Mono; tabular figures in columns.
6. `DUE_TONE` "today" = blue (was violet, which read as Randy's LO color).
7. No data path, RLS, sync, or metric logic changes. `npx tsc` errors = the 7-error baseline;
   `npm run build` passes; all offline `*-check.ts` fixtures still pass.
