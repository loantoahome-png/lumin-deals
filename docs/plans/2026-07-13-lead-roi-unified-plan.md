# Plan — Lead ROI unified page

Spec: docs/specs/2026-07-13-lead-roi-unified-spec.md

- [ ] T1 `lib/leadRoi.ts` — pure aggregation module (imports predicates from lib/leadReport;
      leadReport itself is NOT modified — report-import and lead-report-check keep passing).
      Exports: rangeBounds/monthsBetween/anchorMs (date rules), filterDeals (lo via resolveLO,
      scope, purpose, stage, range), buildSourceStats (superset incl. blended spend + ROI×),
      kpis, funnel, stateRows, monthlySeries, projection.
- [ ] T2 `scripts/lead-roi-check.ts` — fixture check for T1 (date anchoring incl. date-only
      local-midnight parse, funded-date-strict rule, blended spend, ROI multiple, projection,
      monthly series). Runs like scripts/lead-report-check.ts.
- [ ] T3 `app/lead-roi/page.tsx` — the page per spec §sections; ports SourceDealsList /
      DealSourceSelect / retainer editor / projection / funded list from lead-spend, KPI +
      state patterns from lead-performance; Recharts for bars + donut; CSV superset export.
- [ ] T4 `app/lead-roi/report/page.tsx` — print-styled report route reading filters from
      query params; Print/Save-as-PDF button; layout per mockup.
- [ ] T5 Rewire: Sidebar Insights → one "Lead ROI" entry; delete app/lead-performance/page.tsx
      + app/lead-spend/page.tsx; next.config permanent redirects from both old paths.
- [ ] T6 Verify: `npx tsc --noEmit` scoped check + `next build`; run lead-report-check +
      lead-roi-check fixtures; VERIFICATION-LOG.md entries.
- [ ] T7 Ship: commit → push → `vercel --prod` (deploy policy: auto-deploy ON). Update
      handoff + memory; republish mockup artifact with single-LO filter chip.
