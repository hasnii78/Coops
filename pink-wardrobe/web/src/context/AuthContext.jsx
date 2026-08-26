import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';

import { auth, db } from '../firebase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => onAuthStateChanged(auth, (next) => {
    setUser(next);
    if (!next) {
      setProfile(null);
      setLoading(false);
    }
  }), []);

  // Live-subscribe to the profile so theme, text size and avatar changes
  // propagate immediately, including across the user's other devices.
  useEffect(() => {
    if (!user) return undefined;

    return onSnapshot(
      doc(db, 'users', user.uid),
      (snapshot) => {
        setProfile(snapshot.exists() ? { uid: user.uid, ...snapshot.data() } : null);
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [user]);

  const value = useMemo(
    () => ({
      user,
      profile,
      loading,
      uid: user?.uid ?? null,
      hasAvatar: Boolean(profile?.avatar?.storagePath),
    }),
    [user, profile, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
