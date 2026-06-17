'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import {
  StickyNote, Plus, Trash2, Check, Loader2, Pin, Pencil,
  Bold, Highlighter, List, Heading1, Heading2, Heading3,
} from 'lucide-react'
import NoteMarkdown from '@/components/NoteMarkdown'
import { htmlToMarkdown, looksLikeHtml } from '@/lib/noteMarkdown'

type Note = {
  id: string
  title: string | null
  content: string          // note markdown (legacy notes hold contentEditable HTML; converted on load)
  color: string | null
  pinned: boolean
  updated_at: string
  created_at: string
}

// Color is now an accent only — the note background stays white.
const ACCENT: Record<string, string> = {
  amber:  'border-l-amber-400',
  blue:   'border-l-blue-400',
  green:  'border-l-emerald-400',
  pink:   'border-l-pink-400',
  purple: 'border-l-purple-400',
  slate:  'border-l-slate-300',
}
const DOT: Record<string, string> = {
  amber:  'bg-amber-400',
  blue:   'bg-blue-400',
  green:  'bg-emerald-400',
  pink:   'bg-pink-400',
  purple: 'bg-purple-400',
  slate:  'bg-slate-400',
}
const COLOR_KEYS = Object.keys(ACCENT)
const accentOf = (c: string | null) => ACCENT[c ?? 'amber'] ?? ACCENT.amber

function sortNotes(a: Note, b: Note): number {
  if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1
  return Date.parse(a.created_at) - Date.parse(b.created_at)
}

