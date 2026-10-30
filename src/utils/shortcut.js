/** 快捷键匹配（原产物 G 函数） */
export function matchShortcut(shortcut, event) {
  if (!shortcut || shortcut.length < 2) return false;
  const [mod, key] = shortcut;
  if (event.ctrlKey && mod === 'Ctrl') return event.key.toUpperCase() === key.toUpperCase();
  if (event.shiftKey && mod === 'Shift') return event.key.toUpperCase() === key.toUpperCase();
  if (event.altKey && mod === 'Alt') return event.key.toUpperCase() === key.toUpperCase();
  return false;
}
