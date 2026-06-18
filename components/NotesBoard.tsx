'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import {
  StickyNote, Plus, Trash2, Check, Loader2, Pin, Pencil, Search, GripVertical,
  Bold, Highlighter, List, Heading1, Heading2, Heading3,
} from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import NoteMarkdown from '@/components/NoteMarkdown'
import { markdownToHtml, htmlToMarkdown, looksLikeHtml } from '@/lib/noteMarkdown'

type Note = {
  id: string
  title: string | null
  content: string          // note markdown (legacy notes hold contentEditable HTML; converted on load)
  color: string | null
  pinned: boolean
  updated_at: string
  created_at: string
}

// Color is an accent only — the note background stays white.
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

// Text size is PER-NOTE (px), adjustable 12–26 from each note's editor toolbar,
// persisted per browser keyed by note id (font size was never a DB value).
const FONT_MIN = 12
const FONT_MAX = 26
const FONT_DEFAULT = 15
const fontKey = (id: string) => `lumin:notes-fontsize:${id}`
const clampFont = (v: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v)))

async function saveOrder(ids: string[]) {
  try {
    await fetch('/api/notes/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
  } catch { /* non-fatal — order re-saves on the next reorder */ }
}

export default function NotesBoard() {
  const [notes, setNotes] = useState<Note[]>([])
  const [order, setOrder] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [notesRes, orderRes] = await Promise.all([
      supabase.from('dashboard_notes').select('id, title, content, color, pinned, updated_at, created_at'),
      fetch('/api/notes/order').then(r => r.json()).catch(() => ({ ids: [] })),
    ])
    if (!notesRes.error && notesRes.data) setNotes(notesRes.data as Note[])
    setOrder(Array.isArray(orderRes?.ids) ? orderRes.ids : [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Canonical arrangement: ids in the saved order first, then any notes not yet in
  // the order array (new ones), oldest first. Pinning moves a note to the front.
  const canonical = useMemo(() => {
    const byId = new Map(notes.map(n => [n.id, n]))
    const seen = new Set<string>()
    const out: Note[] = []
    for (const id of order) {
      const n = byId.get(id)
      if (n && !seen.has(id)) { out.push(n); seen.add(id) }
    }
    const rest = notes.filter(n => !seen.has(n.id))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    return [...out, ...rest]
  }, [notes, order])

  const display = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return canonical
    return canonical.filter(n => ((n.title ?? '') + ' ' + (n.content ?? '')).toLowerCase().includes(q))
  }, [canonical, search])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = canonical.map(n => n.id)
    const oldI = ids.indexOf(String(active.id))
    const newI = ids.indexOf(String(over.id))
    if (oldI < 0 || newI < 0) return
    const next = arrayMove(ids, oldI, newI)
    setOrder(next)
    void saveOrder(next)
  }

  async function addNote() {
    if (adding) return
    setAdding(true)
    const { data, error } = await supabase
      .from('dashboard_notes')
      .insert({ content: '', color: 'amber', pinned: false })
      .select('id, title, content, color, pinned, updated_at, created_at')
      .single()
    if (!error && data) {
      const n = data as Note
      setNotes(prev => [...prev, n])
      setOrder(prev => { const next = [...prev, n.id]; void saveOrder(next); return next })
    }
    setAdding(false)
  }

  async function deleteNote(id: string) {
    setNotes(prev => prev.filter(n => n.id !== id))
    setOrder(prev => { const next = prev.filter(x => x !== id); void saveOrder(next); return next })
    await supabase.from('dashboard_notes').delete().eq('id', id)
  }

  async function patchNote(id: string, fields: Partial<Note>) {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, ...fields } : n))
    await supabase.from('dashboard_notes')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
  }

  // Pin = mark + jump to the front of the arrangement (persisted). Unpin clears the mark.
  function togglePin(note: Note) {
    const next = !note.pinned
    void patchNote(note.id, { pinned: next })
    if (next) setOrder(prev => { const moved = [note.id, ...prev.filter(x => x !== note.id)]; void saveOrder(moved); return moved })
  }

  const canReorder = !search.trim()

  const grid = (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {display.map(n =>
        canReorder
          ? <SortableNote key={n.id} note={n} onPatch={patchNote} onDelete={deleteNote} onPin={togglePin} />
          : <NoteCard key={n.id} note={n} onPatch={patchNote} onDelete={deleteNote} onPin={togglePin} />,
      )}
    </div>
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0 flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <StickyNote className="w-5 h-5 text-amber-500" /> Notes
        </h1>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search notes…"
              className="w-52 pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={addNote}
            disabled={adding}
            className="flex items-center gap-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-2 disabled:opacity-50"
          >
            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add note
          </button>
        </div>
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
        ) : display.length === 0 ? (
          <p className="text-sm text-slate-400 px-1">No notes match “{search}”.</p>
        ) : canReorder ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={display.map(n => n.id)} strategy={rectSortingStrategy}>
              {grid}
            </SortableContext>
          </DndContext>
        ) : grid}
      </div>
    </div>
  )
}

