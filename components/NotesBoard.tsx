'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '@/lib/supabase'
import {
  StickyNote, Plus, Trash2, Check, Loader2, Pin, Search, GripVertical, X, Pencil,
  Bold, Highlighter, List, Heading1, Heading2, Heading3,
} from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { markdownToHtml, htmlToMarkdown, looksLikeHtml } from '@/lib/noteMarkdown'
import NoteMarkdown from '@/components/NoteMarkdown'

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

// Text size is PER-NOTE (px), adjustable 12–26 from the editor toolbar,
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

export default function NotesBoard({ embedded = false }: { embedded?: boolean } = {}) {
  const [notes, setNotes] = useState<Note[]>([])
  const [order, setOrder] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)   // note open in the pop-out editor

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

  const editingNote = editingId ? (notes.find(n => n.id === editingId) ?? null) : null

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
      setEditingId(n.id)   // open the pop-out editor on the new note right away
    }
    setAdding(false)
  }

  async function deleteNote(id: string) {
    setNotes(prev => prev.filter(n => n.id !== id))
    setOrder(prev => { const next = prev.filter(x => x !== id); void saveOrder(next); return next })
    await supabase.from('dashboard_notes').delete().eq('id', id)
  }

  async function patchNote(id: string, fields: Partial<Note>) {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, ...fields, updated_at: new Date().toISOString() } : n))
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

  const list = (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
      {display.map(n =>
        canReorder
          ? <SortableNoteRow key={n.id} note={n} onOpen={setEditingId} onDelete={deleteNote} onPin={togglePin} />
          : <NoteRow key={n.id} note={n} onOpen={setEditingId} onDelete={deleteNote} onPin={togglePin} />,
      )}
    </div>
  )

  return (
    <div className={embedded ? 'max-w-6xl mx-auto w-full' : 'flex flex-col h-full'}>
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0 flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <StickyNote className="w-5 h-5 text-amber-500" /> {embedded ? 'Bulletin' : 'Notes'}
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

      {/* Board — a long list (title + snippet); click a row to pop out the editor */}
      <div className={embedded ? 'p-6' : 'flex-1 overflow-auto p-6'}>
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
              {list}
            </SortableContext>
          </DndContext>
        ) : list}
      </div>

      {/* Pop-out editor */}
      {editingNote && (
        <NoteEditorModal
          key={editingNote.id}
          note={editingNote}
          onPatch={patchNote}
          onDelete={deleteNote}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  )
}

function SortableNoteRow(props: {
  note: Note
  onOpen: (id: string) => void
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
      onClick={e => e.stopPropagation()}
      title="Drag to reorder"
      className="shrink-0 cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 touch-none"
    >
      <GripVertical className="w-4 h-4" />
    </button>
  )
  return (
    <div ref={setNodeRef} style={style} className="h-full">
      <NoteRow {...props} handle={handle} />
    </div>
  )
}

