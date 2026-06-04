'use client'

import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

// Route-segment error boundary. Its most important job: recover from
// ChunkLoadError, which happens when a new deployment invalidates the JS
// chunks an already-open tab is still referencing. A hard reload pulls the
// fresh build and the user is back in — no dead "couldn't load" page.
const CHUNK_ERROR = /ChunkLoadError|Loading chunk|Importing a module script failed|Failed to fetch dynamically imported module/i

export default function Error({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  const isChunk = CHUNK_ERROR.test(error?.message || '') || CHUNK_ERROR.test(error?.name || '')

  useEffect(() => {
    if (isChunk) {
      // Avoid a reload loop: only auto-reload once per stale-chunk incident.
      const KEY = 'lastChunkReload'
      const last = Number(sessionStorage.getItem(KEY) || 0)
      if (Date.now() - last > 10_000) {
        sessionStorage.setItem(KEY, String(Date.now()))
        window.location.reload()
      }
    }
  }, [isChunk])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <AlertTriangle className="w-10 h-10 text-amber-500 mb-3" />
      <h2 className="text-lg font-bold text-slate-900">
        {isChunk ? 'Updating to the latest version…' : 'Something went wrong'}
      </h2>
      <p className="text-sm text-slate-500 mt-1 max-w-sm">
        {isChunk
          ? 'A newer version of the dashboard is available. Reloading now…'
          : 'This page hit an error. Reloading usually fixes it.'}
      </p>
      <div className="flex items-center gap-2 mt-4">
        <button onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg">
          <RefreshCw className="w-4 h-4" /> Reload
        </button>
        <button onClick={() => reset()}
          className="px-4 py-2 text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg">
          Try again
        </button>
      </div>
    </div>
  )
}
