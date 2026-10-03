/**
 * Core data types. Coordinates are always {row, col} internally; the server's "x,y" strings
 * mean col,row and are converted only at the edges (see mapcode.ts).
 */

/**
 * Tile type letters seen in the original site's data:
 * o open, r rock (1-3), s start (1 green, 2 red), f finish, c checkpoint (1..15),
 * t teleport in / u teleport out (paired by value), p unbuildable, x single-path rock (1, 2),
 * z ice (5; 1-4 probably directional, unseen).
 */
export type TileType = 'o' | 'r' | 's' | 'f' | 'c' | 't' | 'u' | 'p' | 'x' | 'z';

export const TILE_TYPES: readonly TileType[] = ['o', 'r', 's', 'f', 'c', 't', 'u', 'p', 'x', 'z'];

export interface Tile {
  type: TileType;
  value: number;
}

export interface Coord {
  row: number;
  col: number;
}

export interface MapData {
  width: number;
  height: number;
  /** Wall budget (the server sends 999 for "unlimited" demo maps). */
  walls: number;
  name: string;
  /** The three trailing header fields of the map code (always empty in observed data). */
  headerExtra: [string, string, string];
  /** tiles[row][col] */
  tiles: Tile[][];
}

/** Player-placed walls, in placement order. */
export type Solution = Coord[];

/** One element of a server pathArray: 1 up, 2 right, 3 down, 4 left; "c1"/"f1"/"r"/"u"/"t1"/"x,y" strings. */
export type Token = string | number;

export interface PathResult {
  tokens: Token[];
  moves: number;
  blocked: boolean;
  /** Server "x,y" = "col,row" strings, as in the getpath response. */
  start: string;
  end: string;
}

export interface PathsResult {
  paths: PathResult[];
  totalMoves: number;
  blocked: boolean;
}
