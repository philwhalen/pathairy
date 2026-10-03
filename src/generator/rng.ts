/** Seeded PRNG (mulberry32) plus the small helpers the generator needs. */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates shuffle, returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Picks a value with probability proportional to its weight. */
  weighted<T>(entries: readonly { value: T; weight: number }[]): T;
  chance(p: number): boolean;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[int(0, items.length - 1)]!;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const weighted = <T>(entries: readonly { value: T; weight: number }[]): T => {
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let r = next() * total;
    for (const e of entries) {
      r -= e.weight;
      if (r < 0) return e.value;
    }
    return entries[entries.length - 1]!.value;
  };
  const chance = (p: number): boolean => next() < p;
  return { next, int, pick, shuffle, weighted, chance };
}
