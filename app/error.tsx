'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

// Route-segment error boundary.
//
// Strategy: a huge share of "errors" here are transient — a new deployment
// invalidated the JS chunks an open tab was still using. A single reload pulls
// the fresh build and fixes it. So we auto-reload ONCE for any error; if the
// same boundary trips again within a few seconds (i.e. the reload did NOT fix
// it), it's a real bug — we stop reloading and show the message for diagnosis.
const RELOAD_KEY = 'lastErrReload'
const RECENT_MS = 8000

export default function Error({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  const [persistent, setPersistent] = useState(false)

  useEffect(() => {
    let last = 0
    try { last = Number(sessionStorage.getItem(RELOAD_KEY) || 0) } catch { /* ignore */ }
    const justReloaded = Date.now() - last < RECENT_MS
    if (justReloaded) {
      // The reload didn't clear it → real error. Show details.
      setPersistent(true)
      return
    }
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch { /* ignore */ }
    window.location.reload()
  }, [])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <AlertTriangle className="w-10 h-10 text-amber-500 mb-3" />
      <h2 className="text-lg font-bold text-slate-900">
        {persistent ? 'Something went wrong' : 'Updating to the latest version…'}
      </h2>
      <p className="text-sm text-slate-500 mt-1 max-w-sm">
        {persistent ? 'This page hit an error. Reloading usually fixes it.' : 'Reloading now…'}
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
      {persistent && (error?.message || error?.digest) && (
        <pre className="mt-5 max-w-lg whitespace-pre-wrap break-words text-left text-[11px] text-slate-500 bg-slate-100 border border-slate-200 rounded-lg p-3">
          {error?.message || ''}{error?.digest ? `\n\ndigest: ${error.digest}` : ''}
        </pre>
      )}
    </div>
  )
}
