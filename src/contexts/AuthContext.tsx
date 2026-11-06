import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User, Session, AuthError } from '@supabase/supabase-js'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { notifyFactorStatusChanged } from '@/hooks/useFactorStatus'
import { asPlan, type Plan } from '@/lib/plan'
import {
  browserLocalStore,
  browserSessionStore,
  clearAllDrafts,
  flushAllUnsaved,
} from '@/lib/draft-store'

interface AuthContextType {
  user: User | null
  session: Session | null
  loading: boolean
  /** The account's plan, from profiles.pricing_tier. null until it is known. */
  plan: Plan | null
  /** True while the profile row for the current session is still being read. */
  planLoading: boolean
  /** The plan that sees every surface — Eden's own account. */
  isWorkshop: boolean
  signInWithEmail: (email: string, password: string) => Promise<{ error: AuthError | null }>
  signUpWithEmail: (email: string, password: string, displayName: string) => Promise<{ error: AuthError | null }>
  signInWithGoogle: () => Promise<{ error: AuthError | null }>
  signInWithApple: () => Promise<{ error: AuthError | null }>
  signOut: () => Promise<{ error: AuthError | null }>
  resetPassword: (email: string) => Promise<{ error: AuthError | null }>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planLoading, setPlanLoading] = useState(true)

  const queryClient = useQueryClient()

  // The matter tree (useServerspaces) is cached under one key for the whole
  // tab, and what it may contain depends on the session: who is signed in,
  // and whether a second factor has been confirmed (migration 094 hides
  // sealed matters at aal1). A tree read under one session must not outlive
  // it. (Eden, 2026-11-06: the full tree showed only after a page refresh.)
  // Any change of who or of assurance level drops the cached tree, so every
  // sidebar, dashboard and picker reads it again under the session in force.
  // The factor banner ("Sealed matters are hidden until you confirm it's
  // you") is re-read on the same events: it was read once per user id, so a
  // fresh sign-in by the same person after a step-up kept the old "nothing
  // waiting" answer and the banner never came back while every sealed matter
  // had gone dark (Eden, 2026-11-06, sessions 17:32 aal2 → 17:35 aal1).
  //
  // SIGNED_IN also fires when the tab regains focus (supabase-js v2); that is
  // one tree read per refocus, the same as react-query's own refetchOnWindowFocus.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        queryClient.removeQueries({ queryKey: ['serverspaces'] })
      } else if (event === 'SIGNED_IN' || event === 'MFA_CHALLENGE_VERIFIED' || event === 'USER_UPDATED') {
        void queryClient.invalidateQueries({ queryKey: ['serverspaces'] })
        notifyFactorStatusChanged()
      }
    })
    return () => subscription.unsubscribe()
  }, [queryClient])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  // The plan is read once per session, keyed on the user id — a token refresh
  // fires onAuthStateChange again with the same id and must not re-fetch.
  //
  // Until the row is in, `plan` stays null and `planLoading` is true, and the
  // surfaces that read it render nothing rather than a frozen tile that
  // vanishes a moment later. Anything unexpected — no row yet on a brand-new
  // signup, an RLS refusal, a network failure — settles on 'free', the
  // focused core: a failed read must never be a way in.
  useEffect(() => {
    const uid = user?.id
    if (!uid) {
      setPlan(null)
      setPlanLoading(false)
      return
    }

    let cancelled = false
    setPlan(null)
    setPlanLoading(true)

    void (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('pricing_tier')
        .eq('id', uid)
        .maybeSingle()
      if (cancelled) return
      if (error) console.error('plan:', error.message)
      setPlan(asPlan(data?.pricing_tier))
      setPlanLoading(false)
    })()

    return () => { cancelled = true }
  }, [user?.id])

  const signInWithEmail = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  const signUpWithEmail = async (email: string, password: string, displayName: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
      },
    })
    return { error }
  }

  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    return { error }
  }

  const signInWithApple = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    return { error }
  }

  // Signing out wipes the drafts this machine is holding — but only after
  // every live surface has been offered to the server, and only on a
  // DELIBERATE sign-out. Supabase also raises SIGNED_OUT when a refresh token
  // fails, which is a session expiring under a lawyer with an hour of unsaved
  // text on screen; wiping there would destroy exactly what this net exists
  // to catch, so nothing is cleared in onAuthStateChange.
  const signOut = async () => {
    try {
      await flushAllUnsaved()
    } catch {
      /* a save that will not go through must not trap someone in the app */
    }
    const { error } = await supabase.auth.signOut()
    // Every account's drafts, not just this one's: the next person to sign in
    // at this desk may be a different lawyer, and a predecessor's unsaved page
    // must not be sitting in their browser.
    clearAllDrafts(browserLocalStore())
    clearAllDrafts(browserSessionStore())
    return { error }
  }

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset`,
    })
    return { error }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        plan,
        planLoading,
        isWorkshop: plan === 'workshop',
        signInWithEmail,
        signUpWithEmail,
        signInWithGoogle,
        signInWithApple,
        signOut,
        resetPassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
