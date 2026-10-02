// This preference belongs to the browser, not the signed-in person or the board.
// The small head script uses the same validation as the React picker.
export const THEME_STORAGE_KEY = 'engineering-board-theme';
export const THEMES = [
  { value: 'light', label: 'Light' },
  { value: 'charcoal', label: 'Charcoal' },
  { value: 'midnight', label: 'Midnight' },
] as const;
export type Theme = (typeof THEMES)[number]['value'];
const CHANGE_EVENT = 'engineering-board-theme-change';

function validTheme(value: string | null | undefined): Theme {
  return THEMES.some((theme) => theme.value === value) ? value as Theme : 'light';
}

function storedTheme(): Theme {
  try {
    return validTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'light'; // Storage can be disabled; the board must still work.
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
}

// Executed synchronously in <head>, before the stylesheet or app is displayed.
export function initializeTheme() {
  applyTheme(storedTheme());
}

export function getTheme(): Theme {
  return validTheme(document.documentElement.dataset.theme);
}

export function setTheme(theme: Theme) {
  const next = validTheme(theme);
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // The choice still works for this page if persistence is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeTheme(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    // Ignore sessionStorage events; localStorage may itself be inaccessible.
    try {
      if (event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    applyTheme(event.key === null ? 'light' : validTheme(event.newValue));
    callback();
  };
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener('storage', onStorage);
  };
}
