'use client'

import { useEffect } from 'react'

// Root error boundary (catches errors in the root layout itself). Mirrors
// app/error.tsx but must render its own <html>/<body>. Auto-reloads on a
// stale-chunk error so a new deploy never leaves an open tab stranded.
const CHUNK_ERROR = /ChunkLoadError|Loading chunk|Importing a module script failed|Failed to fetch dynamically imported module/i

export default function GlobalError({
  error,
}: { error: Error & { digest?: string }; reset: () => void }) {
  const isChunk = CHUNK_ERROR.test(error?.message || '') || CHUNK_ERROR.test(error?.name || '')

  useEffect(() => {
    if (isChunk) {
      const KEY = 'lastChunkReload'
      const last = Number(sessionStorage.getItem(KEY) || 0)
      if (Date.now() - last > 10_000) {
        sessionStorage.setItem(KEY, String(Date.now()))
        window.location.reload()
      }
    }
  }, [isChunk])

  return (
    <html lang="en">
      <body style={{ fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif", display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', margin: 0, background: '#f8fafc' }}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', margin: 0 }}>
            {isChunk ? 'Updating to the latest version…' : 'Something went wrong'}
          </h2>
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 6 }}>
            {isChunk ? 'Reloading now…' : 'Reloading usually fixes it.'}
          </p>
          <button onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 16px', fontSize: 14, fontWeight: 600, color: '#fff', background: '#4f46e5', border: 0, borderRadius: 8, cursor: 'pointer' }}>
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}
