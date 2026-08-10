'use client'

// ── Work List ───────────────────────────────────────────────────────────────
// One shared document the three of them edit, replacing the "Tasklist for Bri
// and Efrain" Google Doc directly.
//
// This started life as a generated view: group every active file by action and
// derive the rows from the processor checklist. Efrain killed it after seeing it
// with real data (2026-08-10) — "get rid of this, maybe we can just make a word
// page so I can copy and paste what she has already". The generated version was
// technically right and practically useless: an unticked checkbox means "not
// recorded", not "needs doing", so on day one it rendered 63 rows of unrecorded
// history and demanded a cleanup pass before it said anything true.
//
// ⚠️ Don't rebuild that. The doc works BECAUSE it's unstructured — they curate
//    it, so everything in it is real by construction. Structure would have to
//    earn its way back in against that. The old implementation is in git at
//    70eee57 if it's ever wanted.
//
// Free-form, autosaving, shared. Nothing is derived from loan data.

import { useCallback, useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { useCurrentUser } from '@/lib/useCurrentUser'
import RichTextEditor from '@/components/RichTextEditor'
import { ListChecks, Pencil, Check, AlertTriangle, Loader2 } from 'lucide-react'

type Loaded = { html: string; updated_at: string | null; updated_by: string | null }

export default function WorkListPage() {
  const me = useCurrentUser()
  const [doc, setDoc] = useState<Loaded | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Loaded | null>(null)

  // The `updated_at` this edit session started from — the conflict guard's base.
  const baseRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await (await fetch('/api/worklist-notes')).json()
      setDoc({ html: d.html ?? '', updated_at: d.updated_at ?? null, updated_by: d.updated_by ?? null })
    } catch {
      setError('Could not load the document.')
    }
  }, [])
  useEffect(() => { load() }, [load])

  function startEditing() {
    if (!doc) return
    setDraft(doc.html)
    baseRef.current = doc.updated_at
    setConflict(null)
    setError(null)
    setEditing(true)
  }

  const save = useCallback(async (html: string, closeAfter: boolean) => {
    setSaving(true)
    setError(null)
    let res: Response
    try {
      res = await fetch('/api/worklist-notes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, updated_by: me.name, base_updated_at: baseRef.current ?? '' }),
      })
    } catch {
      setSaving(false); setError('Save failed — check your connection. Your text is still on screen.'); return
    }
    const d = await res.json().catch(() => null)
    setSaving(false)

    if (res.status === 409) {
      // Someone else saved first. Keep the draft on screen — never discard typing.
      setConflict({ html: d?.html ?? '', updated_at: d?.updated_at ?? null, updated_by: d?.updated_by ?? null })
      return
    }
    if (!res.ok || !d?.ok) {
      setError(d?.error ?? 'Save failed. Your text is still on screen.')
      return
    }
    baseRef.current = d.updated_at
    setDoc({ html, updated_at: d.updated_at, updated_by: d.updated_by })
    setSavedAt(Date.now())
    if (closeAfter) setEditing(false)
  }, [me.name])

  // Autosave — a shared doc people paste into shouldn't need a Save button to
  // survive a closed tab. Debounced so a paste isn't 40 writes.
  useEffect(() => {
    if (!editing || conflict) return
    const t = setTimeout(() => { if (draft !== doc?.html) void save(draft, false) }, 2500)
    return () => clearTimeout(t)
  }, [draft, editing, conflict, doc?.html, save])

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center">
            <ListChecks className="w-5 h-5 text-indigo-700" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 leading-tight">Work List</h1>
            <p className="text-xs text-slate-500">
              Shared between Efrain, Brianne and Hanh. Everyone sees the same page.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {doc?.updated_at && !editing && (
            <span className="text-[11px] text-slate-400">
              Last edited {doc.updated_by ? `by ${doc.updated_by} ` : ''}
              {new Date(doc.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
          {saving && <span className="flex items-center gap-1 text-[11px] text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> Saving…</span>}
          {!saving && editing && savedAt && !conflict && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-600"><Check className="w-3 h-3" /> Saved</span>
          )}
          {doc && !editing && (
            <button
              onClick={startEditing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
          )}
          {editing && (
            <button
              onClick={() => void save(draft, true)}
              disabled={saving || !!conflict}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              Done
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* ⚠️ Never auto-resolve. Three people share one document; silently
          picking a winner loses somebody's typing with no trace. Both versions
          stay on screen and a human decides. */}
      {conflict && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 space-y-2">
          <p className="text-sm font-semibold text-amber-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            {conflict.updated_by ?? 'Someone'} saved changes while you were editing
          </p>
          <p className="text-xs text-amber-800">
            Nothing has been overwritten. Your version is still in the editor below. Either keep
            yours (their edits are replaced) or discard yours and reload theirs.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => { baseRef.current = conflict.updated_at; setConflict(null); void save(draft, false) }}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700"
            >
              Keep mine
            </button>
            <button
              onClick={() => { setConflict(null); setEditing(false); void load() }}
              className="px-3 py-1.5 text-xs font-semibold text-amber-900 bg-white border border-amber-300 rounded-lg hover:bg-amber-100"
            >
              Discard mine, load theirs
            </button>
          </div>
        </div>
      )}

      {/* ── The document ────────────────────────────────────────────────── */}
      {doc === null ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : editing ? (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <RichTextEditor initialHtml={draft} onChange={setDraft} autofocus />
          <p className="text-[11px] text-slate-400 mt-2">
            Saves on its own as you type. Paste straight from Google Docs or Word — formatting comes with it.
          </p>
        </div>
      ) : doc.html.trim() ? (
        <div
          className="bg-white border border-slate-200 rounded-xl p-6 note-prose"
          // Sanitized on read — same path components/NoteContent uses.
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(doc.html, { ADD_ATTR: ['target', 'rel'] }) }}
        />
      ) : (
        <button
          onClick={startEditing}
          className="w-full bg-white border-2 border-dashed border-slate-200 rounded-xl p-12 text-center hover:border-indigo-300 hover:bg-indigo-50/30 transition"
        >
          <ListChecks className="w-9 h-9 text-slate-300 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-700">This page is empty</p>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            Click to start, then paste the task list straight out of the Google Doc — headings,
            colours and numbering all come across.
          </p>
        </button>
      )}
    </div>
  )
}
