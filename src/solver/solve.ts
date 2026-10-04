/**
 * Wall-placement optimizer: looks for a wall set that makes the path as long as possible.
 *
 * Algorithm (iterated simulated annealing over wall sets):
 *  - Construction: randomized greedy. Repeatedly add the wall that lengthens the path most,
 *    choosing among cells on the current path (a wall that does not touch the path never changes
 *    the score on its own, see `pathCells`).
 *  - Annealing runs of fixed length (in evaluations). The main move ("relocate") removes a
 *    random wall, re-traces the path, and puts the wall back on the best of a few cells of the new
 *    path; the rest add a wall on the path (when under budget), move a wall onto the path, shift
 *    a wall to a nearby cell, or move two walls at once. Blocked wall sets (score -1) are always
 *    rejected. The path is re-traced after every accepted move, so candidates follow it.
 *  - Restarts: each run starts from the best set found so far with some walls removed (or, a
 *    quarter of the time, from scratch), then greedily refilled.
 *
 * Plain synchronous code with no Node/DOM dependencies, so it can run in a Web Worker. All
 * randomness comes from the seed and the schedule depends only on the evaluation count, so a given
 * seed and evaluation count always give the same result (time limits only decide where to stop).
 */
import { createEngine, validateSolution, type Engine } from '../engine/pathing';
import { cellCoord, cellIndex, type Grid } from '../engine/grid';
import type { Coord, MapData, PathsResult } from '../engine/types';
import { createRng, type Rng } from '../generator/rng';

/** Bump when the search changes, so stored "AI best" scores are recomputed. */
export const SOLVER_VERSION = 1;

/** Search constants (exposed for tuning with tools/solve.ts --param). */
export interface SolverParams {
  /** Path cells sampled per wall in the initial greedy construction / in restarts. */
  greedySamples: number;
  restartSamples: number;
  /** Annealing run length: runBase + runPerWall * min(budget, runWallCap) evaluations. */
  runBase: number;
  runPerWall: number;
  runWallCap: number;
  /** Start temperature = tempBase + tempFrac * best score; end temperature = tempEnd. */
  tempBase: number;
  tempFrac: number;
  tempEnd: number;
  /** Move mix (cumulative thresholds on one random number): add / shift / move / double move. */
  pAdd: number;
  pShift: number;
  pMove: number;
  /** Share of candidates taken next to the path instead of on it. */
  pNear: number;
  /** Share of walls removed at a restart: dropMin + dropRange * random. */
  dropMin: number;
  dropRange: number;
  /** Share of restarts that start over from no walls (keeping only the best result). */
  pFresh: number;
  /** Share of moves that remove a wall, re-trace the path and re-add the best of a few cells. */
  pRelocate: number;
  relocateSamples: number;
}

export const DEFAULT_PARAMS: SolverParams = {
  greedySamples: 12,
  restartSamples: 6,
  runBase: 1500,
  runPerWall: 40,
  runWallCap: 200,
  tempBase: 2,
  tempFrac: 0.01,
  tempEnd: 0.15,
  pAdd: 0.5,
  pShift: 0.55,
  pMove: 0.9,
  pNear: 0.15,
  dropMin: 0.1,
  dropRange: 0.25,
  pFresh: 0.25,
  pRelocate: 0.9,
  relocateSamples: 4,
};

export interface SolverOptions {
  seed: number;
  /** Overrides of the search constants (for tuning). */
  params?: Partial<SolverParams>;
  /** Stop after this many score evaluations. Default: unlimited (stop by time). */
  iterations?: number;
  /** Starting walls (e.g. the player's current solution). The result is never worse. */
  initialWalls?: readonly Coord[];
}

export interface SolveOptions extends SolverOptions {
  /** Wall-clock budget. Default: 2000 ms if `iterations` is not given, else unlimited. */
  timeLimitMs?: number;
  /** Called whenever a better wall set is found. */
  onProgress?: (p: SolveProgress) => void;
}

export interface SolveResult {
  walls: Coord[];
  /** Total moves of the best wall set (as computePaths would report). */
  moves: number;
  /** Score evaluations performed. */
  iterations: number;
  elapsedMs: number;
}

export interface SolveProgress extends SolveResult {
  /** True once the iteration limit is reached (never for time-only solvers). */
  done: boolean;
}

/** A resumable solver: call `step(ms)` repeatedly (e.g. from a Worker) and read the progress. */
export interface Solver {
  /** Runs for about `ms` milliseconds (or until done) and returns the progress so far. */
  step(ms: number): SolveProgress;
  /** Runs exactly `n` more evaluations (or until done). */
  stepIterations(n: number): SolveProgress;
  progress(): SolveProgress;
}

