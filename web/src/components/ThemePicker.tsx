import { useSyncExternalStore } from 'react';
import { getTheme, setTheme, subscribeTheme, THEMES, type Theme } from '../lib/theme.ts';

export function ThemePicker() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme);
  return (
    <label className="theme-picker">
      <span className="theme-picker-label">Theme</span>
      <select aria-label="Theme" value={theme} onChange={(event: any) => setTheme(event.target.value as Theme)}>
        {THEMES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
    </label>
  );
}
