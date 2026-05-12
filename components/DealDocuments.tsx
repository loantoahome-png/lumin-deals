'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import {
  FileText, Plus, Trash2, ExternalLink, Loader2, Folder,
  Image as ImageIcon, FileSpreadsheet, File as FileIcon,
} from 'lucide-react'
import OneDriveBrowser from './OneDriveBrowser'
import type { DriveItem } from '@/lib/onedrive'

type Doc = {
  id: string
  deal_id: string
  source: string
  source_id: string
  name: string
  web_url: string
  thumbnail_url: string | null
  mime_type: string | null
  size_bytes: number | null
  attached_at: string
}

function fileIcon(mime: string | null, name: string) {
  const m = mime ?? ''
  if (m.startsWith('image/')) return <ImageIcon className="w-4 h-4 text-purple-500" />
  if (m.includes('spreadsheet') || m.includes('excel') || name.match(/\.(xlsx?|csv)$/i)) {
    return <FileSpreadsheet className="w-4 h-4 text-green-600" />
  }
  if (m.includes('pdf') || name.match(/\.pdf$/i)) return <FileText className="w-4 h-4 text-red-500" />
  if (m.includes('word') || name.match(/\.docx?$/i)) return <FileText className="w-4 h-4 text-blue-600" />
  return <FileIcon className="w-4 h-4 text-slate-400" />
}

function formatSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export default function DealDocuments({ dealId }: { dealId: string }) {
  const [docs, setDocs] = useState<Doc[]>([])
  const [loading, setLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function fetchDocs() {
    setLoading(true)
    const { data, error } = await supabase
      .from('deal_documents')
      .select('*')
      .eq('deal_id', dealId)
      .order('attached_at', { ascending: false })
    if (error) setError(error.message)
    setDocs((data as Doc[]) || [])
    setLoading(false)
  }

  useEffect(() => { fetchDocs() }, [dealId])

  async function handleAttach(items: DriveItem[]) {
    if (items.length === 0) return
    setError(null)
    const rows = items.map(item => ({
      deal_id: dealId,
      source: 'onedrive',
      source_id: item.id,
      name: item.name,
      web_url: item.webUrl,
      thumbnail_url: item.thumbnails?.[0]?.medium?.url ?? item.thumbnails?.[0]?.small?.url ?? null,
      mime_type: item.file?.mimeType ?? null,
      size_bytes: item.size ?? null,
    }))
    const { error } = await supabase.from('deal_documents').insert(rows)
    if (error) setError(error.message)
    await fetchDocs()
  }

  async function handleRemove(id: string) {
    if (!confirm('Remove this document from the deal? (The file in OneDrive is not deleted.)')) return
    await supabase.from('deal_documents').delete().eq('id', id)
    await fetchDocs()
  }

  return (
    <>
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <Folder className="w-4 h-4 text-blue-600" />
            <h3 className="font-semibold text-slate-800 text-sm">Documents</h3>
            <span className="text-xs text-slate-500">{docs.length} attached</span>
          </div>
          <button
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            <Plus className="w-3.5 h-3.5" /> Attach from OneDrive
          </button>
        </div>

        {error && (
          <div className="px-5 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700">{error}</div>
        )}

        {loading ? (
          <div className="px-5 py-6 flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : docs.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <Folder className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No documents attached yet.</p>
            <p className="text-xs text-slate-400 mt-1">Click "Attach from OneDrive" to link loan documents to this deal.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {docs.map(doc => (
              <div key={doc.id} className="flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50/60 group">
                {doc.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={doc.thumbnail_url} alt="" className="w-10 h-10 object-cover rounded border border-slate-200 shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded bg-slate-100 flex items-center justify-center shrink-0">
                    {fileIcon(doc.mime_type, doc.name)}
                  </div>
                )}
                <a
                  href={doc.web_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 min-w-0 group/link"
                >
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-medium text-slate-900 truncate group-hover/link:text-blue-700">{doc.name}</span>
                    <ExternalLink className="w-3 h-3 text-slate-400 shrink-0 group-hover/link:text-blue-500" />
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    OneDrive · {formatSize(doc.size_bytes)} · attached {new Date(doc.attached_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </a>
                <button
                  onClick={() => handleRemove(doc.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded shrink-0"
                  title="Remove from deal"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <OneDriveBrowser open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={handleAttach} />
    </>
  )
}