export default function NotesBoard() {
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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <StickyNote className="w-5 h-5 text-amber-500" /> Notes
        </h1>
        <button
          onClick={addNote}
          disabled={adding}
          className="flex items-center gap-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-2 disabled:opacity-50"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add note
        </button>
      </div>

      {/* Board */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : notes.length === 0 ? (
          <button
            onClick={addNote}
            className="w-full max-w-md mx-auto block border-2 border-dashed border-slate-200 rounded-xl py-10 text-sm text-slate-400 hover:border-blue-300 hover:text-blue-600 transition-colors"
          >
            + Add your first note
          </button>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
            {notes.map(n => (
              <NoteCard key={n.id} note={n} onPatch={patchNote} onDelete={deleteNote} />
            ))}
          </div>
        )}
      </div>
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
  // Legacy notes hold contentEditable HTML — convert to markdown for display/edit.
  // Non-destructive: the DB only changes to markdown when the user next saves.
  const md = useMemo(
    () => (looksLikeHtml(note.content) ? htmlToMarkdown(note.content) : (note.content ?? '')),
    [note.content],
  )

  const [title, setTitle] = useState(note.title ?? '')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(md)
  const [savedFlash, setSavedFlash] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  async function save(nextDraft = draft, nextTitle = title) {
    if (nextTitle === (note.title ?? '') && nextDraft === md) return
    await onPatch(note.id, { title: nextTitle.trim() || null, content: nextDraft })
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }

  function enterEdit() {
    setDraft(md)
    setEditing(true)
    requestAnimationFrame(() => taRef.current?.focus())
  }
  function done() {
    setEditing(false)
    void save()
  }

  // ── Toolbar edits (operate on the controlled textarea, restore selection) ──
  function applyEdit(transform: (value: string, s: number, e: number) => { value: string; selStart: number; selEnd: number }) {
    const ta = taRef.current
    if (!ta) return
    const r = transform(ta.value, ta.selectionStart, ta.selectionEnd)
    setDraft(r.value)
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.selStart, r.selEnd) })
  }
  const surround = (marker: string) => applyEdit((value, s, e) => {
    const sel = value.slice(s, e) || 'text'
    return {
      value: value.slice(0, s) + marker + sel + marker + value.slice(e),
      selStart: s + marker.length,
      selEnd: s + marker.length + sel.length,
    }
  })
  const prefixLine = (prefix: string) => applyEdit((value, s) => {
    const lineStart = value.lastIndexOf('\n', s - 1) + 1
    const cleaned = value.slice(lineStart).replace(/^(#{1,3}\s+|[-*]\s+)/, '')
    const pos = lineStart + prefix.length
    return { value: value.slice(0, lineStart) + prefix + cleaned, selStart: pos, selEnd: pos }
  })

  // onMouseDown+preventDefault keeps the textarea focus/selection while a toolbar
  // button is clicked (otherwise blur fires and closes the editor).
  const tb = (fn: () => void) => ({ onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); fn() } })
  const btn = 'w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:bg-white hover:text-slate-800'

  const updated = note.updated_at
    ? new Date(note.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <div className={`group relative bg-white border border-slate-200 border-l-4 ${accentOf(note.color)} rounded-xl p-4 shadow-sm`}>
      {/* Top row: pin + (hover) colors / edit / delete */}
      <div className="flex items-center justify-between mb-1.5">
        <button
          onClick={() => onPatch(note.id, { pinned: !note.pinned }, true)}
          title={note.pinned ? 'Unpin' : 'Pin to top'}
          className={`transition-colors ${note.pinned ? 'text-amber-600' : 'text-slate-300 hover:text-slate-500'}`}
        >
          <Pin className={`w-3.5 h-3.5 ${note.pinned ? 'fill-amber-500' : ''}`} />
        </button>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {COLOR_KEYS.map(key => (
              <button
                key={key}
                onClick={() => onPatch(note.id, { color: key })}
                title={key}
                className={`w-3.5 h-3.5 rounded-full ${DOT[key]} ring-offset-1 ${note.color === key || (!note.color && key === 'amber') ? 'ring-2 ring-slate-400' : 'hover:ring-2 hover:ring-slate-300'}`}
              />
            ))}
          </div>
          {editing ? (
            <button {...tb(done)} title="Done editing"
              className="flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md px-2 py-0.5">
              <Check className="w-3 h-3" /> Done
            </button>
          ) : (
            <button onClick={enterEdit} title="Edit note"
              className="text-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => { if (confirm('Delete this note?')) onDelete(note.id) }}
            className="text-slate-300 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Delete note"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Title */}
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={() => save()}
        placeholder="Title"
        className="w-full bg-transparent text-base font-bold text-slate-900 placeholder:text-slate-300 focus:outline-none mb-1.5"
      />

      {editing ? (
        <>
          {/* Markdown toolbar */}
          <div className="flex flex-wrap items-center gap-0.5 mb-2 border border-slate-200 rounded-lg p-1 bg-slate-50">
            <button {...tb(() => prefixLine('# '))} title="Heading 1" className={btn}><Heading1 className="w-4 h-4" /></button>
            <button {...tb(() => prefixLine('## '))} title="Heading 2" className={btn}><Heading2 className="w-4 h-4" /></button>
            <button {...tb(() => prefixLine('### '))} title="Heading 3" className={btn}><Heading3 className="w-4 h-4" /></button>
            <span className="w-px h-4 bg-slate-200 mx-1" />
            <button {...tb(() => surround('**'))} title="Bold" className={btn}><Bold className="w-4 h-4" /></button>
            <button {...tb(() => surround('=='))} title="Highlight" className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:bg-yellow-100 hover:text-slate-800"><Highlighter className="w-4 h-4" /></button>
            <button {...tb(() => prefixLine('- '))} title="Bullet list" className={btn}><List className="w-4 h-4" /></button>
          </div>

          <textarea
            ref={taRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={done}
            rows={Math.max(5, draft.split('\n').length + 1)}
            placeholder="Write in markdown — # heading, **bold**, ==highlight==, - bullet"
            className="w-full bg-white text-sm text-slate-800 border border-slate-200 rounded-lg p-2.5 leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-400 resize-y"
          />
        </>
      ) : (
        <button onClick={enterEdit} className="w-full text-left cursor-text min-h-[40px]" title="Click to edit">
          {md.trim()
            ? <NoteMarkdown md={md} />
            : <span className="text-sm text-slate-300">Click to write…</span>}
        </button>
      )}

      <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
        <span className="text-[10px] text-slate-400">
          {savedFlash
            ? <span className="text-emerald-600 flex items-center gap-0.5"><Check className="w-3 h-3" /> Saved</span>
            : updated ? `Updated ${updated}` : ''}
        </span>
      </div>
    </div>
  )
}
