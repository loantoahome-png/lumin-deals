// ── GHL merge fields in text snippets ───────────────────────────────────────
// 14 of the 22 snippets on each sub-account contain tokens like
// {{contact.first_name}}, {{user.first_name}} and {{ custom_values.company_name }}.
//
// Whether GHL expands those when a message is sent through the Conversations
// API (rather than through its own UI) is NOT documented, and we are not going
// to find out on a borrower's phone. So we resolve them ourselves and refuse to
// send anything with a token left in it — a loud failure in the composer beats
// a text that reads "Hi {{contact.first_name}}".
//
// Split by trust boundary:
//   • location tokens (custom_values) → resolved SERVER-side, in the snippets
//     route, because that list holds secrets (an API token, in Moe's case)
//   • contact/user tokens → resolved client-side, where the borrower and LO are
//
// Tokens tolerate inner spacing: GHL writes both {{contact.first_name}} and
// {{ custom_values.company_name }}.

/** Matches a location-level token — the kind only the server can resolve. */
export const LOCATION_TOKEN_RE = /\{\{\s*custom_values\.[^}]*\}\}/

/** Any remaining {{ … }} token, whoever was meant to resolve it. */
const ANY_TOKEN_RE = /\{\{\s*[^}]*\}\}/g

/** Substitute a map keyed by the literal token text (GHL's `fieldKey` is the
 *  token itself). Spacing inside the braces is normalized before lookup, so
 *  "{{custom_values.x}}" and "{{ custom_values.x }}" hit the same entry. */
export function applyTokens(body: string, values: Record<string, string>): string {
  if (!body) return body
  const normalized: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) normalized[normalizeToken(k)] = v
  return body.replace(ANY_TOKEN_RE, m => normalized[normalizeToken(m)] ?? m)
}

function normalizeToken(token: string): string {
  return token.replace(/\s+/g, '').toLowerCase()
}

export type ContactContext = {
  firstName?: string | null
  lastName?: string | null
  fullName?: string | null
  loanOfficer?: string | null
}

/** Resolve the contact/user half of the tokens, client-side. Anything we can't
 *  fill (a blank first name, an unknown token) is deliberately left in place so
 *  `unresolvedTokens` can catch it before send. */
export function resolveContactTokens(body: string, ctx: ContactContext): string {
  const first = (ctx.firstName || '').trim() || firstWord(ctx.fullName)
  const last = (ctx.lastName || '').trim() || restOfName(ctx.fullName)
  const full = (ctx.fullName || '').trim() || [first, last].filter(Boolean).join(' ')
  const lo = (ctx.loanOfficer || '').trim()
  const loFirst = firstWord(lo)

  const map: Record<string, string> = {}
  const put = (token: string, value: string) => { if (value) map[token] = value }
  put('{{contact.first_name}}', first)
  put('{{contact.last_name}}', last)
  put('{{contact.name}}', full)
  put('{{contact.full_name}}', full)
  put('{{user.first_name}}', loFirst)
  put('{{user.name}}', lo)
  put('{{user.full_name}}', lo)
  return applyTokens(body, map)
}

/** Every token still standing, de-duplicated, for the "can't send this yet"
 *  warning. Empty array means the draft is safe to send. */
export function unresolvedTokens(body: string): string[] {
  const found = body.match(ANY_TOKEN_RE) ?? []
  return [...new Set(found.map(t => t.replace(/\s+/g, ' ').trim()))]
}

function firstWord(name: string | null | undefined): string {
  return (name || '').trim().split(/\s+/)[0] || ''
}
function restOfName(name: string | null | undefined): string {
  const parts = (name || '').trim().split(/\s+/)
  return parts.length > 1 ? parts.slice(1).join(' ') : ''
}

// ── Which line does an LO text from? ────────────────────────────────────────
// The old default matched the LO's first name against the number's title, which
// silently failed for Moe: his line is titled "Mohammad's number", "moe" doesn't
// appear in it, so it fell through to numbers[0] — Efrain's Number. Every text
// Moe sent from the dashboard went out on Efrain's line.
//
// So: match on explicit aliases first, then the name, then give up rather than
// grabbing whatever happens to be first.
const LO_NUMBER_ALIASES: { match: RegExp; titles: RegExp }[] = [
  { match: /moe|sefati|mohammad/i, titles: /mohammad|moe|sefati/i },
  { match: /matt|park|matthew/i,   titles: /matthew|matt|park/i },
  { match: /randy|mathis/i,        titles: /randy|mathis/i },
]

export type PhoneNumber = { value: string; title: string }

/** The number an LO's reply should go out on. Returns null when nothing matches —
 *  the composer shows "pick a number" rather than defaulting to someone else's
 *  line. */
export function pickFromNumber(numbers: PhoneNumber[], loanOfficer: string | null | undefined): string | null {
  if (numbers.length === 0) return null
  const lo = (loanOfficer || '').trim()
  if (!lo) return null

  const alias = LO_NUMBER_ALIASES.find(a => a.match.test(lo))
  if (alias) {
    const hit = numbers.find(n => alias.titles.test(n.title))
    if (hit) return hit.value
  }
  // Fall back to the plain first-name match for any LO not in the alias list.
  const first = firstWord(lo).toLowerCase()
  const named = first ? numbers.find(n => n.title.toLowerCase().includes(first)) : undefined
  return named?.value ?? null
}
