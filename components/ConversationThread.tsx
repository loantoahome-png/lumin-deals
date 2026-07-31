'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { RefreshCw, Send, Phone, MessageSquare, Mail, ExternalLink, FileText, Search, X } from 'lucide-react'
import { resolveContactTokens, unresolvedTokens, pickFromNumber } from '@/lib/mergeFields'

type ThreadMessage = {
  id: string | null
  direction: 'inbound' | 'outbound'
  body: string
  channel: string
  status: string | null
  at: string | null
}
type PhoneNumber = { value: string; title: string }
type Snippet = { id: string; name: string; body: string; hasAttachments: boolean }

// Last-used sending number, per LO. GHL has no "my line" concept we can read,
// and re-picking on every message was the complaint.
const FROM_KEY = (lo: string | null) => `lumin:fromNumber:${(lo || 'unknown').toLowerCase()}`

function fmtTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function fmtPhone(v: string): string {
  const d = v.replace(/\D/g, '').replace(/^1/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : v
}

export default function ConversationThread({
  contactId, locationId, ghlUrl, loanOfficer, smsBlocked = false, dndNote,
  contactFirstName, contactLastName, contactName,
}: {
  contactId: string
  locationId: string | null
  ghlUrl: string | null
  loanOfficer: string | null
  smsBlocked?: boolean          // contact is Do-Not-Contact for SMS — block the composer
  dndNote?: string | null       // label to show, e.g. "Do Not Contact" / "DND: SMS"
  // Borrower identity, for filling {{contact.*}} tokens in a snippet.
  contactFirstName?: string | null
  contactLastName?: string | null
  contactName?: string | null
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [numbers, setNumbers] = useState<PhoneNumber[]>([])
  const [fromNumber, setFromNumber] = useState('')
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [snippetQuery, setSnippetQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)

  // Keep the newest message in view whenever the thread changes.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loading])

  const fetchThread = useCallback(async () => {
    if (!locationId) { setLoading(false); setError('No GHL location on this deal.'); return }
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/ghl/thread?contactId=${contactId}&locationId=${locationId}`, { cache: 'no-store' })
      const data = await res.json() as { ok: boolean; messages?: ThreadMessage[]; error?: string }
      if (data.ok && data.messages) setMessages(data.messages)
      else setError(data.error || 'Failed to load conversation.')
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }, [contactId, locationId])

  useEffect(() => { fetchThread() }, [fetchThread])

  // Load the account's numbers once, then pick this LO's own line.
  // Order: what they chose last time → the alias map (which knows Moe's line is
  // titled "Mohammad's number") → nothing. Never numbers[0]: that silently sent
  // every one of Moe's texts from Efrain's line.
  useEffect(() => {
    if (!locationId || numbers.length > 0) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/ghl/numbers?locationId=${locationId}`, { cache: 'no-store' })
        const data = await res.json() as { ok: boolean; numbers?: PhoneNumber[] }
        if (cancelled || !data.ok || !data.numbers) return
        setNumbers(data.numbers)
        const remembered = typeof window !== 'undefined' ? window.localStorage.getItem(FROM_KEY(loanOfficer)) : null
        const valid = remembered && data.numbers.some(n => n.value === remembered) ? remembered : null
        setFromNumber(valid || pickFromNumber(data.numbers, loanOfficer) || '')
      } catch { /* non-fatal */ }
    })()
    return () => { cancelled = true }
  }, [locationId, numbers.length, loanOfficer])

  // The team's real GHL snippets for this sub-account.
  useEffect(() => {
    if (!locationId) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/ghl/snippets?locationId=${locationId}`, { cache: 'no-store' })
        const data = await res.json() as { ok: boolean; snippets?: Snippet[] }
        if (!cancelled && data.ok && data.snippets) setSnippets(data.snippets)
      } catch { /* non-fatal — the composer still works without snippets */ }
    })()
    return () => { cancelled = true }
  }, [locationId])

  function chooseNumber(value: string) {
    setFromNumber(value)
    try { window.localStorage.setItem(FROM_KEY(loanOfficer), value) } catch { /* private mode */ }
  }

  const visibleSnippets = useMemo(() => {
    const q = snippetQuery.trim().toLowerCase()
    if (!q) return snippets
    return snippets.filter(s => s.name.toLowerCase().includes(q) || s.body.toLowerCase().includes(q))
  }, [snippets, snippetQuery])

  // Insert at the cursor rather than replacing the draft — the old chips wiped
  // whatever had already been typed.
  function insertSnippet(s: Snippet) {
    const filled = resolveContactTokens(s.body, {
      firstName: contactFirstName, lastName: contactLastName,
      fullName: contactName, loanOfficer,
    })
    const el = draftRef.current
    const at = el ? el.selectionStart : draft.length
    const before = draft.slice(0, at)
    const after = draft.slice(at)
    const joiner = before && !/\s$/.test(before) ? ' ' : ''
    const next = `${before}${joiner}${filled}${after}`
    setDraft(next)
    setSnippetsOpen(false)
    setSnippetQuery('')
    requestAnimationFrame(() => {
      const pos = (before + joiner + filled).length
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  // Anything still in braces after substitution — GHL may or may not expand
  // these on an API send, so we don't find out on a borrower's phone.
  const leftoverTokens = useMemo(() => unresolvedTokens(draft), [draft])

  async function send() {
    if (!draft.trim() || sending || !locationId || smsBlocked || leftoverTokens.length > 0) return
    setSending(true); setError(null)
    try {
      const res = await fetch('/api/ghl/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, locationId, message: draft.trim(), fromNumber: fromNumber || undefined }),
      })
      const data = await res.json() as { ok: boolean; needsScope?: boolean; error?: string }
      if (data.ok) {
        setDraft('')
        // Optimistically append, then refetch to pick up GHL's stored copy
        setMessages(prev => [...prev, { id: `local-${Date.now()}`, direction: 'outbound', body: draft.trim(), channel: 'Text', status: 'sending', at: new Date().toISOString() }])
        setTimeout(fetchThread, 1500)
      } else if (data.needsScope) {
        setError('GHL hasn’t granted message-send access yet. Enable the "Conversations / Messages" write scope on your GHL Private Integration.')
      } else {
        setError(data.error || 'Failed to send.')
      }
    } catch (e) { setError(String(e)) }
    setSending(false)
  }

  const ChannelIcon = ({ channel }: { channel: string }) =>
    channel === 'Call' ? <Phone className="w-3 h-3" /> :
    channel === 'Email' ? <Mail className="w-3 h-3" /> :
    <MessageSquare className="w-3 h-3" />

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] text-slate-400">{messages.length} message{messages.length === 1 ? '' : 's'}</span>
        <div className="flex items-center gap-2">
          {ghlUrl && (
            <a href={ghlUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:text-blue-900">
              Open in GHL <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <button onClick={fetchThread} className="text-slate-400 hover:text-slate-600" title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Thread */}
      <div ref={scrollRef} className="border border-slate-200 rounded-lg bg-slate-50/60 max-h-96 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <p className="text-center text-xs text-slate-400 py-6">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-xs text-slate-400 py-6">{error || 'No messages yet.'}</p>
        ) : (
          messages.map((m, i) => {
            const mine = m.direction === 'outbound'
            const isCall = m.channel === 'Call' && !m.body
            if (isCall) {
              return (
                <div key={m.id || i} className="flex items-center justify-center gap-1.5 text-[10px] text-slate-400">
                  <Phone className="w-3 h-3" /> {mine ? 'Outbound call' : 'Inbound call'}{m.status ? ` · ${m.status}` : ''} · {fmtTime(m.at)}
                </div>
              )
            }
            return (
              <div key={m.id || i} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'}`}>
                  {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                  <p className={`text-[9px] mt-1 flex items-center gap-1 ${mine ? 'text-blue-100' : 'text-slate-400'}`}>
                    <ChannelIcon channel={m.channel} /> {fmtTime(m.at)}
                  </p>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Reply composer */}
      <div className="mt-3">
        {smsBlocked && (
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            🚫 {dndNote || 'Do Not Contact'} — texting is disabled for this borrower (opted out in GHL).
          </div>
        )}
        {/* Snippets — the team's real GHL snippets (22 per sub-account), too
            many for inline chips, so: a searchable list that inserts at the cursor. */}
        <div className="relative mb-2">
          <button onClick={() => setSnippetsOpen(o => !o)} disabled={smsBlocked || snippets.length === 0}
            title={snippets.length === 0 ? 'No snippets found for this sub-account' : 'Insert one of your GHL snippets'}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg px-2.5 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
            <FileText className="w-3.5 h-3.5" />
            Snippets{snippets.length > 0 && <span className="text-slate-400 tabular-nums">{snippets.length}</span>}
          </button>

          {snippetsOpen && (
            <div className="absolute z-20 mt-1 w-full sm:w-[28rem] bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
                <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <input autoFocus value={snippetQuery} onChange={e => setSnippetQuery(e.target.value)}
                  placeholder="Search snippets…"
                  className="flex-1 text-xs focus:outline-none placeholder:text-slate-400" />
                <button onClick={() => { setSnippetsOpen(false); setSnippetQuery('') }}
                  className="text-slate-400 hover:text-slate-600" title="Close">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
                {visibleSnippets.length === 0 ? (
                  <p className="text-xs text-slate-400 px-3 py-4 text-center">No snippet matches “{snippetQuery}”.</p>
                ) : visibleSnippets.map(s => (
                  <button key={s.id} onClick={() => insertSnippet(s)}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50">
                    <p className="text-xs font-semibold text-slate-800 truncate">{s.name}</p>
                    <p className="text-[11px] text-slate-500 line-clamp-2">{s.body}</p>
                    {s.hasAttachments && (
                      <p className="text-[10px] text-amber-700 mt-0.5">
                        has an attachment in GHL — text only will be sent
                      </p>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <textarea
          ref={draftRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={smsBlocked ? 'Texting disabled — Do Not Contact' : 'Type a text reply…'}
          rows={2}
          disabled={smsBlocked}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none disabled:bg-slate-50 disabled:text-slate-400"
        />
        {/* A snippet whose merge field we couldn't fill. GHL may or may not expand
            these on an API send — blocking here is how we avoid finding out live. */}
        {leftoverTokens.length > 0 && (
          <div className="mt-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            Fill in {leftoverTokens.map(t => <code key={t} className="font-mono bg-amber-100 rounded px-1 mx-0.5">{t}</code>)}
            {' '}before sending — we can’t resolve {leftoverTokens.length === 1 ? 'it' : 'them'} for this borrower.
          </div>
        )}
        {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <button onClick={send} disabled={!draft.trim() || sending || !locationId || smsBlocked || leftoverTokens.length > 0}
            className="flex items-center gap-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg px-3 py-1.5">
            <Send className="w-3.5 h-3.5" /> {sending ? 'Sending…' : 'Send text'}
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] text-slate-400">From:</span>
            {numbers.length > 0 ? (
              <select value={fromNumber} onChange={e => chooseNumber(e.target.value)}
                title="The line this text goes out on — remembered for next time"
                className={`text-[11px] border rounded-md px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                  fromNumber ? 'border-slate-200 text-slate-700' : 'border-amber-300 text-amber-800'}`}>
                {/* No silent fallback to someone else's line — if we can't tell which
                    number is theirs, the LO picks one. */}
                {!fromNumber && <option value="">Pick a number…</option>}
                {numbers.map(n => <option key={n.value} value={n.value}>{n.title} ({fmtPhone(n.value)})</option>)}
              </select>
            ) : (
              <span className="text-[11px] text-slate-400">—</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
