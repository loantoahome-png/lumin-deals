import { scoreFundedBook, classify, DEFAULT_PAR, RadarDeal } from '../lib/refiRadar';

// Fixture check for the refi scorer. Pure logic — compile with tsc, then run with node.
// asOf is fixed so seasoning is deterministic.
const ASOF = new Date('2026-06-16');

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const base: RadarDeal = {
  id: 'x', borrower_id: 'b', name: 'Test', loan_type: 'Conv', rate: null,
  loan_amount: null, funded_date: null, pipeline_group: 'Funded',
};
const d = (o: Partial<RadarDeal>): RadarDeal => ({ ...base, ...o });

// 1. Seasoned high-rate HELOC → eligible second-lien; no amount → needsEquity.
const c1 = classify(d({ loan_type: 'HELOC', rate: 9.875, funded_date: '2025-10-01' }), DEFAULT_PAR, ASOF);
check('seasoned 9.875% HELOC is eligible second-lien', !!c1 && c1.play === 'second-lien' && c1.eligible && !c1.tooNew);
check('HELOC with no loan_amount flags needsEquity', !!c1 && c1.needsEquity);

// 2. <6mo HELOC → maturing, not eligible.
const c2 = classify(d({ loan_type: 'HELOC', rate: 9.875, funded_date: '2026-04-01' }), DEFAULT_PAR, ASOF);
check('<6mo HELOC is tooNew, not eligible', !!c2 && c2.tooNew && !c2.eligible);

// 3. Low-rate FHA seasoned, no equity → NOT a candidate.
const c3 = classify(d({ loan_type: 'FHA', rate: 5.25, funded_date: '2025-09-01' }), DEFAULT_PAR, ASOF);
check('5.25% FHA without equity is not flagged', c3 === null);

// 3b. FHA at ≤80% LTV → MIP-drop candidate even at a low rate.
const c3b = classify(d({ loan_type: 'FHA', rate: 5.25, ltv: 74, funded_date: '2025-09-01' }), DEFAULT_PAR, ASOF);
check('FHA at 74% LTV is an fha-mip candidate', !!c3b && c3b.play === 'fha-mip' && c3b.eligible);

// 4. Conv 7.5% (par 6.5) seasoned, $480k → eligible first-lien; est saving = balance×delta/12.
const c4 = classify(d({ loan_type: 'Conv', rate: 7.5, loan_amount: 480000, funded_date: '2025-08-01' }), DEFAULT_PAR, ASOF);
const c4Expected = Math.round((480000 * 0.01) / 12);
check('Conv 7.5%@par6.5 is eligible first-lien', !!c4 && c4.play === 'first-lien' && c4.eligible);
check('Conv estMonthly = balance×delta/12', !!c4 && c4.estMonthly === c4Expected);

// 5. Conv 6.6% (delta 0.1 < 0.5) → NOT a candidate.
const c5 = classify(d({ loan_type: 'Conv', rate: 6.6, loan_amount: 400000, funded_date: '2025-08-01' }), DEFAULT_PAR, ASOF);
check('Conv 6.6% below net-benefit threshold is not flagged', c5 === null);

// 6. Non-QM 7.75% seasoned → eligible non-qm.
const c6 = classify(d({ loan_type: 'Non-QM', rate: 7.75, funded_date: '2025-07-01' }), DEFAULT_PAR, ASOF);
check('Non-QM 7.75% is eligible non-qm season-out', !!c6 && c6.play === 'non-qm' && c6.eligible);

// 7. No rate → skipped.
const c7 = classify(d({ loan_type: 'HELOC', rate: null, funded_date: '2025-01-01' }), DEFAULT_PAR, ASOF);
check('loan with no rate is skipped', c7 === null);

// 8. Non-funded excluded by scoreFundedBook.
const list8 = scoreFundedBook([
  d({ id: 'lead', loan_type: 'HELOC', rate: 10, funded_date: '2025-06-01', pipeline_group: 'Leads' }),
  d({ id: 'f', loan_type: 'HELOC', rate: 10, funded_date: '2025-06-01', pipeline_group: 'Funded' }),
], DEFAULT_PAR, ASOF);
check('scoreFundedBook ignores non-funded', list8.length === 1 && list8[0].deal.id === 'f');

// 9. Ranking by score (delta × balance) desc.
const list9 = scoreFundedBook([
  d({ id: 'small', loan_type: 'Conv', rate: 7.0, loan_amount: 200000, funded_date: '2025-06-01' }),
  d({ id: 'big', loan_type: 'Conv', rate: 7.0, loan_amount: 800000, funded_date: '2025-06-01' }),
], DEFAULT_PAR, ASOF);
check('bigger balance ranks first', list9[0].deal.id === 'big');

console.log(`\nrefi-radar fixtures: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
