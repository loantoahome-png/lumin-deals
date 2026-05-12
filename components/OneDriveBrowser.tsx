'use client'

import { useEffect, useState } from 'react'
import {
  X, Folder, FileText, ChevronLeft, Search, Loader2, Check,
  Image as ImageIcon, FileSpreadsheet, File as FileIcon,
} from 'lucide-react'
import {
  isOneDriveSignedIn, signInToOneDrive, listDriveChildren, searchDrive,
  type DriveItem,
} from '@/lib/onedrive'

type Props = {
  open: boolean
  onClose: () => void
  onSelect: (items: DriveItem[]) => void
}

type Crumb = { id: string; name: string }

function fileIcon(item: DriveItem) {
  if (item.folder) return <Folder className="w-5 h-5 text-amber-500" />
  const mime = item.file?.mimeType ?? ''
  if (mime.startsWith('image/')) return <ImageIcon className="w-5 h-5 text-purple-500" />
  if (mime.includes('spreadsheet') || mime.includes('excel') || item.name.match(/\.(xlsx?|csv)$/i)) {
    return <FileSpreadsheet className="w-5 h-5 text-green-600" />
  }
  if (mime.includes('pdf') || item.name.match(/\.pdf$/i)) return <FileText className="w-5 h-5 text-red-500" />
  if (mime.includes('word') || item.name.match(/\.docx?$/i)) return <FileText className="w-5 h-5 text-blue-600" />
  return <FileIcon className="w-5 h-5 text-slate-400" />
}

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export default function OneDriveBrowser({ open, onClose, onSelect }: Props) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [items, setItems] = useState<DriveItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: 'root', name: 'OneDrive' }])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)

  // Check sign-in state when modal opens
  useEffect(() => {
    if (!open) return
    setError(null)
    isOneDriveSignedIn().then(setSignedIn).catch(() => setSignedIn(false))
  }, [open])

  // Load root when signed in
  useEffect(() => {
    if (open && signedIn) loadFolder('root')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signedIn])

  async function loadFolder(folderId: string, name?: string) {
    setLoading(true)
    setError(null)
    setSearch('')
    try {
      const children = await listDriveChildren(folderId)
      setItems(children)
      // Update breadcrumbs only if we have a name (i.e. user clicked into a folder)
      if (name && folderId !== 'root') {
        setCrumbs(prev => [...prev, { id: folderId, name }])
      } else if (folderId === 'root') {
        setCrumbs([{ id: 'root', name: 'OneDrive' }])
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  function navigateBack() {
    const next = crumbs.slice(0, -1)
    if (next.length === 0) return
    const target = next[next.length - 1]
    setCrumbs(next)
    setLoading(true)
    setError(null)
    listDriveChildren(target.id).then(setItems).catch(e => setError(String(e))).finally(() => setLoading(false))
  }

  async function handleSearch(q: string) {
    setSearch(q)
    if (!q.trim()) {
      // Empty search → reload current folder
      const target = crumbs[crumbs.length - 1]
      loadFolder(target.id)
      return
    }
    setSearching(true)
    setError(null)
    try {
      const results = await searchDrive(q)
      setItems(results)
    } catch (e) {
      setError(String(e))
    } finally {
      setSearching(false)
    }
  }

  async function handleSignIn() {
    setSigningIn(true)
    setError(null)
    try {
      await signInToOneDrive()
      setSignedIn(true)
    } catch (e) {
      setError(String(e))
    } finally {
      setSigningIn(false)
    }
  }

  function toggleSelect(item: DriveItem) {
    if (item.folder) return // folders aren't selectable, only navigable
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id)
      return next
    })
  }

  function handleAttach() {
    const picked = items.filter(i => selected.has(i.id))
    onSelect(picked)
    setSelected(new Set())
    onClose()
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Folder className="w-4 h-4 text-blue-600" />
            <h3 className="font-semibold text-slate-900 text-sm">Attach from OneDrive</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sign-in screen */}
        {signedIn === false && (
          <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
            <Folder className="w-12 h-12 text-blue-500 mb-3" />
            <h4 className="font-semibold text-slate-900">Connect OneDrive</h4>
            <p className="text-sm text-slate-500 mt-1 mb-4 max-w-sm">
              Sign in with your Microsoft account to browse and attach OneDrive files to this deal.
            </p>
            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
            <button
              onClick={handleSignIn}
              disabled={signingIn}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {signingIn ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Sign in with Microsoft
            </button>
          </div>
        )}

        {/* File browser */}
        {signedIn === true && (
          <>
            {/* Breadcrumbs + search */}
            <div className="px-5 py-2 border-b border-slate-100 bg-slate-50/60">
              <div className="flex items-center gap-2 text-xs">
                {crumbs.length > 1 && (
                  <button onClick={navigateBack} className="text-slate-500 hover:text-blue-600 flex items-center gap-0.5">
                    <ChevronLeft className="w-3.5 h-3.5" /> Back
                  </button>
                )}
                <div className="flex items-center gap-1 text-slate-600 truncate">
                  {crumbs.map((c, i) => (
                    <span key={c.id} className="flex items-center gap-1">
                      {i > 0 && <span className="text-slate-300">/</span>}
                      <span className={i === crumbs.length - 1 ? 'font-semibold text-slate-800' : ''}>{c.name}</span>
                    </span>
                  ))}
                </div>
                <div className="flex-1" />
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
                  <input
                    placeholder="Search OneDrive…"
                    value={search}
                    onChange={e => handleSearch(e.target.value)}
                    className="pl-7 pr-2 py-1 text-xs border border-slate-200 rounded-md w-48 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>

            {/* File list */}
            <div className="flex-1 overflow-y-auto">
              {(loading || searching) && (
                <div className="flex items-center justify-center py-12 text-slate-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
                </div>
              )}
              {error && (
                <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
              )}
              {!loading && !searching && items.length === 0 && (
                <div className="text-center py-12 text-sm text-slate-400">No files in this folder.</div>
              )}
              {!loading && !searching && items.map(item => {
                const isSelected = selected.has(item.id)
                const isFolder = !!item.folder
                return (
                  <div
                    key={item.id}
                    onClick={() => isFolder ? loadFolder(item.id, item.name) : toggleSelect(item)}
                    className={`flex items-center gap-3 px-5 py-2 cursor-pointer hover:bg-blue-50 transition border-b border-slate-50 ${isSelected ? 'bg-blue-50' : ''}`}
                  >
                    {!isFolder && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(item)}
                        onClick={e => e.stopPropagation()}
                        className="w-3.5 h-3.5 rounded accent-blue-600"
                      />
                    )}
                    {isFolder && <div className="w-3.5" />}
                    {fileIcon(item)}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-900 truncate">{item.name}</div>
                      {!isFolder && item.size != null && (
                        <div className="text-[10px] text-slate-400">{formatSize(item.size)}</div>
                      )}
                      {isFolder && item.folder && (
                        <div className="text-[10px] text-slate-400">{item.folder.childCount} item{item.folder.childCount !== 1 ? 's' : ''}</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between bg-slate-50/60">
              <span className="text-xs text-slate-500">
                {selected.size > 0 ? `${selected.size} file${selected.size !== 1 ? 's' : ''} selected` : 'Click files to select'}
              </span>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-md">
                  Cancel
                </button>
                <button
                  onClick={handleAttach}
                  disabled={selected.size === 0}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40"
                >
                  <Check className="w-3.5 h-3.5" />
                  Attach {selected.size > 0 ? `(${selected.size})` : ''}
                </button>
              </div>
            </div>
          </>
        )}

        {signedIn === null && (
          <div className="flex-1 flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
          </div>
        )}
      </div>
    </div>
  )
}
