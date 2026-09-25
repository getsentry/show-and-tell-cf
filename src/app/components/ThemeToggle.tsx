import {useEffect, useState} from 'react';

import {
  applyTheme,
  getStoredTheme,
  getSystemTheme,
  storeTheme,
  type Theme,
} from '../theme';

export function ThemeToggle({className = ''}: {className?: string}) {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme() ?? getSystemTheme());

  useEffect(() => {
    const storedTheme = getStoredTheme();
    const activeTheme = storedTheme ?? getSystemTheme();
    setTheme(activeTheme);
    applyTheme(activeTheme);

    if (storedTheme || !window.matchMedia) return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const syncWithSystem = (event: MediaQueryListEvent) => {
      if (getStoredTheme()) return;
      const nextTheme = event.matches ? 'dark' : 'light';
      setTheme(nextTheme);
      applyTheme(nextTheme);
    };
    media.addEventListener('change', syncWithSystem);
    return () => media.removeEventListener('change', syncWithSystem);
  }, []);

  function toggleTheme() {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    applyTheme(nextTheme);
    storeTheme(nextTheme);
  }

  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      className={`themeToggle${className ? ` ${className}` : ''}`}
      type="button"
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
      aria-pressed={theme === 'dark'}
      onClick={toggleTheme}
    >
      <svg
        className="themeToggleSun"
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </svg>
      <svg
        className="themeToggleMoon"
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />
      </svg>
      <span className="themeToggleThumb" aria-hidden="true" />
    </button>
  );
}
