// Fixture check for lib/noteMarkdown.ts — markdown <-> contentEditable HTML converters.
// Run: npx tsc lib/noteMarkdown.ts scripts/notes-md-check.ts --outDir /tmp/nmc \
//        --module nodenext --moduleResolution nodenext --skipLibCheck && node /tmp/nmc/scripts/notes-md-check.js
import { markdownToHtml, htmlToMarkdown, looksLikeHtml } from '../lib/noteMarkdown'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// ── markdownToHtml (seed the editor) ───────────────────────────────
eq('md→html heading', markdownToHtml('# Title'), '<h1>Title</h1>')
eq('md→html bold', markdownToHtml('x **WA** y'), '<div>x <strong>WA</strong> y</div>')
eq('md→html highlight', markdownToHtml('==hi=='), '<div><mark>hi</mark></div>')
eq('md→html bullets grouped', markdownToHtml('- a\n- b'), '<ul><li>a</li><li>b</li></ul>')
eq('md→html blank line', markdownToHtml('a\n\nb'), '<div>a</div><div><br></div><div>b</div>')
eq('md→html escapes', markdownToHtml('a < b & c'), '<div>a &lt; b &amp; c</div>')

// ── htmlToMarkdown (save from the editor) ──────────────────────────
eq('html→md h1', htmlToMarkdown('<h1>Title</h1>'), '# Title')
eq('html→md <b>', htmlToMarkdown('<div><b>bold</b></div>'), '**bold**')
eq('html→md <strong>', htmlToMarkdown('<div><strong>x</strong></div>'), '**x**')
eq('html→md <mark>', htmlToMarkdown('<div><mark>hi</mark></div>'), '==hi==')
eq('html→md hiliteColor span', htmlToMarkdown('<div><span style="background-color: rgb(254, 240, 138)">hi</span></div>'), '==hi==')
eq('html→md font-weight span', htmlToMarkdown('<div><span style="font-weight: bold">x</span></div>'), '**x**')
eq('html→md bullets', htmlToMarkdown('<ul><li>a</li><li>b</li></ul>'), '- a\n- b')
eq('html→md div lines', htmlToMarkdown('<div>line1</div><div>line2</div>'), 'line1\nline2')
eq('html→md <br> lines', htmlToMarkdown('line1<br>line2'), 'line1\nline2')
eq('html→md decodes entities', htmlToMarkdown('<div>a &lt; b &amp; c</div>'), 'a < b & c')

// ── Round-trip stability (md → html → md) ──────────────────────────
const rt = (md: string) => htmlToMarkdown(markdownToHtml(md))
eq('round-trip: states note', rt('AZ, CA, CO, FL, VA, **WA**'), 'AZ, CA, CO, FL, VA, **WA**')
eq('round-trip: heading + body', rt('# SPLITERO STATES\nAZ, **WA**'), '# SPLITERO STATES\nAZ, **WA**')
eq('round-trip: bullets', rt('- one\n- two'), '- one\n- two')
eq('round-trip: highlight', rt('foo ==bar== baz'), 'foo ==bar== baz')
eq('round-trip: mixed', rt('# T\npara **b**\n- x\n- y\n==h=='), '# T\npara **b**\n- x\n- y\n==h==')

// ── looksLikeHtml detects legacy + editor output ───────────────────
eq('detects h1 html', looksLikeHtml('<h1>x</h1>'), true)
eq('detects plain markdown as not-html', looksLikeHtml('# x **b**'), false)

console.log(`\nnotes-md-check: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
