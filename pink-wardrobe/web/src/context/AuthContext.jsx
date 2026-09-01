import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { supabase } from '../supabase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id ?? null;

  // Load the profile, then subscribe so theme and text-size changes propagate
  // across the user's devices without a refresh.
  //
  // A profile that exists but was never fetched used to be indistinguishable
  // from a genuinely new signup: one failed request — a slow connection right
  // after a fresh install is exactly when that happens — was read as "no
  // avatar", and sent an existing account through onboarding with no way back,
  // since the account's own layers depend on the avatar path this fetch was
  // supposed to bring back. Retried here rather than accepted on the first try,
  // and left as an explicit error rather than papered over as "no profile" if
  // every attempt fails.
  useEffect(() => {
    if (!userId) return undefined;

    let active = true;
    const delays = [0, 1000, 2000, 4000];

    async function load() {
      for (const [attempt, delay] of delays.entries()) {
        if (!active) return;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

        const { data, error } = await supabase
          .from('profiles').select('*').eq('id', userId).maybeSingle();

        if (!active) return;

        if (!error) {
          setProfile(data ?? null);
          setProfileError(false);
          setLoading(false);
          return;
        }

        const lastAttempt = attempt === delays.length - 1;
        if (lastAttempt) {
          setProfileError(true);
          setLoading(false);
        }
      }
    }

    setProfileError(false);
    load();

    const channel = supabase
      .channel(`profile:${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        (payload) => { if (active) setProfile(payload.new); },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      uid: userId,
      profile,
      loading,
      profileError,
      hasAvatar: Boolean(profile?.avatar_path && profile?.avatar_landmarks),
      refreshProfile: async () => {
        if (!userId) return;
        const { data, error } = await supabase
          .from('profiles').select('*').eq('id', userId).maybeSingle();

        if (error) { setProfileError(true); return; }
        setProfile(data ?? null);
        setProfileError(false);
      },
    }),
    [session, userId, profile, loading, profileError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
