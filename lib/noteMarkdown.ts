// Helpers for note content. Rendering lives in components/NoteMarkdown.tsx
// (React elements, not an HTML string — so no innerHTML and no XSS surface).

/** Heuristic: does this content still look like the old contentEditable HTML? */
export function looksLikeHtml(s: string | null | undefined): boolean {
  return /<\/?(div|p|br|b|strong|u|i|em|font|span|ul|ol|li|mark)\b/i.test(s ?? '')
}

/**
 * Best-effort, text-preserving conversion of the legacy contentEditable HTML into
 * note markdown. Prioritizes never losing text: line breaks + bold are preserved,
 * other tags are stripped (the user can re-add headings/highlight with # / ==).
 * Non-destructive — only persisted when the user next saves the note.
 */
export function htmlToMarkdown(html: string | null | undefined): string {
  let s = html ?? ''
  s = s.replace(/<\s*br\s*\/?>/gi, '\n')
  s = s.replace(/<\/\s*(div|p)\s*>/gi, '\n')
  s = s.replace(/<\s*(div|p)[^>]*>/gi, '')
  s = s.replace(/<\s*(b|strong)[^>]*>/gi, '**').replace(/<\/\s*(b|strong)\s*>/gi, '**')
  s = s.replace(/<[^>]+>/g, '')   // strip remaining tags (u, i, font, span, ...) — keep their text
  s = s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&')
  s = s.replace(/\*\*\s*\*\*/g, '')   // drop empty bold pairs from stripped nesting
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return s
}
