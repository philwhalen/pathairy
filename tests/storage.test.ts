import { describe, expect, it } from 'vitest';
import { GameStorage } from '../src/game/storage';
import type { KeyValueStore } from '../src/game/storage';

class FakeStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

const throwing: KeyValueStore = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

describe('GameStorage', () => {
  it('records bests: first run, better, tie, worse', () => {
    const s = new GameStorage(new FakeStore());
    expect(s.getBest('simple-1')).toBeNull();
    expect(s.recordRun('simple-1', 20, '.1,1.:')).toEqual({
      kind: 'new',
      moves: 20,
      previous: null,
    });
    expect(s.recordRun('simple-1', 25, '.1,2.:')).toEqual({ kind: 'new', moves: 25, previous: 20 });
    expect(s.recordRun('simple-1', 25, '.3,3.:')).toEqual({ kind: 'tied', moves: 25 });
    expect(s.recordRun('simple-1', 22, '.4,4.:')).toEqual({ kind: 'below', moves: 22, best: 25 });
    // A tie keeps the first solution.
    expect(s.getBest('simple-1')).toEqual({ moves: 25, solution: '.1,2.:' });
    expect(s.getBest('simple-2')).toBeNull();
  });

  it('persists to the backing store and reads it back in a new session', () => {
    const store = new FakeStore();
    new GameStorage(store).recordRun('normal-5', 40, '.0,1.:');
    new GameStorage(store).setPrefs({ speed: 'ultra', lastMap: 'normal-5', mute: true });
    const s = new GameStorage(store);
    expect(s.getBest('normal-5')).toEqual({ moves: 40, solution: '.0,1.:' });
    expect(s.getPrefs()).toEqual({ speed: 'ultra', lastMap: 'normal-5', mute: true });
  });

  it('keeps the AI best per map and drops records from other solver versions', () => {
    const store = new FakeStore();
    const s = new GameStorage(store);
    expect(s.getAi('complex-1', 1)).toBeNull();
    s.putAi('complex-1', { moves: 250, solution: '.1,1.:', version: 1 });
    expect(new GameStorage(store).getAi('complex-1', 1)).toEqual({
      moves: 250,
      solution: '.1,1.:',
      version: 1,
    });
    expect(s.getAi('complex-1', 2)).toBeNull();
    store.setItem('pathery.ai.complex-2', '{"moves":"x","solution":".1,1.:","version":1}');
    expect(s.getAi('complex-2', 1)).toBeNull();
  });

  it('has default prefs and merges updates', () => {
    const s = new GameStorage(new FakeStore());
    expect(s.getPrefs()).toEqual({ speed: 'med', lastMap: null, mute: false });
    s.setPrefs({ lastMap: 'complex-9' });
    s.setPrefs({ speed: 'slow' });
    expect(s.getPrefs()).toEqual({ speed: 'slow', lastMap: 'complex-9', mute: false });
  });

  it('ignores corrupt or foreign data', () => {
    const store = new FakeStore();
    store.setItem('pathery.best.simple-1', '{not json');
    store.setItem('pathery.best.simple-2', '{"moves":"12","solution":3}');
    store.setItem('pathery.prefs', '{"speed":"warp","lastMap":7,"mute":"yes"}');
    const s = new GameStorage(store);
    expect(s.getBest('simple-1')).toBeNull();
    expect(s.getBest('simple-2')).toBeNull();
    expect(s.getPrefs()).toEqual({ speed: 'med', lastMap: null, mute: false });
  });

  it('works in memory when storage throws or is missing', () => {
    for (const backing of [throwing, null]) {
      const s = new GameStorage(backing);
      expect(s.getBest('x-1')).toBeNull();
      expect(s.recordRun('x-1', 10, '..:').kind).toBe('new');
      expect(s.getBest('x-1')).toEqual({ moves: 10, solution: '..:' });
      s.setPrefs({ speed: 'fast' });
      expect(s.getPrefs().speed).toBe('fast');
    }
  });

  it('works under node, where localStorage does not exist', () => {
    const s = new GameStorage();
    s.recordRun('y-1', 3, '..:');
    expect(s.getBest('y-1')?.moves).toBe(3);
  });
});
