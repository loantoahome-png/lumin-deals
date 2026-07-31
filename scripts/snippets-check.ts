// Fixture check for lib/mergeFields.ts — pure logic, no DB, no GHL.
// Run: npx tsx scripts/snippets-check.ts
//
// Covers the two things that can put a wrong text on a borrower's phone:
//   1. a merge field that silently survives into the sent message
//   2. a reply going out on the wrong LO's line
import {
  applyTokens, resolveContactTokens, unresolvedTokens, pickFromNumber,
  LOCATION_TOKEN_RE, type PhoneNumber,
} from '../lib/mergeFields'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// Real snippet bodies, copied verbatim from the live GHL API 2026-07-31.
const QUICK_QUOTE = "Hi {{contact.first_name}}, don't want to waste your time and attached is the quote I promised. Please let me know if all the information inputted is correct!"
const CANCEL = 'Hey {{contact.first_name}}, {{user.first_name}} from {{ custom_values.company_name }}. If you want to cancel, reply STOP.'
const NO_TOKENS = 'What would be a good time for us to connect later or this week?'

// ── applyTokens: spacing inside the braces must not matter ──────────────────
eq('applyTokens: tight braces', applyTokens('Hi {{contact.first_name}}', { '{{contact.first_name}}': 'Maria' }), 'Hi Maria')
eq('applyTokens: spaced braces', applyTokens('Hi {{ contact.first_name }}', { '{{contact.first_name}}': 'Maria' }), 'Hi Maria')
eq('applyTokens: spaced KEY, tight token',
  applyTokens('Hi {{contact.first_name}}', { '{{ contact.first_name }}': 'Maria' }), 'Hi Maria')
eq('applyTokens: unknown token survives untouched',
  applyTokens('Hi {{contact.nickname}}', { '{{contact.first_name}}': 'Maria' }), 'Hi {{contact.nickname}}')
eq('applyTokens: no tokens is a no-op', applyTokens(NO_TOKENS, {}), NO_TOKENS)
eq('applyTokens: repeated token replaced everywhere',
  applyTokens('{{a}} and {{a}}', { '{{a}}': 'x' }), 'x and x')

// ── LOCATION_TOKEN_RE gates the (secret-bearing) customValues fetch ─────────
eq('location re: matches custom_values', LOCATION_TOKEN_RE.test(CANCEL), true)
eq('location re: ignores contact tokens', LOCATION_TOKEN_RE.test(QUICK_QUOTE), false)
eq('location re: ignores plain text', LOCATION_TOKEN_RE.test(NO_TOKENS), false)

// ── resolveContactTokens ────────────────────────────────────────────────────
const ctx = { firstName: 'Maria', lastName: 'Lopez', fullName: 'Maria Lopez', loanOfficer: 'Moe Sefati' }
eq('contact: first name filled',
  resolveContactTokens(QUICK_QUOTE, ctx).startsWith('Hi Maria,'), true)
eq('contact: user first name filled',
  resolveContactTokens(CANCEL, ctx),
  'Hey Maria, Moe from {{ custom_values.company_name }}. If you want to cancel, reply STOP.')
eq('contact: falls back to splitting the full name',
  resolveContactTokens('Hi {{contact.first_name}} {{contact.last_name}}', { fullName: 'Maria Lopez' }),
  'Hi Maria Lopez')
eq('contact: blank first name leaves the token standing (so the guard fires)',
  resolveContactTokens(QUICK_QUOTE, { firstName: '', fullName: '' }).startsWith('Hi {{contact.first_name}},'), true)
eq('contact: no LO leaves the user token standing',
  resolveContactTokens('From {{user.first_name}}', { firstName: 'Maria' }), 'From {{user.first_name}}')

// ── unresolvedTokens — the send guard ───────────────────────────────────────
eq('guard: clean draft sends', unresolvedTokens('Hi Maria, ready when you are.'), [])
eq('guard: leftover contact token blocks', unresolvedTokens(QUICK_QUOTE), ['{{contact.first_name}}'])
eq('guard: normalizes spacing when reporting',
  unresolvedTokens('Hi {{  contact.first_name  }}'), ['{{ contact.first_name }}'])
eq('guard: de-dupes repeats', unresolvedTokens('{{a}} {{a}} {{b}}'), ['{{a}}', '{{b}}'])
eq('guard: server-resolved custom value leaves nothing behind',
  unresolvedTokens(resolveContactTokens(applyTokens(CANCEL, { '{{ custom_values.company_name }}': 'Lumin Lending' }), ctx)), [])

// ── pickFromNumber — the bug this fixes ─────────────────────────────────────
// Moe's line is titled "Mohammad's number": a first-name match on "moe" misses
// it, and the old code then fell through to numbers[0] = Efrain's line.
const MOE_NUMBERS: PhoneNumber[] = [
  { value: '+19498674235', title: "Efrain's Number" },
  { value: '+17149784999', title: "Mohammad's number" },
  { value: '+19497495677', title: "Brianne's Number" },
]
const MATT_NUMBERS: PhoneNumber[] = [
  { value: '+19492703350', title: "Matthew's number" },
  { value: '+19497718630', title: "Brianne's Number" },
  { value: '+19498161168', title: 'Efrain' },
]
eq('from: Moe → Mohammad\'s line, NOT Efrain\'s', pickFromNumber(MOE_NUMBERS, 'Moe Sefati'), '+17149784999')
eq('from: Matt → Matthew\'s line', pickFromNumber(MATT_NUMBERS, 'Matt Park'), '+19492703350')
eq('from: Randy with no line of his own → null, not someone else\'s',
  pickFromNumber(MOE_NUMBERS, 'Randy Mathis'), null)
eq('from: unknown LO → null', pickFromNumber(MOE_NUMBERS, 'Jordan Someone'), null)
eq('from: no LO → null', pickFromNumber(MOE_NUMBERS, null), null)
eq('from: empty list → null', pickFromNumber([], 'Moe Sefati'), null)
eq('from: matches on the surname too', pickFromNumber(MOE_NUMBERS, 'Sefati'), '+17149784999')
eq('from: plain first-name match still works for a new LO',
  pickFromNumber([{ value: '+15551110000', title: "Jordan's line" }], 'Jordan Reyes'), '+15551110000')

console.log(fail === 0 ? `✓ snippets-check: all ${pass} fixtures pass` : `${fail} FAILED / ${pass} passed`)
if (fail > 0) process.exit(1)
