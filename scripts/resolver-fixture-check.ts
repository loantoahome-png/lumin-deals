import { resolveIdentities, ResolverDeal } from '../lib/identityResolver'

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

console.log(failures === 0 ? '\nALL FIXTURES PASSED' : `\n${failures} FIXTURE(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
