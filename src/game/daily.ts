/**
 * Daily maps: each local calendar day has one map per type, like the site. Keys stay in the plain
 * `{type}-{seed}` form (so `?map=` links and stored bests work unchanged); the seed is a
 * deterministic hash of the date and type, in the same range as random seeds.
 */
import type { MapType } from '../generator/generate';

/** Local date as `YYYY-MM-DD`. */
export function dateString(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 32-bit FNV-1a. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The seed of the daily map of `type` on `date` (`YYYY-MM-DD`): 100000..999999. */
export function dailySeed(type: MapType, date: string): number {
  return 100000 + (fnv1a(`pathery-daily|${date}|${type}`) % 900000);
}

/** True if `type`-`seed` is the daily map for `date` (today by default). */
export function isDaily(type: MapType, seed: number, date: string = dateString()): boolean {
  return seed === dailySeed(type, date);
}
