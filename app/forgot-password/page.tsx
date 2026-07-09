'use client'

import { useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Building2, Mail, ArrowLeft, CheckCircle2 } from 'lucide-react'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/confirm?next=/reset-password`,
    })

    // Always report success. Telling the caller whether an address exists would let
    // anyone enumerate who works here.
    setSent(true)
    setLoading(false)
  }

  return (
    <div className="flex-1 min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 bg-blue-500 rounded-xl flex items-center justify-center shadow-lg">
            <Building2 className="w-6 h-6 text-white" />
          </div>
          <div>
            <p className="text-white font-bold text-lg leading-tight">Lumin Lending</p>
            <p className="text-slate-400 text-xs">Deal Pipeline</p>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          {sent ? (
            <div className="text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-4" />
              <h1 className="text-xl font-bold text-white mb-2">Check your email</h1>
              <p className="text-slate-400 text-sm">
                If an account exists for <span className="text-slate-200">{email.trim()}</span>,
                a reset link is on its way. It expires in one hour.
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-white mb-1">Reset your password</h1>
              <p className="text-slate-400 text-sm mb-6">We&apos;ll email you a link to set a new one.</p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                      autoComplete="email"
                      placeholder="you@luminlending.com"
                      className="w-full bg-slate-800 border border-slate-700 text-white placeholder-slate-500 text-sm rounded-lg pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:opacity-60 text-white font-semibold text-sm py-2.5 rounded-lg transition-colors mt-2"
                >
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            </>
          )}

          <Link
            href="/login"
            className="flex items-center justify-center gap-1.5 text-slate-500 hover:text-slate-300 text-xs mt-6 transition-colors"
          >
            <ArrowLeft className="w-3 h-3" />
            Back to sign in
          </Link>
        </div>

        <p className="text-center text-slate-600 text-xs mt-6">
          Lumin Lending © 2026 · Internal use only
        </p>
      </div>
    </div>
  )
}
