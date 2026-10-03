/**
 * Pathing engine: reproduces the server's getpath result (report §5) for a map and a wall set.
 *
 * For each path and each target in turn:
 *  1. Distance field: breadth-first search outward from every tile of the target, over the cells
 *     this path may enter. On ice the search state includes the direction of travel.
 *  2. Pick the source (start tile, previous target, or teleport exit) nearest to the target;
 *     ties go to the first in row-major order.
 *  3. Walk: from the current state, take the first move in U, R, D, L order whose state is one
 *     step closer. That is the lexicographically smallest shortest route, which is what the
 *     server produces.
 *  4. Stepping onto an unspent `tN` spends all `tN` tiles (for this path), warps to the nearest
 *     `uN` (0 moves) and continues towards the same target. The distance field does not change,
 *     because teleports do not affect which cells are passable.
 *  5. If a target (or, after a warp, every exit) cannot be reached, the path is blocked: score 0,
 *     tokens = the partial pathArray, and no later path is reported.
 *
 * Rules that may change with new server evidence live in rules.ts.
 */
import type { Coord, MapData, PathResult, PathsResult, Token } from './types';
import { buildGrid, cellIndex, cellXY, opposite, type Grid } from './grid';
import {
  FINISH_LABEL,
  FAILED_WARP_TOKEN,
  STOP_AT_FIRST_BLOCKED_PATH,
  TELEPORTS_SHARED_BETWEEN_PATHS,
  checkpointSequence,
  isFinish,
  isStart,
  isWallable,
  pickNearest,
  type PathNo,
} from './rules';

interface Leg {
  /** Token emitted when heading for this target: "c3", "f1". */
  label: string;
  targets: Int32Array;
}

interface PathSpec {
  pathNo: PathNo;
  /** Start tiles in row-major order. */
  starts: Int32Array;
  legs: Leg[];
}

/** A reusable engine for one map. Not re-entrant (it reuses its work arrays). */
export interface Engine {
  readonly map: MapData;
  readonly grid: Grid;
  /** Full result in the server's format (tokens included). */
  compute(walls: readonly Coord[]): PathsResult;
  /**
   * Total moves without building tokens (fast path for solvers). Returns -1 if any path is
   * blocked (the server scores that as 0).
   */
  score(walls: readonly Coord[]): number;
}

/**
 * Walls are expected on wallable (`o`) tiles inside the grid. Others are ignored by the engine;
 * the server rejects the whole solution instead (use `validateSolution` to check first).
 */
export function computePaths(map: MapData, walls: readonly Coord[]): PathsResult {
  return createEngine(map).compute(walls);
}

/**
 * The server's verdict on a wall list before pathing: null if acceptable, otherwise its error.
 * PROBED: walls on non-`o` tiles -> "Invalid solution"; more walls than allowed -> "Out of walls???".
 * Duplicates and off-grid walls are treated as invalid here (not probed).
 */
export function validateSolution(map: MapData, walls: readonly Coord[]): string | null {
  const seen = new Set<number>();
  for (const w of walls) {
    const t = map.tiles[w.row]?.[w.col];
    const key = w.row * map.width + w.col;
    if (!t || !isWallable(t) || seen.has(key)) return 'Invalid solution';
    seen.add(key);
  }
  if (walls.length > map.walls) return 'Out of walls???';
  return null;
}

export function createEngine(map: MapData): Engine {
  return new PathEngine(map);
}

class PathEngine implements Engine {
  readonly grid: Grid;
  private readonly specs: PathSpec[] = [];
  /** cell -> teleport number of a `tN` tile that warps (0 = none). */
  private readonly teleNum: Int32Array;
  /** teleport number -> `uN` cells in row-major order (empty: stepping on `tN` blocks). */
  private readonly teleExits: (Int32Array | undefined)[] = [];
  private readonly teleUsed: Uint8Array;
  private readonly usedLabel: string[] = [];

  // Work arrays, reused across calls.
  private readonly wallList: Int32Array;
  private wallCount = 0;
  private readonly pass: Uint8Array;
  private readonly dist: Int32Array;
  private readonly queue: Int32Array;
  private readonly single = new Int32Array(1);

  // Outputs of the last walk().
  private startCell = -1;
  private endCell = -1;

