/**
 * Local persistence: the best score and solution per map, plus preferences.
 *
 * Every storage access is wrapped in try/catch. Values are also kept in memory, so the game works
 * the same for the session when localStorage is missing, blocked, full or throws.
 */
import type { Speed } from '../ui/animate';
import { isSpeed } from '../ui/animate';

export interface BestRecord {
  moves: number;
  /** Solution string (`serializeSolution`). */
  solution: string;
}

export interface Prefs {
  speed: Speed;
  /** Map key of the last map played ("normal-123456"). */
  lastMap: string | null;
  /** Sound effects off. */
  mute: boolean;
}

/** How a finished run compares with the stored best, before it is saved. */
export type RunVerdict =
  | { kind: 'new'; moves: number; previous: number | null }
  | { kind: 'tied'; moves: number }
  | { kind: 'below'; moves: number; best: number };

/** The subset of the Web Storage API used here. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'pathery.';
const DEFAULT_PREFS: Prefs = { speed: 'med', lastMap: null, mute: false };

function browserStorage(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class GameStorage {
  private readonly memory = new Map<string, string>();
  private readonly backing: KeyValueStore | null;

  /** `backing` defaults to localStorage; pass null for memory only. */
  constructor(backing: KeyValueStore | null | undefined = browserStorage()) {
    this.backing = backing ?? null;
  }

  getBest(mapKey: string): BestRecord | null {
    const v = this.readJson(`best.${mapKey}`);
    if (
      v &&
      typeof v === 'object' &&
      Number.isInteger((v as BestRecord).moves) &&
      typeof (v as BestRecord).solution === 'string'
    ) {
      return { moves: (v as BestRecord).moves, solution: (v as BestRecord).solution };
    }
    return null;
  }

  /**
   * Compares a run with the stored best and saves it if it is better (or the first). A tie keeps
   * the stored solution. Blocked runs (0 moves) should not be recorded.
   */
  recordRun(mapKey: string, moves: number, solution: string): RunVerdict {
    const best = this.getBest(mapKey);
    if (best && moves === best.moves) return { kind: 'tied', moves };
    if (best && moves < best.moves) return { kind: 'below', moves, best: best.moves };
    this.write(`best.${mapKey}`, JSON.stringify({ moves, solution } satisfies BestRecord));
    return { kind: 'new', moves, previous: best ? best.moves : null };
  }

  getPrefs(): Prefs {
    const v = this.readJson('prefs');
    const p = v && typeof v === 'object' ? (v as Partial<Prefs>) : {};
    return {
      speed: isSpeed(p.speed) ? p.speed : DEFAULT_PREFS.speed,
      lastMap: typeof p.lastMap === 'string' ? p.lastMap : DEFAULT_PREFS.lastMap,
      mute: typeof p.mute === 'boolean' ? p.mute : DEFAULT_PREFS.mute,
    };
  }

  setPrefs(update: Partial<Prefs>): void {
    this.write('prefs', JSON.stringify({ ...this.getPrefs(), ...update }));
  }

  private readJson(key: string): unknown {
    const raw = this.read(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private read(key: string): string | null {
    const k = PREFIX + key;
    // Memory holds everything written this session, even if the backing store refused it.
    const mem = this.memory.get(k);
    if (mem !== undefined) return mem;
    try {
      return this.backing?.getItem(k) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    const k = PREFIX + key;
    this.memory.set(k, value);
    try {
      this.backing?.setItem(k, value);
    } catch {
      // Storage full or blocked: the in-memory copy keeps the session working.
    }
  }
}
