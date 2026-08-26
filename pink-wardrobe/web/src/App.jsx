import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import BottomNav from './components/BottomNav';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { registerForPush } from './lib/notifications';

import AuthScreen from './screens/AuthScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import ClosetScreen from './screens/ClosetScreen';
import CombosScreen from './screens/CombosScreen';
import MeScreen from './screens/MeScreen';
import SavedScreen from './screens/SavedScreen';
import InboxScreen from './screens/InboxScreen';
import ProfileScreen from './screens/ProfileScreen';

function Gate() {
  const { user, profile, loading, uid, hasAvatar } = useAuth();

  useEffect(() => {
    if (uid) registerForPush(uid);
  }, [uid]);

  if (loading) {
    return (
      <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span className="spinner" style={{ color: 'var(--c-400)' }} />
      </div>
    );
  }

  if (!user) return <AuthScreen />;

  // The master avatar and colour quiz gate everything else — without a locked
  // pose template there is nothing to align garment layers to.
  if (!hasAvatar || !profile?.onboarded) return <OnboardingScreen />;

  return (
    <div className="app-shell">
      <Routes>
        <Route path="/closet" element={<ClosetScreen />} />
        <Route path="/combos" element={<CombosScreen />} />
        <Route path="/me" element={<MeScreen />} />
        <Route path="/saved" element={<SavedScreen />} />
        <Route path="/inbox" element={<InboxScreen />} />
        <Route path="/profile" element={<ProfileScreen />} />
        <Route path="*" element={<Navigate to="/closet" replace />} />
      </Routes>
      <BottomNav />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <Gate />
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
