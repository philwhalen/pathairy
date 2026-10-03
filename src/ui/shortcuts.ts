/**
 * Keyboard shortcuts: G = Go, R = Reset, Ctrl/Cmd+Z = Undo, N = New map.
 * `shortcutFor` is pure; `installShortcuts` attaches it to the document.
 */
export type ShortcutAction = 'go' | 'reset' | 'undo' | 'new';

/** The parts of a KeyboardEvent that matter here. */
export interface KeyInfo {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Focus is in a text field (or other editable element). */
  editing: boolean;
}

export function shortcutFor(k: KeyInfo): ShortcutAction | null {
  if (k.editing || k.altKey) return null;
  const key = k.key.toLowerCase();
  const command = k.ctrlKey || k.metaKey;
  if (key === 'z') return command && !k.shiftKey && !(k.ctrlKey && k.metaKey) ? 'undo' : null;
  if (command || k.shiftKey) return null;
  if (key === 'g') return 'go';
  if (key === 'r') return 'reset';
  if (key === 'n') return 'new';
  return null;
}

function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['radio', 'checkbox', 'button', 'submit'].includes(target.type);
  }
  return false;
}

export function installShortcuts(run: (a: ShortcutAction) => void): void {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.repeat) return;
    const a = shortcutFor({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      editing: isEditing(e.target),
    });
    if (!a) return;
    e.preventDefault();
    run(a);
  });
}
