import type { Session } from '@supabase/supabase-js'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Professional } from '../lib/queries'

interface AuthState {
  loading: boolean
  session: Session | null
  professional: Professional | null
  role: Professional['role'] | null
  isOwner: boolean
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [booting, setBooting] = useState(true)
  const [loaded, setLoaded] = useState<{ userId: string; professional: Professional | null } | null>(null)

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setBooting(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id ?? null
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void supabase
      .from('professionals')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setLoaded({ userId, professional: data ?? null })
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const professional = userId && loaded?.userId === userId ? loaded.professional : null
  const loadingPro = !!userId && loaded?.userId !== userId

  const value = useMemo<AuthState>(
    () => ({
      loading: booting || loadingPro,
      session,
      professional,
      role: professional?.role ?? null,
      isOwner: professional?.role === 'owner',
      signOut: async () => {
        await supabase.auth.signOut()
      },
    }),
    [booting, loadingPro, session, professional],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