const now: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

/** Cells visited by the paths of a (non-blocked) compute() result, including repeats. */
export function pathCells(grid: Grid, res: PathsResult): number[] {
  const out: number[] = [];
  const { nbr, width } = grid;
  for (const p of res.paths) {
    if (p.blocked) continue;
    const [x, y] = p.start.split(',').map(Number) as [number, number];
    let cell = y * width + x;
    out.push(cell);
    const t = p.tokens;
    for (let i = 0; i < t.length; i++) {
      const tok = t[i]!;
      if (typeof tok === 'number') {
        cell = nbr[cell * 4 + tok - 1]!;
        out.push(cell);
      } else if (tok === 'u' && typeof t[i + 1] === 'string' && t[i + 2] === 'u') {
        const [ux, uy] = (t[i + 1] as string).split(',').map(Number) as [number, number];
        cell = uy * width + ux;
        out.push(cell);
        i += 2;
      }
    }
  }
  return out;
}

export function createSolver(map: MapData, opts: SolverOptions): Solver {
  return new AnnealingSolver(map, opts);
}

/** Runs a solver to completion (by time and/or iterations) and returns the best wall set. */
export function solve(map: MapData, opts: SolveOptions): SolveResult {
  const solver = new AnnealingSolver(map, opts, opts.onProgress);
  const limit = opts.timeLimitMs ?? (opts.iterations === undefined ? 2000 : Infinity);
  const t0 = now();
  let p = solver.progress();
  while (!p.done) {
    const left = limit - (now() - t0);
    if (left <= 0) break;
    p = solver.step(Math.min(left, 50));
  }
  const { done: _done, ...result } = p;
  return result;
}

class AnnealingSolver implements Solver {
  private readonly engine: Engine;
  private readonly grid: Grid;
  private readonly rng: Rng;
  private readonly budget: number;
  private readonly maxIterations: number;
  private readonly P: SolverParams;
  private readonly coords: Coord[];
  /** Wallable cells within one step (8-neighbourhood) of each cell. */
  private readonly near: Int32Array[];
  private readonly wallable: Int32Array;

  // Current state.
  private readonly isWall: Uint8Array;
  /** Wall cells and the same walls as Coords (what engine.score takes), kept in sync. */
  private readonly cells: number[] = [];
  private readonly walls: Coord[] = [];
  private cur = -1;
  /** Wallable, wall-free cells on the current path (with repeats), refreshed lazily. */
  private path: number[] = [];
  private pathDirty = true;

  // Best so far.
  private bestCells: number[] = [];
  private bestScore = -1;

  private iterations = 0;
  private elapsedMs = 0;
  private readonly gen: Generator<void, void, void>;
  private finished = false;

