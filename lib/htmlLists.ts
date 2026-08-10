// ── Pasted-list normalisation ───────────────────────────────────────────────
// Google Docs (and Word) paste each list item as its OWN <ol>/<ul>. A seven-item
// list arrives as seven single-item lists sitting next to each other. It LOOKS
// right, and it breaks two things:
//
//   1. Tab can't indent. `sinkListItem` nests an item under the one above it —
//      a lone <li> in its own <ol> has nothing above it, so ProseMirror
//      correctly refuses and nothing happens. (Efrain 2026-08-10: "I'm trying
//      to indent a line but when I press tab it gets out of the editing pane.")
//   2. Numbering restarts at 1 on every item, because each list is a new list.
//
// Merging ADJACENT same-type lists fixes both. Pure string work so it's
// node-testable — fixtures in scripts/html-lists-check.ts.

/**
 * Merge lists that are immediate siblings of the same type.
 *
 * ⚠️ ONLY when they are directly adjacent (whitespace between is fine). Two
 *    lists separated by so much as a <p> are left alone — in the real document
 *    that's "Requested 8/10" and "Requested 8/6", two lists that must not
 *    become one.
 *
 * ⚠️ A nested list closes into `</li>`, never into `<ol>`, so this can't
 *    flatten nesting: the pattern simply doesn't match there.
 *
 * Attributes on the absorbed opening tag are dropped, which is the point — a
 * `start="3"` exists precisely because the list was split, and merging makes
 * the numbering continuous again.
 *
 * Loops because one merge can create the next adjacency:
 *   </ol><ol><li>a</li></ol><ol> → </ol><ol> → merged
 */
export function mergeAdjacentLists(html: string): string {
  if (!html) return html
  let out = html
  let prev: string
  let guard = 0
  do {
    prev = out
    out = out
      .replace(/<\/ol>\s*<ol\b[^>]*>/gi, '')
      .replace(/<\/ul>\s*<ul\b[^>]*>/gi, '')
    // Belt and braces: the replacements strictly shrink the string, so this can
    // only spin if a regex ever stops shrinking. Bail rather than hang the tab.
    if (++guard > 100) break
  } while (out !== prev)
  return out
}
