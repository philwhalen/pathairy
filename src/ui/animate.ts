/**
 * Plays engine results (server pathArray tokens) on the board, like the original client's
 * `doanimate` (report §6): one step per tick, longer pauses at targets and teleports, and a trail
 * that fades behind the path. Several paths play at the same time.
 *
 * `buildFrames` and `frameDelay` are pure; `PathPlayer` adds timers and draws through the small
 * `AnimationSurface` interface (implemented by the board), so it can be tested without a DOM.
 */
import { parseXY } from '../engine/mapcode';
import type { Coord, PathResult } from '../engine/types';

export type Speed = 'slow' | 'med' | 'fast' | 'ultra';
export const SPEEDS: readonly Speed[] = ['slow', 'med', 'fast', 'ultra'];
export const SPEED_LABELS: Record<Speed, string> = {
  slow: 'Slow',
  med: 'Med',
  fast: 'Fast',
  ultra: 'Ultra',
};
/** Milliseconds per step (original: Slow 180, Med 94, Fast 44, Ultra 22). */
export const STEP_MS: Record<Speed, number> = { slow: 180, med: 94, fast: 44, ultra: 22 };
/** The original's speed setting number (1-4), used in its pause formulas. */
const SPEED_INDEX: Record<Speed, number> = { slow: 1, med: 2, fast: 3, ultra: 4 };

export function isSpeed(s: unknown): s is Speed {
  return typeof s === 'string' && (SPEEDS as readonly string[]).includes(s);
}

const CHECKPOINT_COLORS = [
  '#F777FF', // c1 A
  '#FFFF11',
  '#FF4466',
  '#ff9911',
  '#00FFFF',
  '#a12ec4',
  '#46c0a0',
  '#33ff33',
  '#f032e6',
  '#d2f53c',
  '#fabebe',
  '#9090f4',
  '#e6beff',
  '#aa6e28',
  '#fffac8', // c15 O
];
const FINISH_COLOR = '#cccccc';

/** Path color while heading for a target ("c1".."c15", "f1"), as the original's `targetColor`. */
export function targetColor(label: string): string {
  const m = /^c(\d+)$/.exec(label);
  if (m) return CHECKPOINT_COLORS[Number(m[1]) - 1] ?? FINISH_COLOR;
  return FINISH_COLOR;
}

/** Checkpoint letter: 1 -> "A". */
export function checkpointLetter(n: number): string {
  return String.fromCharCode(64 + n);
}

/** Human name of a target label, for messages: "c2" -> "checkpoint B", "f1" -> "the finish". */
export function targetName(label: string): string {
  const m = /^c(\d+)$/.exec(label);
  return m ? `checkpoint ${checkpointLetter(Number(m[1]))}` : 'the finish';
}

/**
 * One animation step:
 * - `start`: the path appears on its start cell (0 moves).
 * - `move`: one move in direction `dir` (1 up, 2 right, 3 down, 4 left) onto the cell.
 * - `reach`: the target on this cell is reached (`pause` = the next target follows).
 * - `teleport`: the path steps into a teleport here and pauses before warping.
 * - `arrive`: the path appears on the teleport exit (0 moves).
 */
export interface Frame {
  kind: 'start' | 'move' | 'reach' | 'teleport' | 'arrive';
  cell: Coord;
  dir?: number;
  /** Path color: the color of the target the path is heading for. */
  color: string;
  /** Moves of this path so far, including this frame. */
  moves: number;
  /** True for a `reach` frame that is followed by another target (longer pause). */
  pause?: boolean;
}

const DELTA: Record<number, Coord> = {
  1: { row: -1, col: 0 },
  2: { row: 0, col: 1 },
  3: { row: 1, col: 0 },
  4: { row: 0, col: -1 },
};
const LABEL_RE = /^[cf]\d+$/;

/** Converts one path's tokens into frames. Blocked paths have no frames. */
export function buildFrames(path: PathResult): Frame[] {
  if (path.blocked) return [];
  const frames: Frame[] = [];
  const t = path.tokens;
  let cell = parseXY(path.start);
  let color = typeof t[0] === 'string' ? targetColor(t[0]) : FINISH_COLOR;
  let moves = 0;
  frames.push({ kind: 'start', cell, color, moves });
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (typeof tok === 'number') {
      const d = DELTA[tok];
      if (!d) continue;
      cell = { row: cell.row + d.row, col: cell.col + d.col };
      moves++;
      frames.push({ kind: 'move', cell, dir: tok, color, moves });
    } else if (tok === 'r') {
      const next = t[i + 1];
      const pause = typeof next === 'string' && LABEL_RE.test(next);
      frames.push({ kind: 'reach', cell, color, moves, pause });
    } else if (tok === 'u' && typeof t[i + 1] === 'string' && t[i + 2] === 'u') {
      frames.push({ kind: 'teleport', cell, color, moves });
      cell = parseXY(t[i + 1] as string);
      frames.push({ kind: 'arrive', cell, color, moves });
      i += 2;
    } else if (LABEL_RE.test(tok)) {
      color = targetColor(tok);
    }
    // "tN" (a spent teleport) changes nothing on screen.
  }
  return frames;
}

