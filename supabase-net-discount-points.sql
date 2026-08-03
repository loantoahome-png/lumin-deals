-- Non-Del total compensation: Arive comp + Final Price credit.
--
-- Arive's exported "Compensation Amount" is only the Originator Compensation
-- line. On a Non-Delegated loan the Rate Lock also carries a Final Price rebate
-- that we earn. Arive exports that as a PERCENTAGE ("Net Discount Points");
-- dollars = points% × total loan amount.
--
-- Verified on Edward Fadel (Arive 16541057): 1.21% × $1,094,980 = $13,249.26,
-- an exact match to the Final Price shown on the lock — on top of the $8,212.35
-- of originator comp the dashboard was reporting as the whole loan.
--
-- Percent, not dollars: 1.21 means 1.21%. Positive = a credit to us.
-- Populated for Non-Del loans only (see lib/comp.ts — the credit is gated on
-- broker_corr so broker loans, whose rebate is already inside their lender-paid
-- comp figure, are never double-counted).
--
-- Run in the Supabase SQL editor. Additive and nullable — safe to re-run.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS net_discount_points NUMERIC;

COMMENT ON COLUMN deals.net_discount_points IS
  'Arive "Net Discount Points" (percent, e.g. 1.21). On Non-Del loans, points/100 * loan_amount is the Final Price credit added to compensation_amount for total comp. See lib/comp.ts.';