function NoteRow({
  note, onOpen, onDelete, onPin, handle,
}: {
  note: Note
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onPin: (note: Note) => void
  handle?: React.ReactNode
}) {
  const md = useMemo(
    () => (looksLikeHtml(note.content) ? htmlToMarkdown(note.content) : (note.content ?? '')),
    [note.content],
  )
  const hasBody = md.trim().length > 0
  const updated = note.updated_at
    ? new Date(note.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''
  const open = () => onOpen(note.id)

  // The whole card is the click target (opens the editor). Inner buttons
  // stopPropagation; the rendered preview is pointer-events-none so its links
  // don't swallow the click.
  return (
    <div
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); open() } }}
      title="Click to open & edit"
      className={`group h-full flex flex-col rounded-xl border bg-white overflow-hidden cursor-pointer transition hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${note.pinned ? 'border-amber-300 ring-1 ring-amber-200' : 'border-slate-200 hover:border-blue-300'}`}
    >
      {/* Color bar — the at-a-glance signal (replaces the old thin left edge) */}
      <div className={`h-1.5 w-full shrink-0 ${DOT[note.color ?? 'amber'] ?? DOT.amber}`} />

      <div className="flex flex-col gap-1.5 p-3.5 flex-1 min-h-0">
        {/* Pin state + hover actions */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={e => { e.stopPropagation(); onPin(note) }}
            title={note.pinned ? 'Unpin' : 'Pin to top'}
            className={`shrink-0 transition-colors ${note.pinned ? 'text-amber-600' : 'text-slate-300 hover:text-slate-500'}`}
          >
            <Pin className={`w-3.5 h-3.5 ${note.pinned ? 'fill-amber-500' : ''}`} />
          </button>
          {note.pinned && <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600">Pinned</span>}
          <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {handle}
            <button
              onClick={e => { e.stopPropagation(); if (confirm('Delete this note?')) onDelete(note.id) }}
              className="p-1 text-slate-300 hover:text-red-500"
              title="Delete note"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Title + inline content preview (rendered markdown, clipped) */}
        <div className="flex flex-col gap-1 min-h-0">
          <div className="text-sm font-semibold text-slate-900 line-clamp-2 break-words">
            {note.title?.trim() || 'Untitled note'}
          </div>
          {hasBody ? (
            <div className="pointer-events-none text-xs leading-relaxed text-slate-600 max-h-[8.5rem] overflow-hidden break-words">
              <NoteMarkdown md={md} />
            </div>
          ) : (
            <div className="text-xs italic text-slate-300">Empty — click to write</div>
          )}
          {updated && <div className="text-[10px] text-slate-400 mt-0.5">Updated {updated}</div>}
        </div>
      </div>
    </div>
  )
}