  constructor(
    map: MapData,
    opts: SolverOptions,
    private readonly onImprove?: (p: SolveProgress) => void,
  ) {
    this.engine = createEngine(map);
    const g = (this.grid = this.engine.grid);
    this.rng = createRng(opts.seed);
    this.maxIterations = opts.iterations ?? Infinity;
    this.P = { ...DEFAULT_PARAMS, ...opts.params };
    this.coords = Array.from({ length: g.size }, (_, c) => cellCoord(g, c));
    const wallable: number[] = [];
    for (let c = 0; c < g.size; c++) if (g.wallable[c]) wallable.push(c);
    this.wallable = Int32Array.from(wallable);
    this.budget = Math.max(0, Math.min(map.walls, wallable.length));
    this.near = this.coords.map(({ row, col }) => {
      const out: number[] = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const c = cellIndex(g, { row: row + dr, col: col + dc });
          if ((dr || dc) && c >= 0 && g.wallable[c]) out.push(c);
        }
      }
      return Int32Array.from(out);
    });
    this.isWall = new Uint8Array(g.size);

    // Starting point: the initial walls if they are a valid, unblocked solution.
    const init = (opts.initialWalls ?? []).slice(0, this.budget);
    if (init.length > 0 && validateSolution(map, init) === null) {
      for (const w of init) this.add(cellIndex(g, w));
    }
    this.cur = this.engine.score(this.walls);
    if (this.cur < 0) {
      this.clear();
      this.cur = this.engine.score(this.walls);
    }
    this.bestScore = this.cur;
    this.bestCells = this.cells.slice();
    this.gen = this.search();
  }

  progress(): SolveProgress {
    return {
      walls: this.bestCells.map((c) => ({ ...this.coords[c]! })),
      moves: Math.max(0, this.bestScore),
      iterations: this.iterations,
      elapsedMs: this.elapsedMs,
      done: this.finished,
    };
  }

  step(ms: number): SolveProgress {
    const t0 = now();
    const end = t0 + ms;
    while (!this.finished) {
      for (let i = 0; i < 16 && !this.finished; i++) this.advance();
      if (now() >= end) break;
    }
    this.elapsedMs += now() - t0;
    return this.progress();
  }

  stepIterations(n: number): SolveProgress {
    const t0 = now();
    const stop = this.iterations + n;
    while (!this.finished && this.iterations < stop) this.advance();
    this.elapsedMs += now() - t0;
    return this.progress();
  }

  /** Runs the search up to its next score evaluation. */
  private advance(): void {
    if (this.iterations >= this.maxIterations || this.budget === 0 || this.gen.next().done) {
      this.finished = true;
    }
  }

  // ---- wall set primitives --------------------------------------------------------------

  private add(c: number): void {
    this.isWall[c] = 1;
    this.cells.push(c);
    this.walls.push(this.coords[c]!);
  }

  /** Removes the wall at index i (the last wall takes its slot). */
  private removeAt(i: number): number {
    const c = this.cells[i]!;
    this.isWall[c] = 0;
    const lastC = this.cells.pop()!;
    const lastW = this.walls.pop()!;
    if (i < this.cells.length) {
      this.cells[i] = lastC;
      this.walls[i] = lastW;
    }
    return c;
  }

  /** Replaces the wall at index i by cell c; returns the old cell. */
  private replaceAt(i: number, c: number): number {
    const old = this.cells[i]!;
    this.isWall[old] = 0;
    this.isWall[c] = 1;
    this.cells[i] = c;
    this.walls[i] = this.coords[c]!;
    return old;
  }

  private clear(): void {
    for (const c of this.cells) this.isWall[c] = 0;
    this.cells.length = 0;
    this.walls.length = 0;
  }

  private load(cells: readonly number[]): void {
    this.clear();
    for (const c of cells) this.add(c);
    this.pathDirty = true;
  }

  private evaluate(): number {
    this.iterations++;
    return this.engine.score(this.walls);
  }

  private record(score: number): void {
    this.cur = score;
    this.pathDirty = true;
    if (score > this.bestScore) {
      this.bestScore = score;
      this.bestCells = this.cells.slice();
      this.onImprove?.(this.progress());
    }
  }

  /** Wallable, non-wall cells on the current path. */
  private currentPath(): number[] {
    if (this.pathDirty) {
      const res = this.engine.compute(this.walls);
      this.path = res.blocked
        ? []
        : pathCells(this.grid, res).filter((c) => this.grid.wallable[c] && !this.isWall[c]);
      this.pathDirty = false;
    }
    return this.path;
  }

  /** A candidate cell for a new wall: usually on the path, sometimes next to it. */
  private candidate(): number {
    const path = this.currentPath();
    const rng = this.rng;
    if (path.length === 0) return this.wallable[rng.int(0, this.wallable.length - 1)]!;
    const p = path[rng.int(0, path.length - 1)]!;
    if (rng.next() >= this.P.pNear) return p;
    const n = this.near[p]!;
    return n.length ? n[rng.int(0, n.length - 1)]! : p;
  }

  // ---- search ------------------------------------------------------------------------------

  private *search(): Generator<void, void, void> {
    const P = this.P;
    // Greedy construction from the starting walls.
    yield* this.greedyFill(P.greedySamples);
    const rng = this.rng;
    const runLength = P.runBase + P.runPerWall * Math.min(this.budget, P.runWallCap);
    for (let run = 0; ; run++) {
      if (run > 0) {
        // Restart from the best set with a share of its walls removed (or from scratch), then refill.
        const fresh = rng.next() < P.pFresh;
        this.load(this.bestCells);
        const share = fresh ? 1 : P.dropMin + P.dropRange * rng.next();
        const drop = Math.max(1, Math.round(this.cells.length * share));
        for (let k = 0; k < drop && this.cells.length > 0; k++) {
          this.removeAt(rng.int(0, this.cells.length - 1));
        }
        this.cur = this.evaluate();
        yield;
        this.pathDirty = true;
        yield* this.greedyFill(fresh ? P.greedySamples : P.restartSamples);
      }
      yield* this.anneal(runLength);
    }
  }

  /** Adds walls one at a time, each the best of up to `samples` path cells, while under budget. */
  private *greedyFill(samples: number): Generator<void, void, void> {
    const rng = this.rng;
    while (this.cells.length < this.budget) {
      const path = this.currentPath();
      if (path.length === 0) return;
      // Distinct candidates from the path.
      const tried = new Set<number>();
      let bestC = -1;
      let bestS = -1;
      let ties = 0;
      for (let k = 0; k < samples * 3 && tried.size < samples; k++) {
        const c = path[rng.int(0, path.length - 1)]!;
        if (tried.has(c)) continue;
        tried.add(c);
        this.add(c);
        const s = this.evaluate();
        this.removeAt(this.cells.length - 1);
        yield;
        if (s > bestS) {
          bestS = s;
          bestC = c;
          ties = 1;
        } else if (s === bestS && rng.next() * ++ties < 1) {
          bestC = c;
        }
      }
      if (bestC < 0 || bestS < 0) return; // every sampled cell blocks
      this.add(bestC);
      this.record(bestS);
    }
  }

  private *anneal(length: number): Generator<void, void, void> {
    const rng = this.rng;
    const P = this.P;
    const t0 = P.tempBase + P.tempFrac * Math.max(0, this.bestScore);
    const t1 = P.tempEnd;
    for (let it = 0; it < length; it++) {
      const temp = t0 * Math.pow(t1 / t0, it / length);
      const n = this.cells.length;
      if (n > 0 && rng.next() < P.pRelocate) {
        yield* this.relocate(temp);
        it += P.relocateSamples;
        continue;
      }
      const r = rng.next();
      let undo: () => void;
      if (n < this.budget && (n === 0 || r < P.pAdd)) {
        // Add a wall on the path.
        const c = this.candidate();
        if (this.isWall[c] || !this.grid.wallable[c]) continue;
        this.add(c);
        undo = () => this.removeAt(this.cells.length - 1);
      } else if (n === 0) {
        return;
      } else if (r < P.pShift) {
        // Shift a wall to a neighbouring cell.
        const i = rng.int(0, n - 1);
        const nb = this.near[this.cells[i]!]!;
        if (nb.length === 0) continue;
        const c = nb[rng.int(0, nb.length - 1)]!;
        if (this.isWall[c]) continue;
        const old = this.replaceAt(i, c);
        undo = () => this.replaceAt(i, old);
      } else if (r < P.pMove || n < 2) {
        // Move a wall onto (or next to) the path.
        const c = this.candidate();
        if (this.isWall[c]) continue;
        const i = rng.int(0, n - 1);
        const old = this.replaceAt(i, c);
        undo = () => this.replaceAt(i, old);
      } else {
        // Move two walls at once.
        const c1 = this.candidate();
        const c2 = this.candidate();
        if (this.isWall[c1] || this.isWall[c2] || c1 === c2) continue;
        const i = rng.int(0, n - 1);
        let j = rng.int(0, n - 2);
        if (j >= i) j++;
        const o1 = this.replaceAt(i, c1);
        const o2 = this.replaceAt(j, c2);
        undo = () => {
          this.replaceAt(j, o2);
          this.replaceAt(i, o1);
        };
      }
      const s = this.evaluate();
      yield;
      const delta = s - this.cur;
      if (s >= 0 && (delta >= 0 || rng.next() < Math.exp(delta / temp))) {
        this.record(s);
      } else {
        undo();
      }
    }
  }

  /**
   * Removes a random wall, re-traces the (now shorter or equal) path, and puts the wall back on
   * the best of a few cells of the new path. Accepted like any other annealing move.
   */
  private *relocate(temp: number): Generator<void, void, void> {
    const rng = this.rng;
    const old = this.removeAt(rng.int(0, this.cells.length - 1));
    this.iterations++;
    const res = this.engine.compute(this.walls);
    yield;
    const path = pathCells(this.grid, res);
    let bestC = -1;
    let bestS = -1;
    for (let k = 0; k < this.P.relocateSamples; k++) {
      const c = path[rng.int(0, path.length - 1)]!;
      if (c === old || this.isWall[c] || !this.grid.wallable[c]) continue;
      this.add(c);
      const s = this.evaluate();
      this.removeAt(this.cells.length - 1);
      yield;
      if (s > bestS) {
        bestS = s;
        bestC = c;
      }
    }
    const delta = bestS - this.cur;
    if (bestS >= 0 && (delta >= 0 || rng.next() < Math.exp(delta / temp))) {
      this.add(bestC);
      this.record(bestS);
    } else {
      this.add(old);
    }
  }
}
