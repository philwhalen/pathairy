import { describe, expect, it } from 'vitest';
import { dailySeed, dateString, isDaily } from '../src/game/daily';
import { MAP_TYPES, parseMapKey, mapKey } from '../src/generator/generate';

describe('daily seeds', () => {
  it('formats local dates as YYYY-MM-DD', () => {
    expect(dateString(new Date(2026, 9, 3, 23, 59))).toBe('2026-10-03');
    expect(dateString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('is deterministic and in the 6-digit seed range', () => {
    for (const t of MAP_TYPES) {
      const s = dailySeed(t, '2026-10-03');
      expect(s).toBe(dailySeed(t, '2026-10-03'));
      expect(s).toBeGreaterThanOrEqual(100000);
      expect(s).toBeLessThanOrEqual(999999);
    }
  });

  it('differs by date and by type', () => {
    const seeds = new Set<number>();
    for (const t of MAP_TYPES) {
      for (let day = 1; day <= 28; day++) {
        seeds.add(dailySeed(t, `2026-02-${String(day).padStart(2, '0')}`));
      }
    }
    expect(seeds.size).toBe(MAP_TYPES.length * 28);
  });

  it('pins known values (so a change to the scheme is deliberate)', () => {
    expect(dailySeed('normal', '2026-10-03')).toBe(365629);
    expect(dailySeed('simple', '2000-01-01')).toBe(439136);
  });

  it('keeps plain type-seed keys that round trip through parseMapKey', () => {
    const seed = dailySeed('complex', '2026-10-03');
    expect(parseMapKey(mapKey('complex', seed))).toEqual({ type: 'complex', seed });
  });

  it('isDaily recognises only that date and type', () => {
    const seed = dailySeed('normal', '2026-10-03');
    expect(isDaily('normal', seed, '2026-10-03')).toBe(true);
    expect(isDaily('normal', seed, '2026-10-04')).toBe(false);
    expect(isDaily('simple', seed, '2026-10-03')).toBe(false);
  });
});
