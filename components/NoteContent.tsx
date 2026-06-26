'use client'

import DOMPurify from 'dompurify'
import { markdownToHtml, looksLikeHtml } from '@/lib/noteMarkdown'

// Read-only renderer for a note's stored content. New notes are HTML (TipTap);
// legacy notes are markdown — converted on the fly so both display. Always
// sanitized before it touches the DOM (notes load client-side, so window exists).
export default function NoteContent({ content, className = '' }: { content: string; className?: string }) {
  const html = looksLikeHtml(content) ? content : markdownToHtml(content)
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] })
  return <div className={`note-prose ${className}`} dangerouslySetInnerHTML={{ __html: clean }} />
}
