/**
 * Game rules that decide how tiles behave, kept in one place so that each can be changed alone
 * when new server evidence arrives. Each rule notes its source:
 *   PROBED  = confirmed by a recorded server response (tests/fixtures/oracle) or the scoreboard
 *   NOT PROBED = a guess; noted where it matters
 *
 * Movement on ice is part of the search itself: see the "Movement rule" comment on
 * `distanceField` in pathing.ts (the walk and the backward search must stay inverse to each other).
 */
import type { Tile } from './types';

/** Path numbers: 1 = green (starts on s1), 2 = red (starts on s2). */
export type PathNo = 1 | 2;

/**
 * Whether a tile blocks the given path (player walls are handled separately).
 * PROBED: r1/r2/r3 all block (probe_r2, probe_r3); x1 blocks path 1 and x2 blocks path 2, also on
 * single-path maps (probe_x1single, probe_x2single, probe_demo2); z1 blocks like a rock
 * (z1_center, z1_down). Every other tile (s, f, c, t, u, p, o, z2-z5) is passable.
 */
export function blocksPath(tile: Tile, pathNo: PathNo): boolean {
  if (tile.type === 'r') return true;
  if (tile.type === 'x') return tile.value === pathNo;
  if (tile.type === 'z') return tile.value === 1;
  return false;
}

/**
 * Ice ("directional force") tiles: the path keeps its direction while on them.
 * PROBED: z5 is ice (probe_ice, ice_* fixtures). z2, z3, z4 are plain tiles (z*_center/down/left;
 * moving up onto them not tested). z1 is impassable, see `blocksPath`.
 */
export function isIce(tile: Tile): boolean {
  return tile.type === 'z' && tile.value === 5;
}

/** Tiles a player may place a wall on. PROBED: only `o` (server answers "Invalid solution"). */
export function isWallable(tile: Tile): boolean {
  return tile.type === 'o';
}

/** Start tiles of a path: s1 for path 1, s2 for path 2. PROBED (probe_demo2, probe_dual3cp). */
export function isStart(tile: Tile, pathNo: PathNo): boolean {
  return tile.type === 's' && tile.value === pathNo;
}

/** Finish tiles. The token is always "f1". */
export function isFinish(tile: Tile): boolean {
  return tile.type === 'f';
}

export const FINISH_LABEL = 'f1';

/**
 * Checkpoint numbers visited by a path, in order, given the numbers present on the map.
 * PROBED: targets are c1..cN with N = the highest number present; path 2 visits them in reverse
 * (probe_dual3cp). A number with no tile is an unreachable target, so the path is blocked there
 * (cp_gap_* fixtures).
 */
export function checkpointSequence(present: ReadonlySet<number>, pathNo: PathNo): number[] {
  const max = Math.max(0, ...present);
  const seq = Array.from({ length: max }, (_, i) => i + 1);
  return pathNo === 2 ? seq.reverse() : seq;
}

/**
 * Whether teleport usage is shared between the two paths of a dual-path map.
 * PROBED: no, each path has its own set of spent teleports (dual_tp_shared_state,
 * dual_tp_reuse_twice).
 */
export const TELEPORTS_SHARED_BETWEEN_PATHS = false;

/**
 * Stepping onto a `tN` that cannot warp: PROBED for "no `uN` on the map" (t_no_exit): the path is
 * blocked, and its pathArray ends with the moves up to the teleport, then "r". A `uN` without `tN`
 * is a plain tile (u_no_entry).
 * NOT PROBED: `uN` tiles exist but none can reach the target. Treated the same way here.
 */
export const FAILED_WARP_TOKEN = 'r';

/**
 * PROBED (cp_gap_dual): the server stops at the first blocked path and reports only the paths up
 * to and including it. Which path is reported when only path 2 is blocked was not tested (path 1
 * is computed first, so it is reported in full).
 */
export const STOP_AT_FIRST_BLOCKED_PATH = true;

/**
 * Choosing among several cells to continue from (several start tiles, or several `uN` exits
 * after a warp). `cells` are in row-major order; `dist[cell]` is the distance to the current
 * target (-1 = unreachable). Returns the index into `cells`, or -1 if none can reach the target.
 * PROBED: the nearest by real path distance wins (probe_startnear, u_far_exit_nearest_target,
 * u_three_exits, u_manhattan_vs_path), ties -> first in row-major order (probe_starttie,
 * u_exit_tie_equal_dist), unreachable cells are never chosen (u_sealed_exit).
 * Note: "first in row-major order" is also what makes this equal to a search that explores all
 * sources at once with U, R, D, L priority.
 */
export function pickNearest(cells: ArrayLike<number>, dist: ArrayLike<number>): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const d = dist[cells[i]!]!;
    if (d >= 0 && d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}
