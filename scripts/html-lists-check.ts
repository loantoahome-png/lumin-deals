// Fixture check for lib/htmlLists.ts. Pure, no DB.
// Run: npx tsx scripts/html-lists-check.ts

import { mergeAdjacentLists } from '../lib/htmlLists'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// ── The actual Google Docs paste shape ─────────────────────────────────────
eq('two single-item lists merge',
  mergeAdjacentLists('<ol><li>a</li></ol><ol><li>b</li></ol>'),
  '<ol><li>a</li><li>b</li></ol>')

eq('a seven-item paste collapses to one list',
  mergeAdjacentLists('<ol><li>1</li></ol>'.repeat(7)),
  '<ol>' + '<li>1</li>'.repeat(7) + '</ol>')

eq('whitespace and newlines between them still merge',
  mergeAdjacentLists('<ol><li>a</li></ol>\n  <ol><li>b</li></ol>'),
  '<ol><li>a</li><li>b</li></ol>')

eq('start attributes are dropped (that is the point)',
  mergeAdjacentLists('<ol><li>a</li></ol><ol start="2"><li>b</li></ol>'),
  '<ol><li>a</li><li>b</li></ol>')

eq('bulleted lists too',
  mergeAdjacentLists('<ul><li>a</li></ul><ul><li>b</li></ul>'),
  '<ul><li>a</li><li>b</li></ul>')

// ── What must NOT merge ────────────────────────────────────────────────────
// ⚠️ The real document has "Requested 8/10" and "Requested 8/6" as two lists
//    with a paragraph between. Merging those would silently combine two days'
//    work into one list.
eq('a paragraph between keeps them separate',
  mergeAdjacentLists('<ol><li>a</li></ol><p>Requested 8/6</p><ol><li>b</li></ol>'),
  '<ol><li>a</li></ol><p>Requested 8/6</p><ol><li>b</li></ol>')

eq('a heading between keeps them separate',
  mergeAdjacentLists('<ol><li>a</li></ol><h3>x</h3><ol><li>b</li></ol>'),
  '<ol><li>a</li></ol><h3>x</h3><ol><li>b</li></ol>')

eq('different list types never merge',
  mergeAdjacentLists('<ol><li>a</li></ol><ul><li>b</li></ul>'),
  '<ol><li>a</li></ol><ul><li>b</li></ul>')

// ⚠️ Nesting must survive: a nested list closes into </li>, never into <ol>,
//    so the pattern can't match and flatten it.
eq('nested lists are untouched',
  mergeAdjacentLists('<ol><li>a<ol><li>b</li></ol></li></ol>'),
  '<ol><li>a<ol><li>b</li></ol></li></ol>')

eq('nesting survives while siblings merge',
  mergeAdjacentLists('<ol><li>a<ol><li>sub</li></ol></li></ol><ol><li>b</li></ol>'),
  '<ol><li>a<ol><li>sub</li></ol></li><li>b</li></ol>')

// ── Degenerate input ───────────────────────────────────────────────────────
eq('empty string', mergeAdjacentLists(''), '')
eq('no lists at all', mergeAdjacentLists('<p>hello</p>'), '<p>hello</p>')
eq('idempotent', mergeAdjacentLists(mergeAdjacentLists('<ol><li>a</li></ol><ol><li>b</li></ol>')),
  '<ol><li>a</li><li>b</li></ol>')

// A realistic slice of the pasted doc: styled spans, one item per list.
{
  const real =
    '<ol><li><p><span style="font-size: 10pt;">Final HOI</span></p></li></ol>' +
    '<ol><li><p><span style="font-size: 10pt;">Title Order</span></p></li></ol>' +
    '<ol><li><p><span style="font-size: 10pt;">Payoff</span></p><ol><li><p>Ciarmoli</p></li></ol></li></ol>'
  const merged = mergeAdjacentLists(real)
  eq('real paste: collapses to a single top-level list', (merged.match(/<ol\b/gi) ?? []).length, 2) // 1 outer + 1 nested
  eq('real paste: keeps every item', (merged.match(/<li\b/gi) ?? []).length, 4)
  eq('real paste: styling untouched', merged.includes('font-size: 10pt;'), true)
  eq('real paste: nested Ciarmoli still nested', /<li><p>Ciarmoli<\/p><\/li>/.test(merged), true)
}

console.log(`\n${fail === 0 ? '✓' : '✗'} html-lists-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
