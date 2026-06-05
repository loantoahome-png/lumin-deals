'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { StickyNote, Plus, Trash2, Check, Loader2 } from 'lucide-react'

type Note = {
  id: string
  content: string
  updated_at: string
  created_at: string
}

export default function DashboardNotes() {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('dashboard_notes')
      .select('id, content, updated_at, created_at')
      .order('created_at', { ascending: true })
    if (!error && data) setNotes(data as Note[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function addNote() {
    if (adding) return
    setAdding(true)
    const { data, error } = await supabase
      .from('dashboard_notes')
      .insert({ content: '' })
      .select('id, content, updated_at, created_at')
      .single()
    if (!error && data) setNotes(prev => [...prev, data as Note])
    setAdding(false)
  }

  async function deleteNote(id: string) {
    setNotes(prev => prev.filter(n => n.id !== id))   // optimistic
    await supabase.from('dashboard_notes').delete().eq('id', id)
  }

  function patchLocal(id: string, content: string) {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, content } : n))
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
            <NoteCard key={n.id} note={n} onChange={patchLocal} onDelete={deleteNote} />
          ))}
        </div>
      )}
    </div>
  )
}

function NoteCard({
  note, onChange, onDelete,
}: {
  note: Note
  onChange: (id: string, content: string) => void
  onDelete: (id: string) => void
}) {
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [dirty, setDirty] = useState(false)

  async function save() {
    if (!dirty) return
    setSaving(true)
    const { error } = await supabase
      .from('dashboard_notes')
      .update({ content: note.content, updated_at: new Date().toISOString() })
      .eq('id', note.id)
    setSaving(false)
    if (!error) {
      setDirty(false)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    }
  }

  const updated = note.updated_at
    ? new Date(note.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  return (
    <div className="group relative bg-amber-50/60 border border-amber-200 rounded-xl p-3 flex flex-col">
      <textarea
        value={note.content}
        onChange={e => { onChange(note.id, e.target.value); setDirty(true) }}
        onBlur={save}
        placeholder="Type a note…"
        rows={4}
        className="w-full bg-transparent resize-none text-sm text-slate-800 placeholder:text-amber-700/40 focus:outline-none"
      />
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-amber-200/70">
        <span className="text-[10px] text-amber-700/60">
          {saving ? 'Saving…' : savedFlash ? (
            <span className="text-emerald-600 flex items-center gap-0.5"><Check className="w-3 h-3" /> Saved</span>
          ) : updated ? `Updated ${updated}` : ''}
        </span>
        <button
          onClick={() => { if (confirm('Delete this note?')) onDelete(note.id) }}
          className="text-amber-700/40 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Delete note"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
