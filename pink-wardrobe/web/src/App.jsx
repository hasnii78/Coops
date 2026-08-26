import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import BottomNav from './components/BottomNav';
import { ConfigScreen, ErrorBoundary } from './components/ErrorScreen';
import { configError } from './supabase';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';

import AuthScreen from './screens/AuthScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import ClosetScreen from './screens/ClosetScreen';
import CombosScreen from './screens/CombosScreen';
import MeScreen from './screens/MeScreen';
import SavedScreen from './screens/SavedScreen';
import ProfileScreen from './screens/ProfileScreen';

function Gate() {
  const { user, profile, loading, hasAvatar } = useAuth();

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
        <Route path="/profile" element={<ProfileScreen />} />
        <Route path="*" element={<Navigate to="/closet" replace />} />
      </Routes>
      <BottomNav />
    </div>
  );
}

export default function App() {
  // Reported rather than thrown, so a misconfigured build still renders
  // something that explains itself instead of a blank page.
  if (configError) {
    return (
      <ConfigScreen
        title="Not configured"
        message={configError}
        hint="The Supabase URL and publishable key are baked in when the app is built, so this needs a new build to fix."
      />
    );
  }

  // BASE_URL is '/' for the APK and '/<repo>/' for the GitHub Pages build, so
  // the router resolves links correctly under either.
  return (
    <ErrorBoundary>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthProvider>
          <ThemeProvider>
            <Gate />
          </ThemeProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
