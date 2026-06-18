// Helpers for note content. The note body is edited as WYSIWYG (contentEditable)
// but STORED as markdown — so existing notes keep working and the read-only view
// (components/NoteMarkdown.tsx) renders React elements (no innerHTML, no XSS surface).
//
//   markdownToHtml  — seed the contentEditable editor from stored markdown
//   htmlToMarkdown  — convert the editor's HTML back to markdown on save
//   looksLikeHtml   — detect legacy notes that were stored as raw contentEditable HTML

/** Heuristic: does this content still look like the old contentEditable HTML? */
export function looksLikeHtml(s: string | null | undefined): boolean {
  return /<\/?(div|p|br|b|strong|u|i|em|font|span|ul|ol|li|mark|h[1-3])\b/i.test(s ?? '')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Inline markdown → HTML: **bold** and ==highlight==. Links stay as plain text so
// they're easy to edit; NoteMarkdown re-links them in the read-only view.
const INLINE_TOKEN = /(\*\*[^*]+\*\*|==[^=]+==)/g
function inlineToHtml(text: string): string {
  return text.split(INLINE_TOKEN).map(part => {
    if (!part) return ''
    if (part.length >= 4 && part.startsWith('**') && part.endsWith('**')) return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`
    if (part.length >= 4 && part.startsWith('==') && part.endsWith('==')) return `<mark>${escapeHtml(part.slice(2, -2))}</mark>`
    return escapeHtml(part)
  }).join('')
}

/** Stored markdown → HTML for seeding the contentEditable editor. */
export function markdownToHtml(md: string | null | undefined): string {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inList = false
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const li = line.match(/^\s*[-*]\s+(.*)$/)
    if (h) {
      closeList()
      const lvl = h[1].length
      out.push(`<h${lvl}>${inlineToHtml(h[2])}</h${lvl}>`)
    } else if (li) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inlineToHtml(li[1])}</li>`)
    } else if (line.trim() === '') {
      closeList()
      out.push('<div><br></div>')
    } else {
      closeList()
      out.push(`<div>${inlineToHtml(line)}</div>`)
    }
  }
  closeList()
  return out.join('')
}

/**
 * Best-effort, text-preserving conversion of contentEditable HTML into note markdown.
 * Handles what the editor produces (headings, bold, highlight, bullet lists) plus the
 * legacy HTML format. Prioritizes never losing text — unknown tags are stripped but
 * their text is kept.
 */
export function htmlToMarkdown(html: string | null | undefined): string {
  let s = html ?? ''
  // Block elements → markdown line forms (keep inner HTML for the inline pass below).
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, c) => `\n# ${c}\n`)
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, c) => `\n## ${c}\n`)
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, c) => `\n### ${c}\n`)
  // Collapse each <ul>/<ol> into "- item" lines. No leading newline — the preceding
  // block already ends in \n — so a list right after a paragraph doesn't gain a blank line.
  s = s.replace(/<(?:ul|ol)[^>]*>([\s\S]*?)<\/(?:ul|ol)>/gi, (_m, inner: string) => {
    const items = (inner.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [])
      .map(li => '- ' + li.replace(/<li[^>]*>([\s\S]*?)<\/li>/i, '$1').trim())
    return items.length ? items.join('\n') + '\n' : ''
  })
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, c) => `\n- ${String(c).trim()}`) // stray items
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '')
  s = s.replace(/<\s*br\s*\/?>/gi, '\n')
  s = s.replace(/<\/\s*(div|p)\s*>/gi, '\n')
  s = s.replace(/<\s*(div|p)[^>]*>/gi, '')
  // Inline: bold (tags + font-weight spans), then highlight (<mark> + background spans/fonts).
  s = s.replace(/<span[^>]*font-weight:\s*(?:bold|[6-9]00)[^>]*>([\s\S]*?)<\/span>/gi, (_m, c) => `**${c}**`)
  s = s.replace(/<\s*(b|strong)[^>]*>/gi, '**').replace(/<\/\s*(b|strong)\s*>/gi, '**')
  s = s.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, (_m, c) => `==${c}==`)
  s = s.replace(/<(span|font)[^>]*background-color[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, c) => `==${c}==`)
  // Strip any remaining tags (keep their text), decode entities.
  s = s.replace(/<[^>]+>/g, '')
  s = s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&')
  // Drop empty marker pairs left by stripped/nested formatting, normalize blank lines.
  s = s.replace(/\*\*\s*\*\*/g, '').replace(/==\s*==/g, '')
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return s
}