/**
 * Milliseconds to wait after a frame before the next one. Matches the original's total timings:
 * each token is one step; a new target adds 250 ms (+200 at Slow/Med); a teleport adds
 * 1350 - 100 x speed number. The original spends one step on the target label and two on the
 * teleport exit tokens, folded in here.
 */
export function frameDelay(frame: Frame, speed: Speed): number {
  const step = STEP_MS[speed];
  const idx = SPEED_INDEX[speed];
  switch (frame.kind) {
    case 'reach':
      return frame.pause ? 2 * step + 250 + (idx <= 2 ? 200 : 0) : step;
    case 'teleport':
      return step + 1350 - idx * 100;
    case 'arrive':
      return 2 * step;
    default:
      return step;
  }
}

/** What the player draws on. Implemented by the board. */
export interface AnimationSurface {
  /** Paints the trail on a cell; it fades by itself. `dir` is the move that entered the cell. */
  trail(cell: Coord, color: string, pathIndex: number, dir: number | undefined): void;
  /** Greys a reached target or used teleport until `restore`. */
  markUsed(cell: Coord): void;
  /** Briefly highlights a teleport exit. */
  flash(cell: Coord, color: string): void;
  /** Restores everything `markUsed` greyed. */
  restore(): void;
  /** Removes every animation effect at once (cancel). */
  clearEffects(): void;
}

export interface PlayCallbacks {
  /** Moves so far per path, after every frame. */
  onProgress(moves: number[]): void;
  /** A target was reached or a teleport entered (for sound effects). Optional. */
  onEvent?(kind: 'reach' | 'teleport'): void;
  /** All paths finished (not called when cancelled). */
  onDone(): void;
}

/** Delay before used targets get their color back after the run (original: 2.5 s). */
export const RESTORE_MS = 2500;

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id) => clearTimeout(id),
};

/** Plays paths on a surface. One run at a time: `play` and `cancel` stop the previous run. */
export class PathPlayer {
  private readonly pending = new Set<number>();
  private running = false;

  constructor(
    private readonly surface: AnimationSurface,
    private readonly speed: () => Speed,
    private readonly timers: Timers = browserTimers,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  play(paths: readonly PathResult[], cb: PlayCallbacks): void {
    this.cancel();
    this.running = true;
    const all = paths.map(buildFrames);
    const moves = all.map(() => 0);
    let remaining = all.length;
    const finishOne = () => {
      if (--remaining > 0) return;
      this.running = false;
      cb.onDone();
      this.schedule(() => this.surface.restore(), RESTORE_MS);
    };
    if (remaining === 0) {
      this.running = false;
      cb.onDone();
      return;
    }
    all.forEach((frames, pathIndex) => {
      const step = (i: number) => {
        const f = frames[i];
        if (!f) return finishOne();
        this.draw(f, pathIndex);
        if (f.kind === 'reach' || f.kind === 'teleport') cb.onEvent?.(f.kind);
        moves[pathIndex] = f.moves;
        cb.onProgress(moves.slice());
        this.schedule(() => step(i + 1), i + 1 < frames.length ? frameDelay(f, this.speed()) : 0);
      };
      step(0);
    });
  }

  /** Stops the current run (if any) and clears its effects from the board. */
  cancel(): void {
    for (const id of this.pending) this.timers.clear(id);
    this.pending.clear();
    this.running = false;
    this.surface.clearEffects();
  }

  private draw(f: Frame, pathIndex: number): void {
    const s = this.surface;
    switch (f.kind) {
      case 'start':
      case 'move':
        s.trail(f.cell, f.color, pathIndex, f.dir);
        break;
      case 'reach':
      case 'teleport':
        s.markUsed(f.cell);
        break;
      case 'arrive':
        s.flash(f.cell, f.color);
        s.markUsed(f.cell);
        break;
    }
  }

  private schedule(fn: () => void, ms: number): void {
    const id = this.timers.set(() => {
      this.pending.delete(id);
      fn();
    }, ms);
    this.pending.add(id);
  }
}
