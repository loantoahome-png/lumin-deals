'use client'

/**
 * LenderEmailModal — collects the emails of the checked lenders into one
 * copy-pasteable block for an Outlook BCC blast.
 *
 *   • First/primary email per lender (matches the Email column; lib stores
 *     multi-AE rows as "a@x.com / b@x.com" — we take the first).
 *   • De-duplicated case-insensitively; lenders with no email are skipped
 *     (and listed so nothing silently disappears).
 *   • Separator defaults to "; " (classic Outlook); comma toggle for web/new Outlook.
 *
 * No persistence — selection is an ephemeral "build a BCC list now" action.
 */

import { useMemo, useState } from 'react'
import { X, Copy, Check, Mail, Trash2 } from 'lucide-react'
import type { EditableLender } from '@/components/LenderEditModal'

const firstEmail = (e: string) => e.split('/')[0].trim()

export default function LenderEmailModal({
  lenders, onClose, onClear,
}: {
  lenders: EditableLender[]
  onClose: () => void
  onClear: () => void
}) {
  const [sep, setSep] = useState<'; ' | ', '>('; ')
  const [copied, setCopied] = useState(false)

  const { emails, withEmail, withoutEmail } = useMemo(() => {
    const seen = new Set<string>()
    const emails: string[] = []
    const withEmail: EditableLender[] = []
    const withoutEmail: EditableLender[] = []
    for (const l of lenders) {
      const e = firstEmail(l.email || '')
      if (!e) { withoutEmail.push(l); continue }
      withEmail.push(l)
      const key = e.toLowerCase()
      if (!seen.has(key)) { seen.add(key); emails.push(e) }
    }
    return { emails, withEmail, withoutEmail }
  }, [lenders])

  const joined = emails.join(sep)

  async function copy() {
    // Select first: gives visual confirmation and a working Cmd/Ctrl+C path even
    // if the Clipboard API is blocked or never resolves (unfocused tab, odd browser).
    const ta = document.getElementById('lender-email-textarea') as HTMLTextAreaElement | null
    ta?.focus()
    ta?.select()
    try {
      await navigator.clipboard.writeText(joined)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* selection above already lets the user copy manually */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 shrink-0">
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Mail className="w-4 h-4 text-blue-600" /> BCC emails
            <span className="text-sm font-normal text-slate-500">
              · {emails.length} {emails.length === 1 ? 'address' : 'addresses'}
            </span>
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3 overflow-auto">
          {emails.length === 0 ? (
            <p className="text-sm text-slate-500">None of the selected lenders have an email on file.</p>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold uppercase tracking-wide text-slate-400">Separator</span>
                <button
                  onClick={() => setSep('; ')}
                  className={`px-2 py-0.5 rounded-full font-medium ${sep === '; ' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  Semicolon&nbsp;;
                </button>
                <button
                  onClick={() => setSep(', ')}
                  className={`px-2 py-0.5 rounded-full font-medium ${sep === ', ' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  Comma&nbsp;,
                </button>
                <span className="text-slate-400">Outlook BCC uses semicolons.</span>
              </div>

              <textarea
                id="lender-email-textarea"
                readOnly
                value={joined}
                onFocus={e => e.currentTarget.select()}
                className="w-full min-h-[120px] rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />

              <button
                onClick={copy}
                className="w-full flex items-center justify-center gap-2 text-sm font-semibold text-white bg-blue-600 rounded-lg px-4 py-2.5 hover:bg-blue-700"
              >
                {copied
                  ? <><Check className="w-4 h-4" /> Copied!</>
                  : <><Copy className="w-4 h-4" /> Copy all emails</>}
              </button>

              <div className="text-xs text-slate-500 leading-relaxed">
                <span className="font-semibold text-slate-600">{withEmail.length}</span> selected with email
                {emails.length !== withEmail.length && (
                  <span> · {withEmail.length - emails.length} duplicate{withEmail.length - emails.length === 1 ? '' : 's'} merged</span>
                )}
                {withoutEmail.length > 0 && (
                  <span>
                    {' · '}
                    <span className="font-semibold text-amber-600">{withoutEmail.length}</span> skipped (no email):{' '}
                    {withoutEmail.map(l => l.lender).join(', ')}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-200 shrink-0">
          <button
            onClick={onClear}
            className="flex items-center gap-1.5 text-xs font-medium text-red-600 hover:text-red-700 px-2 py-1"
          >
            <Trash2 className="w-3.5 h-3.5" /> Clear selection
          </button>
          <button onClick={onClose} className="text-sm font-medium text-slate-600 hover:text-slate-800 px-3 py-2">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
