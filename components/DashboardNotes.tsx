'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { StickyNote, Plus, Trash2, Check, Loader2, Pin } from 'lucide-react'

type Note = {
  id: string
  title: string | null
  content: string
  color: string | null
  pinned: boolean
  updated_at: string
  created_at: string
}

// Static Tailwind classes per color (Tailwind can't build dynamic class names).
const COLORS: Record<string, { bg: string; border: string; dot: string }> = {
  amber:  { bg: 'bg-amber-50/70',   border: 'border-amber-200',   dot: 'bg-amber-400' },
  blue:   { bg: 'bg-blue-50/70',    border: 'border-blue-200',    dot: 'bg-blue-400' },
  green:  { bg: 'bg-emerald-50/70', border: 'border-emerald-200', dot: 'bg-emerald-400' },
  pink:   { bg: 'bg-pink-50/70',    border: 'border-pink-200',    dot: 'bg-pink-400' },
  purple: { bg: 'bg-purple-50/70',  border: 'border-purple-200',  dot: 'bg-purple-400' },
  slate:  { bg: 'bg-slate-50',      border: 'border-slate-200',   dot: 'bg-slate-400' },
}
const COLOR_KEYS = Object.keys(COLORS)
const colorOf = (c: string | null) => COLORS[c ?? 'amber'] ?? COLORS.amber

// Pinned first, then newest-created last (stable, chronological within groups).
function sortNotes(a: Note, b: Note): number {
  if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1
  return Date.parse(a.created_at) - Date.parse(b.created_at)
}

export default function DashboardNotes() {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('dashboard_notes')
      .select('id, title, content, color, pinned, updated_at, created_at')
    if (!error && data) setNotes((data as Note[]).sort(sortNotes))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function addNote() {
    if (adding) return
    setAdding(true)
    const { data, error } = await supabase
      .from('dashboard_notes')
      .insert({ content: '', color: 'amber', pinned: false })
      .select('id, title, content, color, pinned, updated_at, created_at')
      .single()
    if (!error && data) setNotes(prev => [...prev, data as Note].sort(sortNotes))
    setAdding(false)
  }

  async function deleteNote(id: string) {
    setNotes(prev => prev.filter(n => n.id !== id))
    await supabase.from('dashboard_notes').delete().eq('id', id)
  }

  // Persist a partial change and resort locally (for pin/color toggles).
  async function patchNote(id: string, fields: Partial<Note>, resort = false) {
    setNotes(prev => {
      const next = prev.map(n => n.id === id ? { ...n, ...fields } : n)
      return resort ? [...next].sort(sortNotes) : next
    })
    await supabase.from('dashboard_notes')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-slate-900 flex items-center gap-2">
          <StickyNote className="w-4 h-4 text-amber-500" /> Notes
        </h2>
        <button
          onClick={addNote}
          disabled={adding}
          className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg px-2.5 py-1.5 disabled:opacity-50"
        >
          {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Add note
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : notes.length === 0 ? (
        <button
          onClick={addNote}
          className="w-full border-2 border-dashed border-slate-200 rounded-xl py-8 text-sm text-slate-400 hover:border-amber-300 hover:text-amber-600 transition-colors"
        >
          + Add your first note
        </button>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {notes.map(n => (
            <NoteCard key={n.id} note={n} onPatch={patchNote} onDelete={deleteNote} />
          ))}
        </div>
      )}
    </div>
  )
}

function NoteCard({
  note, onPatch, onDelete,
}: {
  note: Note
  onPatch: (id: string, fields: Partial<Note>, resort?: boolean) => Promise<void>
  onDelete: (id: string) => void
}) {
  const [title, setTitle] = useState(note.title ?? '')
  const [content, setContent] = useState(note.content ?? '')
  const [savedFlash, setSavedFlash] = useState(false)
  const c = colorOf(note.color)

  // Keep local fields in sync if the note object changes underneath (resort).
  useEffect(() => { setTitle(note.title ?? '') }, [note.title])
  useEffect(() => { setContent(note.content ?? '') }, [note.content])

  async function saveText() {
    if (title === (note.title ?? '') && content === (note.content ?? '')) return
    await onPatch(note.id, { title: title.trim() || null, content })
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }

  const updated = note.updated_at
    ? new Date(note.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <div className={`group relative border rounded-xl p-3 flex flex-col ${c.bg} ${c.border}`}>
      {/* Top row: pin + color picker */}
      <div className="flex items-center justify-between mb-1.5">
        <button
          onClick={() => onPatch(note.id, { pinned: !note.pinned }, true)}
          title={note.pinned ? 'Unpin' : 'Pin to top'}
          className={`transition-colors ${note.pinned ? 'text-amber-600' : 'text-slate-300 hover:text-slate-500'}`}
        >
          <Pin className={`w-3.5 h-3.5 ${note.pinned ? 'fill-amber-500' : ''}`} />
        </button>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {COLOR_KEYS.map(k => (
            <button
              key={k}
              onClick={() => onPatch(note.id, { color: k })}
              title={k}
              className={`w-3.5 h-3.5 rounded-full ${COLORS[k].dot} ring-offset-1 ${note.color === k || (!note.color && k === 'amber') ? 'ring-2 ring-slate-400' : 'hover:ring-2 hover:ring-slate-300'}`}
            />
          ))}
        </div>
      </div>

      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={saveText}
        placeholder="Title"
        className="w-full bg-transparent text-sm font-semibold text-slate-900 placeholder:text-slate-400/60 focus:outline-none mb-1"
      />
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        onBlur={saveText}
        placeholder="Type a note…"
        rows={4}
        className="w-full bg-transparent resize-none text-sm text-slate-800 placeholder:text-slate-400/60 focus:outline-none"
      />

      <div className="flex items-center justify-between mt-2 pt-2 border-t border-black/5">
        <span className="text-[10px] text-slate-500/70">
          {savedFlash
            ? <span className="text-emerald-600 flex items-center gap-0.5"><Check className="w-3 h-3" /> Saved</span>
            : updated ? `Updated ${updated}` : ''}
        </span>
        <button
          onClick={() => { if (confirm('Delete this note?')) onDelete(note.id) }}
          className="text-slate-400/60 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Delete note"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
