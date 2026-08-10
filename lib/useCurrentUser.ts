'use client'

// Client-side "who am I" — role + board name for the signed-in user.
// Kept out of lib/roles.ts on purpose: that file is imported by middleware.ts,
// which runs on the Edge runtime and must not pull React into its module graph.
//
// Used for: hiding nav a processor can't reach, pinning /processing to her own
// desk, and stamping `deal_tasks.assigned_by` with the real creator instead of
// whatever the person types into the box.

import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { roleFromUser, displayName, type Role } from './roles'

export type CurrentUser = {
  email: string | null
  name: string | null
  role: Role
  /** false until the session has actually been read — render nav/controls only after. */
  loaded: boolean
}

const ANONYMOUS: CurrentUser = { email: null, name: null, role: 'admin', loaded: false }

export function useCurrentUser(): CurrentUser {
  const [me, setMe] = useState<CurrentUser>(ANONYMOUS)

  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return
      const user = data.user
      setMe({
        email: user?.email ?? null,
        name: displayName(user),
        role: roleFromUser(user),
        loaded: true,
      })
    })
    return () => { cancelled = true }
  }, [])

  return me
}
