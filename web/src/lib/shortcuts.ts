// Every keyboard shortcut in one place: used by the "?" help and kept in step with the handlers.

export const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Anywhere',
    items: [
      ['N', 'New job'],
      ['F or /', 'Search'],
      ['B', 'Board'],
      ['T', 'Today'],
      ['M', 'My work'],
      ['P', 'Projects'],
      ['D', 'Dashboard'],
      ['V', 'Drawing review'],
      ['W', 'Workload'],
      ['R', 'Reports'],
      ['?', 'This list'],
      ['Esc', 'Close the panel, dialog or menu'],
    ],
  },
  {
    group: 'On the board (with a card selected)',
    items: [
      ['Tab or arrow keys', 'Move between cards'],
      ['Enter', 'Open the job'],
      ['C', 'Claim it'],
      ['Shift + ← / →', 'Move it to the previous or next column'],
      ['Shift + ↑ / ↓', 'Move it up or down in its column'],
      ['Menu key or Shift + F10', 'More actions (also right-click, or press and hold on a tablet)'],
    ],
  },
  {
    group: 'New job form',
    items: [
      ['Enter', 'Create'],
      ['Shift + Enter', 'Create and claim'],
    ],
  },
  {
    group: 'Job panel',
    items: [
      ['Enter', 'Save a one-line field'],
      ['Ctrl + Enter', 'Save notes or description, or add a comment'],
      ['Esc', 'Undo the edit in a field, or close the panel'],
    ],
  },
  {
    group: 'My work',
    items: [['Alt + ↑ / ↓', 'Change the order of your jobs']],
  },
];

/** True when a key press should be left alone (the person is typing, or a dialog is open). */
export function typingOrDialog(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement;
  return !!el.closest?.('input, textarea, select, [contenteditable="true"]') || !!document.querySelector('.dialog-backdrop');
}
