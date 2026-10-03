import { describe, expect, it } from 'vitest';
import { shortcutFor } from '../src/ui/shortcuts';
import type { KeyInfo } from '../src/ui/shortcuts';

const k = (key: string, over: Partial<KeyInfo> = {}): KeyInfo => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  editing: false,
  ...over,
});

describe('shortcutFor', () => {
  it('maps the plain keys, either case', () => {
    expect(shortcutFor(k('g'))).toBe('go');
    expect(shortcutFor(k('G', { shiftKey: false }))).toBe('go');
    expect(shortcutFor(k('r'))).toBe('reset');
    expect(shortcutFor(k('n'))).toBe('new');
    expect(shortcutFor(k('x'))).toBeNull();
  });

  it('maps Ctrl+Z and Cmd+Z to undo only', () => {
    expect(shortcutFor(k('z', { ctrlKey: true }))).toBe('undo');
    expect(shortcutFor(k('z', { metaKey: true }))).toBe('undo');
    expect(shortcutFor(k('z'))).toBeNull();
    expect(shortcutFor(k('z', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(k('z', { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('leaves browser combos alone', () => {
    expect(shortcutFor(k('r', { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(k('n', { metaKey: true }))).toBeNull();
    expect(shortcutFor(k('g', { altKey: true }))).toBeNull();
    expect(shortcutFor(k('G', { shiftKey: true }))).toBeNull();
  });

  it('ignores everything while editing text', () => {
    expect(shortcutFor(k('g', { editing: true }))).toBeNull();
    expect(shortcutFor(k('z', { ctrlKey: true, editing: true }))).toBeNull();
  });
});