  constructor(readonly map: MapData) {
    const g = (this.grid = buildGrid(map));
    const cellsWhere = (pred: (cell: number) => boolean): Int32Array => {
      const out: number[] = [];
      for (let c = 0; c < g.size; c++) if (pred(c)) out.push(c);
      return Int32Array.from(out);
    };

    // Teleports.
    const ins = new Map<number, number[]>();
    const outs = new Map<number, number[]>();
    g.tiles.forEach((t, c) => {
      const m = t.type === 't' ? ins : t.type === 'u' ? outs : null;
      if (!m) return;
      if (!m.has(t.value)) m.set(t.value, []);
      m.get(t.value)!.push(c);
    });
    let maxTele = 0;
    for (const n of ins.keys()) maxTele = Math.max(maxTele, n);
    this.teleNum = new Int32Array(g.size);
    this.teleUsed = new Uint8Array(maxTele + 1);
    for (const [n, cells] of ins) {
      this.teleExits[n] = Int32Array.from(outs.get(n) ?? []);
      this.usedLabel[n] = `t${n}`;
      for (const c of cells) this.teleNum[c] = n;
    }

    // Paths and their targets.
    const present = new Set<number>();
    for (const t of g.tiles) if (t.type === 'c') present.add(t.value);
    const finishes = cellsWhere((c) => isFinish(g.tiles[c]!));
    for (const pathNo of [1, 2] as const) {
      const starts = cellsWhere((c) => isStart(g.tiles[c]!, pathNo));
      if (starts.length === 0) continue;
      const legs: Leg[] = checkpointSequence(present, pathNo).map((n) => ({
        label: `c${n}`,
        targets: cellsWhere((c) => g.tiles[c]!.type === 'c' && g.tiles[c]!.value === n),
      }));
      legs.push({ label: FINISH_LABEL, targets: finishes });
      this.specs.push({ pathNo, starts, legs });
    }

    this.wallList = new Int32Array(g.size);
    this.pass = new Uint8Array(g.size);
    this.dist = new Int32Array(g.stateCount);
    this.queue = new Int32Array(g.stateCount);
  }

  compute(walls: readonly Coord[]): PathsResult {
    this.setWalls(walls);
    const paths: PathResult[] = [];
    if (TELEPORTS_SHARED_BETWEEN_PATHS) this.teleUsed.fill(0);
    for (const spec of this.specs) {
      const tokens: Token[] = [];
      const moves = this.walk(spec, tokens);
      if (moves < 0) {
        // Blocked: tokens are the server's partial pathArray (everything up to the failure).
        // The server's `end` for blocked paths is junk ("0,0", "-1,1", ...); we report the start.
        const start = cellXY(this.grid, this.startCell >= 0 ? this.startCell : spec.starts[0]!);
        paths.push({ tokens, moves: 0, blocked: true, start, end: start });
        if (STOP_AT_FIRST_BLOCKED_PATH) break;
      } else {
        paths.push({
          tokens,
          moves,
          blocked: false,
          start: cellXY(this.grid, this.startCell),
          end: cellXY(this.grid, this.endCell),
        });
      }
    }
    const blocked = paths.some((p) => p.blocked);
    const totalMoves = blocked ? 0 : paths.reduce((s, p) => s + p.moves, 0);
    return { paths, totalMoves, blocked };
  }

  score(walls: readonly Coord[]): number {
    this.setWalls(walls);
    if (TELEPORTS_SHARED_BETWEEN_PATHS) this.teleUsed.fill(0);
    let total = 0;
    for (const spec of this.specs) {
      const moves = this.walk(spec, null);
      if (moves < 0) return -1;
      total += moves;
    }
    return total;
  }

  /** Records the wall cells (ignoring any that are off-grid or not wallable). */
  private setWalls(walls: readonly Coord[]): void {
    const g = this.grid;
    let n = 0;
    for (const w of walls) {
      const c = cellIndex(g, w);
      if (c >= 0 && g.wallable[c]) this.wallList[n++] = c;
    }
    this.wallCount = n;
  }

