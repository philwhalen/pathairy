/**
 * Web Worker that runs the solver off the main thread. One job per worker: the page posts a
 * `SolveRequest`, gets `SolveUpdate`s whenever the best score improves, and a final one with
 * `done: true`. To cancel, the page terminates the worker.
 */
import { createSolver } from './solve';
import type { Coord, MapData } from '../engine/types';

export interface SolveRequest {
  map: MapData;
  seed: number;
  timeLimitMs: number;
}

export interface SolveUpdate {
  moves: number;
  walls: Coord[];
  elapsedMs: number;
  done: boolean;
}

const STEP_MS = 50;
/** `self` is typed as a Window under the DOM lib; this is the worker's postMessage. */
const post = (m: SolveUpdate) =>
  (self as unknown as { postMessage(m: unknown): void }).postMessage(m);

self.onmessage = (e: MessageEvent<SolveRequest>) => {
  const { map, seed, timeLimitMs } = e.data;
  const solver = createSolver(map, { seed });
  let last = -1;
  const tick = () => {
    const p = solver.step(STEP_MS);
    const done = p.done || p.elapsedMs >= timeLimitMs;
    if (p.moves !== last || done) {
      last = p.moves;
      post({ moves: p.moves, walls: p.walls, elapsedMs: p.elapsedMs, done });
    }
    if (!done) setTimeout(tick, 0);
  };
  tick();
};
