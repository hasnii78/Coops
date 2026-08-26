import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { supabase } from '../supabase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

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
  useEffect(() => {
    if (!userId) return undefined;

    let active = true;

    async function load() {
      const { data } = await supabase
        .from('profiles').select('*').eq('id', userId).maybeSingle();

      if (active) {
        setProfile(data ?? null);
        setLoading(false);
      }
    }

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
      hasAvatar: Boolean(profile?.avatar_path && profile?.avatar_landmarks),
      refreshProfile: async () => {
        if (!userId) return;
        const { data } = await supabase
          .from('profiles').select('*').eq('id', userId).maybeSingle();
        setProfile(data ?? null);
      },
    }),
    [session, userId, profile, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