  /**
   * Walks one path, appending server tokens to `tokens` (if given). Returns its moves, or -1 if
   * blocked; the tokens then end with the label of the unreachable target, or with
   * FAILED_WARP_TOKEN after stepping onto a teleport that cannot warp.
   */
  private walk(spec: PathSpec, tokens: Token[] | null): number {
    const g = this.grid;
    const { nbr, iceState, stateCell, stateDir } = g;
    const dist = this.dist;

    // Passability for this path: tiles, then walls.
    const pass = this.pass;
    pass.set(g.passable[spec.pathNo - 1]!);
    for (let i = 0; i < this.wallCount; i++) pass[this.wallList[i]!] = 0;
    if (!TELEPORTS_SHARED_BETWEEN_PATHS) this.teleUsed.fill(0);

    let sources: Int32Array = spec.starts;
    let moves = 0;
    let cell = -1;
    this.startCell = -1;
    for (const leg of spec.legs) {
      tokens?.push(leg.label);
      this.distanceField(leg.targets);
      // Sources (starts, targets, teleport exits) are never ice, so their state is the cell.
      const i = pickNearest(sources, dist);
      if (i < 0) return -1;
      cell = sources[i]!;
      if (this.startCell < 0) this.startCell = cell;
      let state = cell;
      let d = dist[state]!;
      while (d > 0) {
        // Successors of `state` (movement rule, see distanceField): first one step closer.
        const sd = stateDir[state]!;
        const dEnd = sd || 4;
        let next = -1;
        let dir = sd || 1;
        for (; dir <= dEnd; dir++) {
          const v = nbr[cell * 4 + dir - 1]!;
          if (v < 0) continue;
          const iv = iceState[v]!;
          const sv = iv < 0 ? v : iv + dir - 1;
          if (dist[sv] === d - 1) {
            next = sv;
            break;
          }
        }
        if (next < 0) throw new Error('pathing: inconsistent distance field');
        state = next;
        cell = stateCell[next]!;
        d--;
        moves++;
        tokens?.push(dir);

        const tn = this.teleNum[cell]!;
        if (tn !== 0) {
          if (this.teleUsed[tn]) {
            tokens?.push(this.usedLabel[tn]!);
          } else {
            this.teleUsed[tn] = 1;
            const exits = this.teleExits[tn]!;
            const j = pickNearest(exits, dist);
            if (j < 0) {
              tokens?.push(FAILED_WARP_TOKEN);
              return -1;
            }
            cell = exits[j]!;
            state = cell;
            d = dist[cell]!;
            tokens?.push('u', cellXY(g, cell), 'u');
          }
        }
      }
      tokens?.push('r');
      this.single[0] = cell;
      sources = this.single;
    }
    this.endCell = cell;
    return moves;
  }

  /**
   * Fills `dist[state]` = number of moves from that state to the nearest target cell
   * (-1 = cannot reach), searching backwards from the targets.
   *
   * Movement rule (ANALYST for ice details; PROBED for plain cells):
   *  - Successors (used by walk): from a plain cell, move in any direction onto a passable cell; from an
   *    ice cell, only in the direction of travel (blocked ahead = dead end). Entering an ice cell
   *    moving in direction d gives state (ice cell, d).
   *  - Predecessors (used here) are the inverse: state (v, d) on ice can only be reached by
   *    moving d; a plain cell v by moving any d. The cell moved from is `u = v - d`, in state
   *    (u, d) if u is ice, else (u).
   */
  private distanceField(targets: Int32Array): void {
    const { nbr, iceState, stateCell, stateDir } = this.grid;
    const pass = this.pass;
    const dist = this.dist;
    const queue = this.queue;
    dist.fill(-1);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (pass[t] && dist[t]! < 0) {
        dist[t] = 0;
        queue[tail++] = t;
      }
    }
    while (head < tail) {
      const v = queue[head++]!;
      const nd = dist[v]! + 1;
      const vc = stateCell[v]!;
      const vd = stateDir[v]!;
      const dEnd = vd || 4;
      for (let d = vd || 1; d <= dEnd; d++) {
        const u = nbr[vc * 4 + opposite(d) - 1]!;
        if (u < 0 || !pass[u]) continue;
        const iu = iceState[u]!;
        const su = iu < 0 ? u : iu + d - 1;
        if (dist[su]! < 0) {
          dist[su] = nd;
          queue[tail++] = su;
        }
      }
    }
  }
}
