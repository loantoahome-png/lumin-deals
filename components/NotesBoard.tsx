'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '@/lib/supabase'
import {
  StickyNote, Plus, Trash2, Check, Loader2, Pin, Search, GripVertical, X, Pencil,
} from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { markdownToHtml, looksLikeHtml } from '@/lib/noteMarkdown'
import NoteContent from '@/components/NoteContent'
import RichTextEditor from '@/components/RichTextEditor'

type Note = {
  id: string
  title: string | null
  content: string          // note markdown (legacy notes hold contentEditable HTML; converted on load)
  color: string | null
  pinned: boolean
  updated_at: string
  created_at: string
}

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
    <div className="grid gap-4 items-start [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]">
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
    <div ref={setNodeRef} style={style}>
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
  const hasBody = !!note.content && note.content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0
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
      className={`group relative flex flex-col rounded-xl border bg-white overflow-hidden cursor-pointer transition hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${note.pinned ? 'border-amber-200' : 'border-slate-200 hover:border-slate-300'}`}
    >
      {/* Header — title in a colored band so it clearly stands out */}
      <div className={`flex items-start gap-2 px-4 py-3 border-b ${note.pinned ? 'bg-amber-50 border-amber-100' : 'bg-blue-50 border-blue-100'}`}>
        {note.pinned && <Pin className="w-4 h-4 mt-0.5 shrink-0 fill-amber-500 text-amber-600" />}
        <h3 className={`text-[16px] font-bold leading-snug line-clamp-2 break-words ${note.pinned ? 'text-amber-800' : 'text-blue-800'}`}>
          {note.title?.trim() || 'Untitled note'}
        </h3>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-1.5 px-4 py-3 min-h-0">
        {hasBody ? (
          <div className="pointer-events-none text-[13px] max-h-[8.5rem] overflow-hidden break-words">
            <NoteContent content={note.content} />
          </div>
        ) : (
          <div className="text-[13px] italic text-slate-300">Empty — click to write</div>
        )}
        {updated && <div className="text-[11px] text-slate-400">Updated {updated}</div>}
      </div>

      {/* Hover actions — float top-right so the body stays clean */}
      <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-white/95 rounded-lg p-0.5 shadow-sm">
        <button
          onClick={e => { e.stopPropagation(); onPin(note) }}
          title={note.pinned ? 'Unpin' : 'Pin to top'}
          className="p-1 rounded hover:bg-slate-100"
        >
          <Pin className={`w-3.5 h-3.5 ${note.pinned ? 'fill-amber-500 text-amber-600' : 'text-slate-400'}`} />
        </button>
        {handle}
        <button
          onClick={e => { e.stopPropagation(); if (confirm('Delete this note?')) onDelete(note.id) }}
          title="Delete note"
          className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

// ── Pop-out editor (modal) ───────────────────────────────────────────────────
// View (read-only) by default with an Edit button; edit mode mounts the TipTap
// rich-text editor. Notes store HTML; legacy markdown notes convert on seed.
function NoteEditorModal({
  note, onPatch, onDelete, onClose,
}: {
  note: Note
  onPatch: (id: string, fields: Partial<Note>) => Promise<void>
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const initialHtml = useMemo(
    () => (looksLikeHtml(note.content) ? note.content : markdownToHtml(note.content ?? '')),
    [note.content],
  )
  const isEmptyHtml = (h: string) => h.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === ''
  const [savedHtml, setSavedHtml] = useState(initialHtml)
  const [title, setTitle] = useState(note.title ?? '')
  const draftRef = useRef(initialHtml)
  // Open in VIEW by default; a brand-new empty note jumps straight to edit.
  const [mode, setMode] = useState<'view' | 'edit'>(
    () => (isEmptyHtml(initialHtml) && !(note.title ?? '').trim()) ? 'edit' : 'view',
  )

  const enterEdit = () => { draftRef.current = savedHtml; setMode('edit') }

  const saveIfChanged = useCallback(() => {
    const draft = draftRef.current
    const nextTitle = title.trim() || null
    if (draft !== savedHtml || nextTitle !== (note.title || null)) {
      void onPatch(note.id, { title: nextTitle, content: draft })
    }
    return draft
  }, [savedHtml, title, note.id, note.title, onPatch])

  // Done editing → save (if changed) and drop back to VIEW.
  function done() {
    const draft = saveIfChanged()
    setSavedHtml(draft)
    setMode('view')
  }

  // Close the modal. If mid-edit, save the draft first.
  const close = useCallback(() => {
    if (mode === 'edit') saveIfChanged()
    onClose()
  }, [mode, saveIfChanged, onClose])

  // Esc closes (and saves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  const updated = note.updated_at
    ? new Date(note.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
      onMouseDown={e => { if (e.target === e.currentTarget) close() }}
    >
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header: mode label + delete + close */}
        <div className="flex items-center justify-between gap-2 px-5 pt-3.5 pb-2.5 border-b border-slate-100">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
            {mode === 'edit' ? 'Editing' : 'Viewing'}
          </span>
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

        {/* Body — view renders the note; edit shows the TipTap editor */}
        <div className="flex-1 min-h-0 px-5 pb-4 flex flex-col">
          {mode === 'edit' ? (
            <RichTextEditor initialHtml={savedHtml} autofocus onChange={html => { draftRef.current = html }} />
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              {isEmptyHtml(savedHtml)
                ? <span className="text-[15px] italic text-slate-300">Empty — click Edit to write.</span>
                : <NoteContent content={savedHtml} className="text-[15px]" />}
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
