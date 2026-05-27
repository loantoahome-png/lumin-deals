'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { RefreshCw, Inbox, ExternalLink, Phone, MessageSquare, Mail, Send, Check, Sparkles } from 'lucide-react'

type UnreadItem = {
  conversationId: string | null
  contactId: string | null
  locationId: string
  name: string
  unreadCount: number
  channel: string
  lastMessageAt: string | null
  preview: string
  account: string
  lo: string
  dealId: string | null
  dealStatus: string | null
  ghlUrl: string | null
  replyBlocked?: boolean
  dndNote?: string | null
}

const MS_PER_MIN = 60_000
function ago(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < MS_PER_MIN) return 'just now'
  const m = Math.floor(ms / MS_PER_MIN)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function fmtPhone(v: string): string {
  const d = v.replace(/\D/g, '').replace(/^1/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : v
}

function ChannelIcon({ channel }: { channel: string }) {
  if (channel === 'Call')  return <Phone className="w-4 h-4 text-emerald-600" />
  if (channel === 'Email') return <Mail className="w-4 h-4 text-violet-600" />
  return <MessageSquare className="w-4 h-4 text-blue-600" />
}

export default function UnreadPage() {
  const [items, setItems] = useState<UnreadItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loFilter, setLoFilter] = useState<'All' | 'Matt' | 'Moe'>('All')

  const fetchUnread = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/ghl/unread', { cache: 'no-store' })
      const data = await res.json() as { ok: boolean; items?: UnreadItem[]; error?: string }
      if (data.ok && data.items) setItems(data.items)
      else setError(data.error || 'Failed to load')
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchUnread() }, [fetchUnread])

  const filtered = useMemo(() => {
    if (loFilter === 'All') return items
    const q = loFilter.toLowerCase()
    return items.filter(i => (i.lo || '').toLowerCase().includes(q))
  }, [items, loFilter])

  const totalUnread = filtered.reduce((s, i) => s + i.unreadCount, 0)

  // After a successful reply, drop the conversation from the inbox (sending in
  // GHL marks it read). If GHL still has it unread, the next refresh re-adds it.
  function markSent(target: UnreadItem) {
    setItems(prev => prev.filter(i =>
      !(i.contactId === target.contactId && i.conversationId === target.conversationId)
    ))
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Inbox className="w-5 h-5 text-blue-500" />
              Unread Messages
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Every unread client message across both GHL accounts — all stages, live. Reply in GHL to clear it.
            </p>
          </div>
          <button onClick={fetchUnread} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="border border-slate-200 rounded-lg px-3 py-1.5 bg-white">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold leading-none mb-0.5">Conversations</p>
            <p className="text-sm font-bold text-slate-800 tabular-nums">{filtered.length}</p>
          </div>
          <div className="border border-red-200 bg-red-50 rounded-lg px-3 py-1.5">
            <p className="text-[10px] text-red-500 uppercase tracking-wider font-semibold leading-none mb-0.5">Unread messages</p>
            <p className="text-sm font-bold text-red-700 tabular-nums">{totalUnread}</p>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {(['All', 'Matt', 'Moe'] as const).map(opt => (
              <button
                key={opt}
                onClick={() => setLoFilter(opt)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  loFilter === opt ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-700 hover:border-slate-400'
                }`}
              >
                {opt === 'All' ? 'All LOs' : opt}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : error ? (
          <div className="bg-white border border-red-200 rounded-xl p-8 text-center">
            <p className="text-sm font-semibold text-red-700">Couldn&apos;t load unread messages</p>
            <p className="text-xs text-slate-500 mt-1">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
            <Inbox className="w-10 h-10 text-emerald-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-800">Inbox zero 🎉</p>
            <p className="text-xs text-slate-500 mt-1">No unread client messages right now.</p>
          </div>
        ) : (
          <div className="space-y-2 max-w-4xl">
            {filtered.map((it, idx) => (
              <UnreadRow key={it.conversationId || it.contactId || idx} item={it} onSent={() => markSent(it)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Canned quick replies — one tap to drop into the reply box.
const SNIPPETS = [
  "Hi! Thanks for reaching out — I'll take a look and get right back to you.",
  "Got it, thank you! I'll follow up shortly.",
  "What's a good time for a quick call today?",
  "Sending that over now — let me know if you have any questions!",
]

type PhoneNumber = { value: string; title: string }

function UnreadRow({ item, onSent }: { item: UnreadItem; onSent: () => void }) {
  const [replying, setReplying] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [numbers, setNumbers] = useState<PhoneNumber[]>([])
  const [fromNumber, setFromNumber] = useState('')
  const [aiBusy, setAiBusy] = useState<'draft' | 'summary' | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [marking, setMarking] = useState(false)

  async function markRead() {
    if (marking) return
    setMarking(true); setError(null)
    try {
      const res = await fetch('/api/ghl/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: item.conversationId,
          contactId: item.contactId,
          locationId: item.locationId,
          lastMessageAt: item.lastMessageAt,
        }),
      })
      const data = await res.json() as { ok: boolean; error?: string }
      if (data.ok) { onSent() }   // drop it from the inbox
      else { setError(data.error || 'Could not mark as read.'); setMarking(false) }
    } catch (e) { setError(String(e)); setMarking(false) }
  }

  async function aiCall(mode: 'draft' | 'summary') {
    setAiBusy(mode); setError(null)
    try {
      const res = await fetch('/api/ai/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, contactId: item.contactId, locationId: item.locationId, conversationId: item.conversationId, leadName: item.name }),
      })
      const data = await res.json() as { ok: boolean; draft?: string; summary?: string; error?: string }
      if (!data.ok) {
        setError(data.error === 'ANTHROPIC_API_KEY is not configured.'
          ? 'AI isn’t set up yet — add ANTHROPIC_API_KEY to enable drafts & summaries.'
          : (data.error || 'AI request failed.'))
      } else if (mode === 'draft' && data.draft) {
        setDraft(data.draft)
        setReplying(true)
      } else if (mode === 'summary' && data.summary) {
        setSummary(data.summary)
      }
    } catch (e) {
      setError(String(e))
    }
    setAiBusy(null)
  }

  // Load the account's numbers the first time the composer opens, and default
  // to the LO's own number (match by first name) so it's the right one.
  useEffect(() => {
    if (!replying || numbers.length > 0) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/ghl/numbers?locationId=${item.locationId}`, { cache: 'no-store' })
        const data = await res.json() as { ok: boolean; numbers?: PhoneNumber[] }
        if (cancelled || !data.ok || !data.numbers) return
        setNumbers(data.numbers)
        const first = (item.lo || '').trim().split(/\s+/)[0].toLowerCase()
        const match = first ? data.numbers.find(n => n.title.toLowerCase().includes(first)) : undefined
        setFromNumber((match || data.numbers[0])?.value || '')
      } catch { /* non-fatal — send will use GHL default */ }
    })()
    return () => { cancelled = true }
  }, [replying, numbers.length, item.locationId, item.lo])

  async function send() {
    if (!draft.trim() || sending || item.replyBlocked) return
    setSending(true); setError(null)
    try {
      const res = await fetch('/api/ghl/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: item.contactId, locationId: item.locationId, message: draft.trim(), fromNumber: fromNumber || undefined }),
      })
      const data = await res.json() as { ok: boolean; needsScope?: boolean; error?: string }
      if (data.ok) {
        setSent(true)
        setReplying(false)
        setTimeout(onSent, 1200)   // let them see the ✓ before it drops off
      } else if (data.needsScope) {
        setError('GHL hasn’t granted message-send access yet. Enable the "Conversations / Messages" write scope on your GHL Private Integration, then try again.')
      } else {
        setError(data.error || 'Failed to send. The contact may not have a textable phone number.')
      }
    } catch (e) {
      setError(String(e))
    }
    setSending(false)
  }

  return (
    <div className={`bg-white border rounded-xl px-4 py-3 transition-colors ${sent ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 hover:border-blue-200'}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0"><ChannelIcon channel={item.channel} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {item.dealId ? (
              <Link href={`/deals/${item.dealId}`} className="font-semibold text-slate-900 hover:text-blue-700 truncate">{item.name}</Link>
            ) : (
              <span className="font-semibold text-slate-900 truncate">{item.name}</span>
            )}
            <span className="text-[10px] font-bold text-red-700 bg-red-100 border border-red-200 rounded-full px-1.5 py-0.5 tabular-nums">
              {item.unreadCount} unread
            </span>
            {item.dealStatus && (
              <span className="text-[10px] font-medium text-slate-500 bg-slate-100 rounded-full px-1.5 py-0.5">{item.dealStatus}</span>
            )}
            {item.dndNote && (
              <span className="text-[10px] font-bold text-rose-700 bg-rose-100 border border-rose-300 rounded-full px-1.5 py-0.5" title="Do Not Contact — opted out in GHL">
                🚫 {item.dndNote}
              </span>
            )}
            <span className="text-[11px] text-slate-400">· {item.channel} · {ago(item.lastMessageAt)}</span>
          </div>
          {item.preview && <p className="text-sm text-slate-600 mt-1 line-clamp-2">{item.preview}</p>}
          <p className="text-[11px] text-slate-400 mt-1">{item.lo}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {sent ? (
            <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700"><Check className="w-3.5 h-3.5" /> Replied</span>
          ) : (
            <>
              <button onClick={markRead} disabled={marking}
                title="Mark this conversation as read (clears it from your inbox until a new message arrives)"
                className="flex items-center gap-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg px-2.5 py-1.5 disabled:opacity-50">
                <Check className="w-3.5 h-3.5" /> {marking ? '…' : 'Mark read'}
              </button>
              {item.replyBlocked ? (
                <span title="Do Not Contact for SMS — replying is disabled"
                  className="flex items-center gap-1 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 cursor-not-allowed">
                  🚫 No texting
                </span>
              ) : (
                <button onClick={() => setReplying(v => !v)}
                  className="flex items-center gap-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-1.5">
                  <MessageSquare className="w-3 h-3" /> {replying ? 'Close' : 'Reply'}
                </button>
              )}
              {item.ghlUrl && (
                <a href={item.ghlUrl} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-blue-700 border border-slate-200 rounded-lg px-2.5 py-1.5">
                  GHL <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </>
          )}
        </div>
      </div>

      {/* AI summary */}
      {summary && (
        <div className="mt-2 pl-7 flex items-start gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-violet-500 mt-0.5 shrink-0" />
          <p className="text-sm text-violet-900 bg-violet-50 border border-violet-100 rounded-lg px-2.5 py-1.5 flex-1">{summary}</p>
        </div>
      )}

      {/* AI / send error (visible even when composer is closed) */}
      {error && !replying && <p className="text-xs text-red-600 mt-2 pl-7">{error}</p>}

      {/* Inline reply composer */}
      {replying && !sent && (
        <div className="mt-3 pl-7">
          <div className="flex flex-wrap gap-1.5 mb-2">
            <button onClick={() => aiCall('draft')} disabled={aiBusy !== null}
              title="Let Claude draft a reply from the conversation"
              className="text-[11px] font-semibold text-violet-700 bg-violet-100 hover:bg-violet-200 border border-violet-200 rounded-full px-2.5 py-1 flex items-center gap-1 disabled:opacity-50">
              <Sparkles className="w-3 h-3" /> {aiBusy === 'draft' ? 'Drafting…' : 'Draft with AI'}
            </button>
            {SNIPPETS.map((s, i) => (
              <button key={i} onClick={() => setDraft(s)}
                className="text-[11px] text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-full px-2.5 py-1 text-left">
                {s.length > 38 ? s.slice(0, 38) + '…' : s}
              </button>
            ))}
          </div>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={`Text reply to ${item.name}…`}
            rows={3}
            autoFocus
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
          {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <button onClick={send} disabled={!draft.trim() || sending}
              className="flex items-center gap-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg px-3 py-1.5">
              <Send className="w-3.5 h-3.5" /> {sending ? 'Sending…' : 'Send text'}
            </button>
            <button onClick={() => { setReplying(false); setError(null) }} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[11px] text-slate-400">From:</span>
              {numbers.length > 0 ? (
                <select
                  value={fromNumber}
                  onChange={e => setFromNumber(e.target.value)}
                  className="text-[11px] border border-slate-200 rounded-md px-1.5 py-1 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  title="Which number this text sends from"
                >
                  {numbers.map(n => (
                    <option key={n.value} value={n.value}>{n.title} ({fmtPhone(n.value)})</option>
                  ))}
                </select>
              ) : (
                <span className="text-[11px] text-slate-400">loading…</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