// ── Pop-out editor (modal) ───────────────────────────────────────────────────
// Always in edit mode — the whole WYSIWYG opens when a row is clicked. Storage
// stays markdown (seed from markdownToHtml, read back via htmlToMarkdown).
function NoteEditorModal({
  note, onPatch, onDelete, onClose,
}: {
  note: Note
  onPatch: (id: string, fields: Partial<Note>) => Promise<void>
  onDelete: (id: string) => void
  onClose: () => void
}) {
  // Legacy notes hold contentEditable HTML — convert to markdown for view/seed.
  const initialMd = useMemo(
    () => (looksLikeHtml(note.content) ? htmlToMarkdown(note.content) : (note.content ?? '')),
    [note.content],
  )
  const [viewMd, setViewMd] = useState(initialMd)
  const [title, setTitle] = useState(note.title ?? '')
  // Open in VIEW (read-only) by default; a brand-new empty note jumps to edit.
  const [mode, setMode] = useState<'view' | 'edit'>(
    () => (initialMd.trim() === '' && !(note.title ?? '').trim()) ? 'edit' : 'view',
  )
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

  // Seed the WYSIWYG from markdown whenever we ENTER edit mode; focus + caret-to-end.
  useEffect(() => {
    if (mode !== 'edit') return
    const ed = edRef.current
    if (!ed) return
    ed.innerHTML = markdownToHtml(viewMd)
    try { document.execCommand('styleWithCSS', false, 'false') } catch { /* ignore */ }
    ed.focus()
    const sel = window.getSelection()
    if (sel) { const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const readDraft = () => (edRef.current ? htmlToMarkdown(edRef.current.innerHTML) : viewMd)
  const enterEdit = () => setMode('edit')

  // Done editing → save (if changed) and drop back to VIEW.
  function done() {
    const draft = readDraft()
    const nextTitle = title.trim() || null
    if (draft !== viewMd || nextTitle !== (note.title || null)) {
      void onPatch(note.id, { title: nextTitle, content: draft })
    }
    setViewMd(draft)
    setMode('view')
  }

  // Close the modal. If mid-edit, save the draft first.
  const close = useCallback(() => {
    if (mode === 'edit') {
      const draft = edRef.current ? htmlToMarkdown(edRef.current.innerHTML) : viewMd
      const nextTitle = title.trim() || null
      if (draft !== viewMd || nextTitle !== (note.title || null)) {
        void onPatch(note.id, { title: nextTitle, content: draft })
      }
    }
    onClose()
  }, [mode, viewMd, title, note.id, note.title, onPatch, onClose])

  // Esc closes (and saves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  // execCommand acts on the focused editor; keep the editor selection by preventing
  // the button's default focus-steal (onMouseDown preventDefault).
  const exec = (cmd: string, val?: string) => { try { document.execCommand(cmd, false, val) } catch { /* ignore */ }; edRef.current?.focus() }
  const tb = (fn: () => void) => ({ onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); fn() } })

  // Highlight TOGGLE — wraps the selection in <mark>; clicking again unwraps it.
  function toggleHighlight() {
    const ed = edRef.current
    const sel = window.getSelection()
    if (!ed || !sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const unwrap = (el: Element) => {
      const p = el.parentNode
      if (!p) return
      while (el.firstChild) p.insertBefore(el.firstChild, el)
      p.removeChild(el)
    }
    const ancestorHilite = (node: Node | null): Element | null => {
      let n: Node | null = node
      while (n && n !== ed) {
        if (n.nodeType === 1) {
          const el = n as Element
          if (el.tagName === 'MARK' || /background/i.test(el.getAttribute('style') || '')) return el
        }
        n = n.parentNode
      }
      return null
    }
    if (range.collapsed) {
      const h = ancestorHilite(sel.anchorNode)
      if (h) { unwrap(h); ed.normalize() }
      ed.focus()
      return
    }
    const hits = Array.from(ed.querySelectorAll('mark, span[style*="background"], font[style*="background"]'))
      .filter(el => range.intersectsNode(el))
    if (hits.length) {
      hits.forEach(unwrap)
      ed.normalize()
    } else {
      const mark = document.createElement('mark')
      try { range.surroundContents(mark) }
      catch { mark.appendChild(range.extractContents()); range.insertNode(mark) }
      sel.removeAllRanges()
      const r = document.createRange()
      r.selectNodeContents(mark)
      sel.addRange(r)
    }
    ed.focus()
  }
  const btn = 'w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:bg-white hover:text-slate-800'

  const updated = note.updated_at
    ? new Date(note.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
      onMouseDown={e => { if (e.target === e.currentTarget) close() }}
    >
      <div className={`w-full max-w-2xl max-h-[88vh] flex flex-col bg-white border border-slate-200 border-l-4 ${accentOf(note.color)} rounded-2xl shadow-2xl overflow-hidden`}>
        {/* Header: colors (edit) / "Viewing" (view) + delete + close */}
        <div className="flex items-center justify-between gap-2 px-5 pt-3.5 pb-2.5 border-b border-slate-100">
          <div className="flex items-center gap-1.5">
            {mode === 'edit' ? COLOR_KEYS.map(key => (
              <button
                key={key}
                onClick={() => onPatch(note.id, { color: key })}
                title={key}
                className={`w-4 h-4 rounded-full ${DOT[key]} ring-offset-1 ${note.color === key || (!note.color && key === 'amber') ? 'ring-2 ring-slate-400' : 'hover:ring-2 hover:ring-slate-300'}`}
              />
            )) : (
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Viewing</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => { if (confirm('Delete this note?')) { onDelete(note.id); onClose() } }}
              className="p-1.5 text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50"
              title="Delete note"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button onClick={close} className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100" title="Close (saves)">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Title */}
        {mode === 'edit' ? (
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Title"
            className="px-5 pt-3 pb-1 bg-transparent text-xl font-bold text-slate-900 placeholder:text-slate-300 focus:outline-none shrink-0"
          />
        ) : (
          <h2 className="px-5 pt-3 pb-1 text-xl font-bold text-slate-900 break-words shrink-0">{title.trim() || 'Untitled note'}</h2>
        )}

        {/* Toolbar — edit mode only */}
        {mode === 'edit' && (
        <div className="flex flex-wrap items-center gap-0.5 mx-5 my-2 border border-slate-200 rounded-lg p-1 bg-slate-50 shrink-0">
          <button {...tb(() => exec('formatBlock', '<h1>'))} title="Heading 1" className={btn}><Heading1 className="w-4 h-4" /></button>
          <button {...tb(() => exec('formatBlock', '<h2>'))} title="Heading 2" className={btn}><Heading2 className="w-4 h-4" /></button>
          <button {...tb(() => exec('formatBlock', '<h3>'))} title="Heading 3" className={btn}><Heading3 className="w-4 h-4" /></button>
          <span className="w-px h-4 bg-slate-200 mx-1" />
          <button {...tb(() => exec('bold'))} title="Bold" className={btn}><Bold className="w-4 h-4" /></button>
          <button {...tb(toggleHighlight)} title="Highlight / remove highlight" className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:bg-yellow-100 hover:text-slate-800"><Highlighter className="w-4 h-4" /></button>
          <button {...tb(() => exec('insertUnorderedList'))} title="Bullet list" className={btn}><List className="w-4 h-4" /></button>
          <div className="flex items-center gap-0.5 ml-auto pl-1" title="Text size for this note">
            <button {...tb(() => setFontSize(fontSize - 1))} disabled={fontSize <= FONT_MIN}
              className={`${btn} disabled:opacity-30`}><span className="text-xs font-bold leading-none">A−</span></button>
            <span className="text-[11px] text-slate-500 tabular-nums w-6 text-center">{fontSize}</span>
            <button {...tb(() => setFontSize(fontSize + 1))} disabled={fontSize >= FONT_MAX}
              className={`${btn} disabled:opacity-30`}><span className="text-sm font-bold leading-none">A+</span></button>
          </div>
        </div>
        )}

        {/* Body — view renders the note; edit shows the WYSIWYG */}
        <div className="flex-1 min-h-0 px-5 pb-4">
          {mode === 'edit' ? (
            <div
              key="note-edit"
              ref={edRef}
              contentEditable
              suppressContentEditableWarning
              data-placeholder="Write your note…"
              style={{ fontSize: `${fontSize}px` }}
              className="w-full h-full min-h-[40vh] bg-white text-slate-800 border border-slate-200 rounded-lg p-3 leading-relaxed overflow-y-auto focus:outline-none focus:ring-2 focus:ring-blue-400 break-words
                [&_h1]:text-[1.5em] [&_h1]:font-bold [&_h1]:my-1
                [&_h2]:text-[1.25em] [&_h2]:font-semibold [&_h2]:my-1
                [&_h3]:text-[1.1em] [&_h3]:font-semibold [&_h3]:my-1
                [&_b]:font-bold [&_strong]:font-bold
                [&_mark]:bg-yellow-200 [&_mark]:rounded [&_mark]:px-0.5
                [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1
                [&:empty]:before:content-[attr(data-placeholder)] [&:empty]:before:text-slate-300"
            />
          ) : (
            <div key="note-view" className="w-full h-full min-h-[40vh] overflow-y-auto pr-1 text-slate-800" style={{ fontSize: `${fontSize}px` }}>
              {viewMd.trim()
                ? <NoteMarkdown md={viewMd} />
                : <span className="italic text-slate-300">Empty — click Edit to write.</span>}
            </div>
          )}
        </div>

        {/* Footer — Edit (view) / Done (edit) */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 shrink-0">
          <span className="text-[11px] text-slate-400">{updated ? `Updated ${updated}` : 'New note'}</span>
          {mode === 'edit' ? (
            <button
              onClick={done}
              className="flex items-center gap-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-1.5"
            >
              <Check className="w-4 h-4" /> Done
            </button>
          ) : (
            <button
              onClick={enterEdit}
              className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 bg-white border border-slate-300 hover:border-blue-400 hover:text-blue-700 rounded-lg px-4 py-1.5"
            >
              <Pencil className="w-4 h-4" /> Edit
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
