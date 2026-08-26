import { createContext, useContext, useEffect } from 'react';

import { supabase } from '../supabase';
import { useAuth } from './AuthContext';

const ThemeContext = createContext(null);

/**
 * Applies theme, text size and dark mode as attributes on <html>.
 *
 * All three are pure CSS custom-property switches, so changing any of them
 * re-themes the whole app instantly with no component re-render.
 */
export function ThemeProvider({ children }) {
  const { uid, profile, refreshProfile } = useAuth();

  const theme = profile?.theme || 'pink';
  const textSize = profile?.text_size || 'medium';
  const darkMode = profile?.dark_mode ?? false;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-text-size', textSize);
    root.setAttribute('data-dark', String(darkMode));
  }, [theme, textSize, darkMode]);

  async function update(patch) {
    if (!uid) return;
    await supabase.from('profiles').update(patch).eq('id', uid);
    await refreshProfile();
  }

  return (
    <ThemeContext.Provider
      value={{
        theme,
        textSize,
        darkMode,
        setTheme: (next) => update({ theme: next }),
        setTextSize: (next) => update({ text_size: next }),
        setDarkMode: (next) => update({ dark_mode: next }),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
