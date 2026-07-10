'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Building2, Lock, Eye, EyeOff, AlertTriangle } from 'lucide-react'

const MIN_LENGTH = 10

export default function ResetPasswordPage() {
  const router = useRouter()

  // null = still checking. /auth/confirm sets the session cookie before redirecting here.
  const [hasSession, setHasSession] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session))
  }, [])

  const tooShort = password.length > 0 && password.length < MIN_LENGTH
  const mismatch = confirm.length > 0 && password !== confirm

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < MIN_LENGTH) {
      setError(`Password must be at least ${MIN_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    router.push('/')
    router.refresh()
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
          {hasSession === null ? (
            <p className="text-slate-400 text-sm text-center py-4">Verifying your link…</p>
          ) : hasSession === false ? (
            <div className="text-center">
              <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-4" />
              <h1 className="text-xl font-bold text-white mb-2">Link expired</h1>
              <p className="text-slate-400 text-sm mb-6">
                This reset link is invalid or has already been used. Request a new one.
              </p>
              <Link
                href="/forgot-password"
                className="block w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm py-2.5 rounded-lg transition-colors"
              >
                Request a new link
              </Link>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-white mb-1">Set a new password</h1>
              <p className="text-slate-400 text-sm mb-6">At least {MIN_LENGTH} characters.</p>

              {error && (
                <div className="mb-4 bg-red-950 border border-red-800 text-red-300 text-sm px-4 py-3 rounded-lg">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">New password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      autoComplete="new-password"
                      placeholder="••••••••"
                      className="w-full bg-slate-800 border border-slate-700 text-white placeholder-slate-500 text-sm rounded-lg pl-10 pr-10 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {tooShort && (
                    <p className="text-amber-400 text-xs mt-1.5">
                      {MIN_LENGTH - password.length} more character{MIN_LENGTH - password.length === 1 ? '' : 's'} needed.
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Confirm password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={confirm}
                      onChange={e => setConfirm(e.target.value)}
                      required
                      autoComplete="new-password"
                      placeholder="••••••••"
                      className="w-full bg-slate-800 border border-slate-700 text-white placeholder-slate-500 text-sm rounded-lg pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  {mismatch && <p className="text-amber-400 text-xs mt-1.5">Passwords do not match.</p>}
                </div>

                <button
                  type="submit"
                  disabled={loading || tooShort || mismatch || !password || !confirm}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:opacity-60 text-white font-semibold text-sm py-2.5 rounded-lg transition-colors mt-2"
                >
                  {loading ? 'Saving…' : 'Update password'}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-slate-600 text-xs mt-6">
          Lumin Lending © 2026 · Internal use only
        </p>
      </div>
    </div>
  )
}
