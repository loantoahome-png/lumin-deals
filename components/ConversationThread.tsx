'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { RefreshCw, Send, Phone, MessageSquare, Mail, ExternalLink } from 'lucide-react'

type ThreadMessage = {
  id: string | null
  direction: 'inbound' | 'outbound'
  body: string
  channel: string
  status: string | null
  at: string | null
}
type PhoneNumber = { value: string; title: string }

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

const SNIPPETS = [
  "Hi! Just following up — let me know if you have any questions.",
  "Got it, thank you! I'll take care of it.",
  "What's a good time for a quick call?",
]

export default function ConversationThread({
  contactId, locationId, ghlUrl, loanOfficer, smsBlocked = false, dndNote,
}: {
  contactId: string
  locationId: string | null
  ghlUrl: string | null
  loanOfficer: string | null
  smsBlocked?: boolean          // contact is Do-Not-Contact for SMS — block the composer
  dndNote?: string | null       // label to show, e.g. "Do Not Contact" / "DND: SMS"
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [numbers, setNumbers] = useState<PhoneNumber[]>([])
  const [fromNumber, setFromNumber] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

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

  // Load the account's numbers once, default to the LO's own line.
  useEffect(() => {
    if (!locationId || numbers.length > 0) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/ghl/numbers?locationId=${locationId}`, { cache: 'no-store' })
        const data = await res.json() as { ok: boolean; numbers?: PhoneNumber[] }
        if (cancelled || !data.ok || !data.numbers) return
        setNumbers(data.numbers)
        const first = (loanOfficer || '').trim().split(/\s+/)[0].toLowerCase()
        const match = first ? data.numbers.find(n => n.title.toLowerCase().includes(first)) : undefined
        setFromNumber((match || data.numbers[0])?.value || '')
      } catch { /* non-fatal */ }
    })()
    return () => { cancelled = true }
  }, [locationId, numbers.length, loanOfficer])

  async function send() {
    if (!draft.trim() || sending || !locationId || smsBlocked) return
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
        <div className="flex flex-wrap gap-1.5 mb-2">
          {SNIPPETS.map((s, i) => (
            <button key={i} onClick={() => setDraft(s)} disabled={smsBlocked}
              className="text-[11px] text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-full px-2.5 py-1 text-left disabled:opacity-40 disabled:cursor-not-allowed">
              {s.length > 40 ? s.slice(0, 40) + '…' : s}
            </button>
          ))}
        </div>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={smsBlocked ? 'Texting disabled — Do Not Contact' : 'Type a text reply…'}
          rows={2}
          disabled={smsBlocked}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none disabled:bg-slate-50 disabled:text-slate-400"
        />
        {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <button onClick={send} disabled={!draft.trim() || sending || !locationId || smsBlocked}
            className="flex items-center gap-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg px-3 py-1.5">
            <Send className="w-3.5 h-3.5" /> {sending ? 'Sending…' : 'Send text'}
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] text-slate-400">From:</span>
            {numbers.length > 0 ? (
              <select value={fromNumber} onChange={e => setFromNumber(e.target.value)}
                className="text-[11px] border border-slate-200 rounded-md px-1.5 py-1 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500">
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
