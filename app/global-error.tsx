'use client'

import { useEffect, useState } from 'react'

// Root error boundary (catches errors in the root layout itself). Same
// once-then-show strategy as app/error.tsx: auto-reload once (fixes the common
// stale-chunk-after-deploy case); if it persists, show the message.
const RELOAD_KEY = 'lastErrReload'
const RECENT_MS = 8000

export default function GlobalError({
  error,
}: { error: Error & { digest?: string }; reset: () => void }) {
  const [persistent, setPersistent] = useState(false)

  useEffect(() => {
    let last = 0
    try { last = Number(sessionStorage.getItem(RELOAD_KEY) || 0) } catch { /* ignore */ }
    if (Date.now() - last < RECENT_MS) { setPersistent(true); return }
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch { /* ignore */ }
    window.location.reload()
  }, [])

  return (
    <html lang="en">
      <body style={{ fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif", display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', margin: 0, background: '#f8fafc' }}>
        <div style={{ textAlign: 'center', padding: 24, maxWidth: 560 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', margin: 0 }}>
            {persistent ? 'Something went wrong' : 'Updating to the latest version…'}
          </h2>
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 6 }}>
            {persistent ? 'Reloading usually fixes it.' : 'Reloading now…'}
          </p>
          <button onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 16px', fontSize: 14, fontWeight: 600, color: '#fff', background: '#4f46e5', border: 0, borderRadius: 8, cursor: 'pointer' }}>
            Reload
          </button>
          {persistent && (error?.message || error?.digest) && (
            <pre style={{ marginTop: 20, whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'left', fontSize: 11, color: '#64748b', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
              {error?.message || ''}{error?.digest ? `\n\ndigest: ${error.digest}` : ''}
            </pre>
          )}
        </div>
      </body>
    </html>
  )
}