function SortableNote(props: {
  note: Note
  onPatch: (id: string, fields: Partial<Note>) => Promise<void>
  onDelete: (id: string) => void
  onPin: (note: Note) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.note.id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.6 : 1,
  }
  const handle = (
    <button
      {...attributes}
      {...listeners}
      title="Drag to reorder"
      className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 touch-none"
    >
      <GripVertical className="w-4 h-4" />
    </button>
  )
  return (
    <div ref={setNodeRef} style={style}>
      <NoteCard {...props} handle={handle} />
    </div>
  )
}

function NoteCard({
  note, onPatch, onDelete, onPin, handle,
}: {
  note: Note
  onPatch: (id: string, fields: Partial<Note>) => Promise<void>
  onDelete: (id: string) => void
  onPin: (note: Note) => void
  handle?: React.ReactNode
}) {
  // Legacy notes hold contentEditable HTML — convert to markdown for display/edit.
  // Non-destructive: the DB only changes to markdown when the user next saves.
  const md = useMemo(
    () => (looksLikeHtml(note.content) ? htmlToMarkdown(note.content) : (note.content ?? '')),
    [note.content],
  )

  const [title, setTitle] = useState(note.title ?? '')
  const [editing, setEditing] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [fontSize, setFontSizeState] = useState(FONT_DEFAULT)
  const edRef = useRef<HTMLDivElement | null>(null)

  // Per-note font size — read once on mount, persisted per browser by note id.
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(fontKey(note.id)))
      if (v >= FONT_MIN && v <= FONT_MAX) setFontSizeState(v)
    } catch { /* ignore */ }
  }, [note.id])
  const setFontSize = (v: number) => {
    const clamped = clampFont(v)
    setFontSizeState(clamped)
    try { localStorage.setItem(fontKey(note.id), String(clamped)) } catch { /* ignore */ }
  }

  // Read the editor's HTML back as markdown (storage format stays markdown).
  const readDraft = () => (edRef.current ? htmlToMarkdown(edRef.current.innerHTML) : md)

  async function save(nextDraft: string, nextTitle = title) {
    if (nextTitle === (note.title ?? '') && nextDraft === md) return
    await onPatch(note.id, { title: nextTitle.trim() || null, content: nextDraft })
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }

  function enterEdit() {
    setEditing(true)
    requestAnimationFrame(() => {
      const ed = edRef.current
      if (!ed) return
      ed.innerHTML = markdownToHtml(md)             // seed WYSIWYG from stored markdown
      try { document.execCommand('styleWithCSS', false, 'false') } catch { /* ignore */ }
      ed.focus()
      // place caret at the end
      const sel = window.getSelection()
      if (sel) { const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r) }
    })
  }
  function done() {
    const next = readDraft()
    setEditing(false)
    void save(next)
  }

  // execCommand acts on the focused editor; keep the editor selection by preventing
  // the button's default focus-steal (onMouseDown preventDefault).
  const exec = (cmd: string, val?: string) => { try { document.execCommand(cmd, false, val) } catch { /* ignore */ }; edRef.current?.focus() }
  const tb = (fn: () => void) => ({ onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); fn() } })
  const btn = 'w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:bg-white hover:text-slate-800'

  const updated = note.updated_at
    ? new Date(note.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  // Uniform fixed height — long notes scroll internally rather than growing the card.
  return (
    <div className={`group relative flex flex-col h-[360px] bg-white border border-slate-200 border-l-4 ${accentOf(note.color)} rounded-xl shadow-sm overflow-hidden`}>
      {/* Header strip — title section, greyed to separate it from the white body */}
      <div className="bg-slate-50 border-b border-slate-200 px-4 pt-2.5 pb-2 shrink-0">
        {/* Top row: grip + pin + (hover) colors / edit / delete */}
        <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1">
          {handle}
          <button
            onClick={() => onPin(note)}
            title={note.pinned ? 'Unpin' : 'Pin to top'}
            className={`transition-colors ${note.pinned ? 'text-amber-600' : 'text-slate-300 hover:text-slate-500'}`}
          >
            <Pin className={`w-3.5 h-3.5 ${note.pinned ? 'fill-amber-500' : ''}`} />
          </button>
        </div>
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
          onBlur={() => save(editing ? readDraft() : md, title)}
          placeholder="Title"
          className="w-full bg-transparent text-base font-bold text-slate-900 placeholder:text-slate-300 focus:outline-none"
        />
      </div>

      {/* Body (white) */}
      <div className="flex-1 min-h-0 flex flex-col px-4 py-3">
        {/* Toolbar (edit mode) */}
        {editing && (
        <div className="flex flex-wrap items-center gap-0.5 mb-2 border border-slate-200 rounded-lg p-1 bg-slate-50 shrink-0">
          <button {...tb(() => exec('formatBlock', '<h1>'))} title="Heading 1" className={btn}><Heading1 className="w-4 h-4" /></button>
          <button {...tb(() => exec('formatBlock', '<h2>'))} title="Heading 2" className={btn}><Heading2 className="w-4 h-4" /></button>
          <button {...tb(() => exec('formatBlock', '<h3>'))} title="Heading 3" className={btn}><Heading3 className="w-4 h-4" /></button>
          <span className="w-px h-4 bg-slate-200 mx-1" />
          <button {...tb(() => exec('bold'))} title="Bold" className={btn}><Bold className="w-4 h-4" /></button>
          <button {...tb(() => exec('hiliteColor', '#fde68a'))} title="Highlight" className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:bg-yellow-100 hover:text-slate-800"><Highlighter className="w-4 h-4" /></button>
          <button {...tb(() => exec('insertUnorderedList'))} title="Bullet list" className={btn}><List className="w-4 h-4" /></button>
          {/* Per-note text size (12–26) */}
          <div className="flex items-center gap-0.5 ml-auto pl-1" title="Text size for this note">
            <button {...tb(() => setFontSize(fontSize - 1))} disabled={fontSize <= FONT_MIN}
              className={`${btn} disabled:opacity-30`}><span className="text-xs font-bold leading-none">A−</span></button>
            <span className="text-[11px] text-slate-500 tabular-nums w-6 text-center">{fontSize}</span>
            <button {...tb(() => setFontSize(fontSize + 1))} disabled={fontSize >= FONT_MAX}
              className={`${btn} disabled:opacity-30`}><span className="text-sm font-bold leading-none">A+</span></button>
          </div>
        </div>
      )}

      {/* Body — fixed-height card, this region scrolls. */}
      <div className="flex-1 min-h-0">
        {editing ? (
          <div
            ref={edRef}
            contentEditable
            suppressContentEditableWarning
            onBlur={done}
            data-placeholder="Write your note…"
            style={{ fontSize: `${fontSize}px` }}
            className="w-full h-full bg-white text-slate-800 border border-slate-200 rounded-lg p-2.5 leading-relaxed overflow-y-auto focus:outline-none focus:ring-2 focus:ring-blue-400 break-words
              [&_h1]:text-[1.5em] [&_h1]:font-bold [&_h1]:my-1
              [&_h2]:text-[1.25em] [&_h2]:font-semibold [&_h2]:my-1
              [&_h3]:text-[1.1em] [&_h3]:font-semibold [&_h3]:my-1
              [&_b]:font-bold [&_strong]:font-bold
              [&_mark]:bg-yellow-200 [&_mark]:rounded [&_mark]:px-0.5
              [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1
              [&:empty]:before:content-[attr(data-placeholder)] [&:empty]:before:text-slate-300"
          />
        ) : (
          <div className="h-full overflow-y-auto pr-1" style={{ fontSize: `${fontSize}px` }}>
            {md.trim()
              ? <NoteMarkdown md={md} />
              : <span className="text-slate-300">Empty — click the pencil to edit</span>}
          </div>
        )}
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-slate-100 shrink-0">
        <span className="text-[10px] text-slate-400">
          {savedFlash
            ? <span className="text-emerald-600 flex items-center gap-0.5"><Check className="w-3 h-3" /> Saved</span>
            : updated ? `Updated ${updated}` : ''}
        </span>
      </div>
    </div>
  )
}
