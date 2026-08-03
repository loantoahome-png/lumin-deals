// Fixture check for lib/comp.ts — the Non-Del total-comp rule. Pure, no DB.
// Run: npx tsx scripts/comp-check.ts
//
// Locks the rule Efrain stated 2026-08-03: on a Non-Del loan the total comp is
// the Arive compensation line PLUS the Final Price credit (net discount points
// × loan amount). The anchor case is Edward Fadel, whose Rate Lock screen is the
// screenshot this whole feature came from.
import { isNonDel, discountCredit, totalComp } from '../lib/comp'
import type { Deal } from '../lib/types'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
function approx(label: string, got: number, want: number, eps = 0.005) {
  const ok = Math.abs(got - want) < eps
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${got}\n   want: ~${want}`) }
}

const d = (p: Partial<Deal>): Deal => ({
  id: 'x', compensation_amount: null, loan_amount: null,
  broker_corr: null, net_discount_points: null, ...p,
} as Deal)

// ── The anchor: Edward Fadel, Arive 16541057, funded 2026-05-13 ────────────────
// Rate Lock screen: Originator Compensation 0.750% $8,212.35
//                   Final Price             1.210% $13,249.26
const fadel = d({ compensation_amount: 8212.35, loan_amount: 1094980, broker_corr: 'Non-Del', net_discount_points: 1.21 })
approx('Fadel credit = the Final Price on the lock', discountCredit(fadel), 13249.26)
approx('Fadel total comp', totalComp(fadel), 21461.61)

// ── Gating: broker loans must NOT pick up the credit ───────────────────────────
// Arive exports net discount points on broker loans too, but there the rebate is
// already inside the lender-paid comp figure. Counting it again would inflate 76
// of the 86 live funded loans.
const broker = d({ compensation_amount: 8946, loan_amount: 447300, broker_corr: 'Broker', net_discount_points: 1.21 })
eq('broker loan gets no credit', discountCredit(broker), 0)
eq('broker total = Arive comp alone', totalComp(broker), 8946)

const untagged = d({ compensation_amount: 5000, loan_amount: 400000, broker_corr: null, net_discount_points: 1.5 })
eq('untagged channel gets no credit', discountCredit(untagged), 0)

// ── Channel spelling tolerance ────────────────────────────────────────────────
eq('Non-Del',  isNonDel(d({ broker_corr: 'Non-Del' })), true)
eq('Non Del',  isNonDel(d({ broker_corr: 'Non Del' })), true)
eq('NonDel',   isNonDel(d({ broker_corr: 'nondel' })), true)
eq('Broker',   isNonDel(d({ broker_corr: 'Broker' })), false)
eq('null',     isNonDel(d({ broker_corr: null })), false)

// ── Missing inputs mean "not recorded yet", never a silent zero total ──────────
const noPoints = d({ compensation_amount: 4485, loan_amount: 200000, broker_corr: 'Non-Del', net_discount_points: null })
eq('Non-Del without points → comp survives', totalComp(noPoints), 4485)
eq('Non-Del without points → no credit', discountCredit(noPoints), 0)

const noAmount = d({ compensation_amount: 4485, loan_amount: null, broker_corr: 'Non-Del', net_discount_points: 1.21 })
eq('points without a loan amount → no credit', discountCredit(noAmount), 0)
eq('points without a loan amount → comp survives', totalComp(noAmount), 4485)

// A Non-Del loan can carry a credit with no Arive comp at all (Fabian Burrage
// funded 2026-08-03 with comp 0) — the credit must still count as revenue.
const creditOnly = d({ compensation_amount: 0, loan_amount: 65553, broker_corr: 'Non-Del', net_discount_points: 2 })
approx('credit with zero comp still earns', totalComp(creditOnly), 1311.06)

eq('empty deal → 0', totalComp(d({})), 0)

console.log(`\ncomp-check: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
