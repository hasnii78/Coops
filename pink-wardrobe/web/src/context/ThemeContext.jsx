import { createContext, useContext, useEffect } from 'react';
import { doc, updateDoc } from 'firebase/firestore';

import { db } from '../firebase';
import { useAuth } from './AuthContext';

const ThemeContext = createContext(null);

/**
 * Applies theme, text size and dark mode as attributes on <html>.
 *
 * All three are pure CSS custom-property switches, so changing any of them
 * re-themes the entire app instantly with no component re-render.
 */
export function ThemeProvider({ children }) {
  const { uid, profile } = useAuth();

  const theme = profile?.theme || 'pink';
  const textSize = profile?.textSize || 'medium';
  const darkMode = profile?.darkMode ?? false;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-text-size', textSize);
    root.setAttribute('data-dark', String(darkMode));
  }, [theme, textSize, darkMode]);

  async function update(patch) {
    if (!uid) return;
    await updateDoc(doc(db, 'users', uid), patch);
  }

  return (
    <ThemeContext.Provider
      value={{
        theme,
        textSize,
        darkMode,
        setTheme: (next) => update({ theme: next }),
        setTextSize: (next) => update({ textSize: next }),
        setDarkMode: (next) => update({ darkMode: next }),
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
