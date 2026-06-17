import React from 'react'

// Renders note markdown as React elements (never an HTML string), so user text is
// escaped by React and there is no XSS surface.
//   # / ## / ###  -> headings (font size)
//   **bold**      -> bold
//   ==highlight== -> yellow highlight
//   - bullet      -> list
//   https://...   -> link

const HEADING_CLASS: Record<number, string> = {
  1: 'text-xl font-bold text-slate-900 mt-3 mb-1 first:mt-0',
  2: 'text-lg font-semibold text-slate-900 mt-2.5 mb-0.5 first:mt-0',
  3: 'text-base font-semibold text-slate-800 mt-2 first:mt-0',
}

const TOKEN = /(\*\*[^*]+\*\*|==[^=]+==|https?:\/\/[^\s)]+)/g

// Inline spans: **bold**, ==highlight==, links. Split keeps the matched tokens,
// so we never call RegExp.exec and React escapes every text part.
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    if (!part) return null
    const key = keyBase + '-' + i
    if (part.length >= 4 && part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    if (part.length >= 4 && part.startsWith('==') && part.endsWith('==')) {
      return <mark key={key} className="rounded bg-yellow-200 px-0.5">{part.slice(2, -2)}</mark>
    }
    if (/^https?:\/\//.test(part)) {
      return <a key={key} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all">{part}</a>
    }
    return <React.Fragment key={key}>{part}</React.Fragment>
  })
}

export default function NoteMarkdown({ md }: { md: string }) {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let list: React.ReactNode[] | null = null
  let k = 0
  const flush = () => {
    if (list) {
      blocks.push(<ul key={'ul-' + k++} className="list-disc pl-5 space-y-0.5 my-1">{list}</ul>)
      list = null
    }
  }

  lines.forEach((line, idx) => {
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const li = line.match(/^\s*[-*]\s+(.*)$/)
    if (h) {
      flush()
      const level = h[1].length
      const Tag = ('h' + level) as 'h1' | 'h2' | 'h3'
      blocks.push(<Tag key={idx} className={HEADING_CLASS[level]}>{renderInline(h[2], 'h' + idx)}</Tag>)
    } else if (li) {
      if (!list) list = []
      list.push(<li key={idx}>{renderInline(li[1], 'li' + idx)}</li>)
    } else if (line.trim() === '') {
      flush()
      blocks.push(<div key={idx} className="h-2" />)
    } else {
      flush()
      blocks.push(<p key={idx} className="leading-relaxed">{renderInline(line, 'p' + idx)}</p>)
    }
  })
  flush()

  return <div className="text-sm text-slate-800 break-words">{blocks}</div>
}
