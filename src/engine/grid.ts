/**
 * Flat, typed-array view of a map for the pathing engine. Cells are indexed row-major:
 * `cell = row * width + col`. Directions use the server's numbering.
 */
import type { Coord, MapData, Tile } from './types';
import { blocksPath, isIce, isWallable } from './rules';

export const UP = 1;
export const RIGHT = 2;
export const DOWN = 3;
export const LEFT = 4;
/** Direction tokens in tie-break priority order: Up, Right, Down, Left (PROBED). */
export const DIRS = [UP, RIGHT, DOWN, LEFT] as const;
export type Dir = (typeof DIRS)[number];

/** The direction pointing the other way (1<->3, 2<->4). */
export function opposite(d: number): number {
  return ((d + 1) & 3) + 1;
}

export interface Grid {
  readonly width: number;
  readonly height: number;
  /** width * height */
  readonly size: number;
  /** tiles in row-major order */
  readonly tiles: readonly Tile[];
  /** `nbr[cell * 4 + dir - 1]` = neighbouring cell in that direction, or -1 off the grid. */
  readonly nbr: Int32Array;
  /** 1 where a player may place a wall. */
  readonly wallable: Uint8Array;
  /** Per path (index 0 = path 1, 1 = path 2): 1 where the tile itself lets that path pass. */
  readonly passable: readonly [Uint8Array, Uint8Array];
  /**
   * Search states. States `0..size-1` are "standing on this cell" (non-ice cells). Each ice cell
   * has 4 more states, "on this ice cell, moving in direction d": `iceState[cell] + d - 1`.
   */
  readonly stateCount: number;
  /** First of the 4 states of an ice cell, or -1 for non-ice cells. */
  readonly iceState: Int32Array;
  /** state -> cell */
  readonly stateCell: Int32Array;
  /** state -> direction of travel on ice (0 for plain cell states). */
  readonly stateDir: Uint8Array;
}

export function buildGrid(map: MapData): Grid {
  const { width, height } = map;
  const size = width * height;
  const tiles: Tile[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) tiles.push(map.tiles[r]![c]!);
  }

  const nbr = new Int32Array(size * 4);
  for (let cell = 0; cell < size; cell++) {
    const r = Math.floor(cell / width);
    const c = cell % width;
    nbr[cell * 4 + UP - 1] = r > 0 ? cell - width : -1;
    nbr[cell * 4 + RIGHT - 1] = c < width - 1 ? cell + 1 : -1;
    nbr[cell * 4 + DOWN - 1] = r < height - 1 ? cell + width : -1;
    nbr[cell * 4 + LEFT - 1] = c > 0 ? cell - 1 : -1;
  }

  const wallable = new Uint8Array(size);
  const pass1 = new Uint8Array(size);
  const pass2 = new Uint8Array(size);
  const iceState = new Int32Array(size).fill(-1);
  let iceCount = 0;
  for (let cell = 0; cell < size; cell++) {
    const t = tiles[cell]!;
    wallable[cell] = isWallable(t) ? 1 : 0;
    pass1[cell] = blocksPath(t, 1) ? 0 : 1;
    pass2[cell] = blocksPath(t, 2) ? 0 : 1;
    if (isIce(t)) iceState[cell] = size + 4 * iceCount++;
  }

  const stateCount = size + 4 * iceCount;
  const stateCell = new Int32Array(stateCount);
  const stateDir = new Uint8Array(stateCount);
  for (let cell = 0; cell < size; cell++) {
    stateCell[cell] = cell;
    const s = iceState[cell]!;
    if (s >= 0) {
      for (let d = 1; d <= 4; d++) {
        stateCell[s + d - 1] = cell;
        stateDir[s + d - 1] = d;
      }
    }
  }

  return {
    width,
    height,
    size,
    tiles,
    nbr,
    wallable,
    passable: [pass1, pass2],
    stateCount,
    iceState,
    stateCell,
    stateDir,
  };
}

export function cellIndex(grid: Pick<Grid, 'width' | 'height'>, c: Coord): number {
  if (c.row < 0 || c.col < 0 || c.row >= grid.height || c.col >= grid.width) return -1;
  return c.row * grid.width + c.col;
}

export function cellCoord(grid: Pick<Grid, 'width'>, cell: number): Coord {
  return { row: Math.floor(cell / grid.width), col: cell % grid.width };
}

/** Server "x,y" (= "col,row") string for a cell. */
export function cellXY(grid: Pick<Grid, 'width'>, cell: number): string {
  return `${cell % grid.width},${Math.floor(cell / grid.width)}`;
}
