import { resolveIdentities, computeContactRows, ResolverDeal } from '../lib/identityResolver'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok  — ${name}`)
  } else {
    failures++
    console.log(`  FAIL — ${name}`, detail !== undefined ? JSON.stringify(detail) : '')
  }
}

// ── 1. Marian: 3 loans, same email, 2 GHL contact ids → ONE person, oldest wins ──
{
  const deals: ResolverDeal[] = [
    { id: 'm1', created_at: '2025-03-01', borrower_id: 'B1', ghl_contact_id: 'hygNEp', email: 'mariancooper6121@gmail.com', phone: '5551112222' },
    { id: 'm2', created_at: '2025-01-15', borrower_id: 'B2', ghl_contact_id: 'hygNEp', email: 'mariancooper6121@gmail.com', phone: null }, // oldest → canonical
    { id: 'm3', created_at: '2025-06-01', borrower_id: 'B3', ghl_contact_id: 'N0cIvx', email: 'MarianCooper6121@gmail.com', phone: '5551112222' },
  ]
  const r = resolveIdentities(deals)
  check('Marian collapses to 1 changed component', r.componentsChanged === 1, r.componentsChanged)
  check('Marian canonical = oldest borrower_id (B2)', r.components[0]?.canonical === 'B2', r.components[0])
  check('Marian rewrites both non-canonical rows (2)', r.dealsRewritten === 2, r.rewrites)
  check('Marian rewrite targets all = B2', r.rewrites.every(w => w.to === 'B2'), r.rewrites)
}

// ── 2. Two strangers sharing ONLY a role email (info@) must NOT merge ──
{
  const deals: ResolverDeal[] = [
    { id: 's1', created_at: '2025-01-01', borrower_id: 'S1', ghl_contact_id: null, email: 'info@brokerage.com', phone: '5551230001' },
    { id: 's2', created_at: '2025-02-01', borrower_id: 'S2', ghl_contact_id: null, email: 'info@brokerage.com', phone: '5559990002' },
  ]
  const r = resolveIdentities(deals)
  check('role-email strangers NOT merged (0 rewrites)', r.dealsRewritten === 0, r)
}

// ── 3. Two strangers sharing ONLY a junk phone (0000000000) must NOT merge ──
{
  const deals: ResolverDeal[] = [
    { id: 't1', created_at: '2025-01-01', borrower_id: 'T1', ghl_contact_id: null, email: 'a@example.com', phone: '0000000000' },
    { id: 't2', created_at: '2025-02-01', borrower_id: 'T2', ghl_contact_id: null, email: 'b@example.com', phone: '000-000-0000' },
  ]
  const r = resolveIdentities(deals)
  check('junk-phone strangers NOT merged (0 rewrites)', r.dealsRewritten === 0, r)
}

// ── 4. Idempotency: already-canonical data rewrites nothing ──
{
  const deals: ResolverDeal[] = [
    { id: 'z1', created_at: '2025-01-01', borrower_id: 'Z', ghl_contact_id: 'c9', email: 'z@example.com', phone: null },
    { id: 'z2', created_at: '2025-05-01', borrower_id: 'Z', ghl_contact_id: 'c9', email: 'z@example.com', phone: null },
  ]
  const r = resolveIdentities(deals)
  check('already-unified → 0 rewrites (idempotent)', r.dealsRewritten === 0, r)
}

// ── 5. Guarded transitivity: A–B via email, B–C via phone ⇒ A=B=C ──
{
  const deals: ResolverDeal[] = [
    { id: 'a', created_at: '2025-01-01', borrower_id: 'A', ghl_contact_id: null, email: 'shared1@example.com', phone: '5550000001' }, // oldest
    { id: 'b', created_at: '2025-02-01', borrower_id: 'B', ghl_contact_id: null, email: 'shared1@example.com', phone: '5550000002' },
    { id: 'c', created_at: '2025-03-01', borrower_id: 'C', ghl_contact_id: null, email: 'other@example.com', phone: '5550000002' },
  ]
  const r = resolveIdentities(deals)
  check('transitive chain forms 1 component', r.componentsChanged === 1 && r.largestComponentSize === 3, r)
  check('transitive canonical = oldest (A)', r.components[0]?.canonical === 'A', r.components[0])
}

// ── 6. computeContactRows: Marian → ONE contact with correct rollups ──
{
  const deals: ResolverDeal[] = [
    { id: 'm1', created_at: '2025-03-01', updated_at: '2025-03-02', borrower_id: 'B1', ghl_contact_id: 'hygNEp', email: 'mariancooper6121@gmail.com', phone: '5551112222', name: 'Marian Cooper', loan_amount: 280000, compensation_amount: 7000, pipeline_group: 'Funded' },
    { id: 'm2', created_at: '2025-01-15', updated_at: '2025-06-10', borrower_id: 'B2', ghl_contact_id: 'hygNEp', email: 'mariancooper6121@gmail.com', phone: null, name: 'Marian Elizabeth Cooper', loan_amount: 381700, compensation_amount: 9000, pipeline_group: 'Funded' }, // oldest created → canonical; newest updated → identity
    { id: 'm3', created_at: '2025-06-01', updated_at: '2025-06-01', borrower_id: 'B3', ghl_contact_id: 'N0cIvx', email: 'MarianCooper6121@gmail.com', phone: '5551112222', name: 'Marian Cooper', loan_amount: 200000, compensation_amount: 0, pipeline_group: 'Leads' },
  ]
  const rows = computeContactRows(deals)
  check('Marian = exactly 1 contact', rows.length === 1, rows.length)
  const c = rows[0]
  check('contact id = oldest borrower_id (B2)', c?.id === 'B2', c?.id)
  check('loan_count = 3', c?.loan_count === 3, c?.loan_count)
  check('funded_count = 2', c?.funded_count === 2, c?.funded_count)
  check('total_funded_volume = 661700', c?.total_funded_volume === 661700, c?.total_funded_volume)
  check('total_comp = 16000', c?.total_comp === 16000, c?.total_comp)
  check('display_name from most-recently-updated row', c?.display_name === 'Marian Elizabeth Cooper', c?.display_name)
  check('both ghl_contact_ids captured', c?.ghl_contact_ids.length === 2, c?.ghl_contact_ids)
}

// ── 7. Keyless deal (no email/phone/cid) stays attached via shared borrower_id ──
{
  const deals: ResolverDeal[] = [
    { id: 'k1', created_at: '2025-01-01', updated_at: '2025-01-01', borrower_id: 'P', ghl_contact_id: 'cidP', email: 'p@example.com', phone: '5557770001', name: 'Pat Person', loan_amount: 300000, compensation_amount: 5000, pipeline_group: 'Funded' },
    { id: 'k2', created_at: '2025-02-01', updated_at: '2025-02-01', borrower_id: 'P', ghl_contact_id: null, email: null, phone: null, name: 'Pat Person.2', loan_amount: 150000, compensation_amount: 2000, pipeline_group: 'Funded' }, // keyless, same borrower_id
  ]
  const rows = computeContactRows(deals)
  check('keyless row joins its person → 1 contact', rows.length === 1, rows.length)
  check('keyless contact loan_count = 2', rows[0]?.loan_count === 2, rows[0]?.loan_count)
  check('keyless contact volume = 450000', rows[0]?.total_funded_volume === 450000, rows[0]?.total_funded_volume)
}

console.log(failures === 0 ? '\nALL FIXTURES PASSED' : `\n${failures} FIXTURE(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
