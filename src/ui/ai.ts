/**
 * Runs the solver for the map on the board in a Web Worker and reports its best score: the
 * "AI best" target. One job at a time; starting a new one (or `cancel`) stops the old one.
 */
import type { MapData } from '../engine/types';
import type { SolveRequest, SolveUpdate } from '../solver/worker';

export type AiUpdate = SolveUpdate;

export class AiRunner {
  private worker: Worker | null = null;

  start(map: MapData, timeLimitMs: number, onUpdate: (u: AiUpdate) => void): boolean {
    this.cancel();
    let worker: Worker;
    try {
      worker = new Worker(new URL('../solver/worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return false; // No workers (old browser or a sandbox that blocks them): no AI target.
    }
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<SolveUpdate>) => {
      if (this.worker !== worker) return;
      if (e.data.done) this.cancel();
      onUpdate(e.data);
    };
    worker.onerror = () => {
      if (this.worker === worker) this.cancel();
    };
    const req: SolveRequest = { map, seed: 1, timeLimitMs };
    worker.postMessage(req);
    return true;
  }

  get isRunning(): boolean {
    return this.worker !== null;
  }

  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
