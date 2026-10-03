/**
 * Per-type generator parameters, derived from 20 sampled maps per type (plan section 6).
 * All counts are drawn independently (walls and rocks are uncorrelated in the samples).
 */

export type MapType = 'simple' | 'normal' | 'complex' | 'centralized';
export const MAP_TYPES: readonly MapType[] = ['simple', 'normal', 'complex', 'centralized'];

export interface Weighted<T = number> {
  value: T;
  weight: number;
}

/** Inclusive cell rectangle. */
export interface Region {
  col0: number;
  col1: number;
  row0: number;
  row1: number;
}

/** What fills the left (start) or right (finish) column. */
export type EdgeKind =
  /** Column of r3 rocks with the single s1/f1 at one random row. */
  | 'one-in-rock-border'
  /** Every cell of the column is s1/f1. */
  | 'all';

export type Layout =
  | { kind: 'edges'; left: EdgeKind; right: EdgeKind }
  /** No borders; single s1 and f1 at fixed cells. */
  | { kind: 'fixed'; start: { row: number; col: number }; finish: { row: number; col: number } };

export interface Preset {
  name: string;
  width: number;
  height: number;
  layout: Layout;
  checkpoints: { count: Weighted[]; region: Region };
  teleports?: { pairs: Weighted[]; region: Region };
  ice?: { count: Weighted[]; region: Region };
  rocks: { count: Weighted[]; region: Region };
  walls: Weighted[];
}

const uniform = (min: number, max: number): Weighted[] =>
  Array.from({ length: max - min + 1 }, (_, i) => ({ value: min + i, weight: 1 }));
const w = (pairs: [number, number][]): Weighted[] =>
  pairs.map(([value, weight]) => ({ value, weight }));

export const PRESETS: Record<MapType, Preset> = {
  simple: {
    name: 'Simple',
    width: 13,
    height: 6,
    layout: { kind: 'edges', left: 'one-in-rock-border', right: 'one-in-rock-border' },
    checkpoints: { count: w([[1, 1]]), region: { col0: 2, col1: 9, row0: 0, row1: 5 } },
    // Rocks never appear in cols 1 and 11 in 102 sampled rocks (cols 2-10 only).
    rocks: { count: uniform(3, 8), region: { col0: 2, col1: 10, row0: 0, row1: 5 } },
    walls: w([
      [6, 20],
      [7, 40],
      [8, 40],
    ]),
  },
  normal: {
    name: 'Normal',
    width: 17,
    height: 9,
    layout: { kind: 'edges', left: 'one-in-rock-border', right: 'all' },
    checkpoints: {
      count: w([
        [1, 50],
        [2, 50],
      ]),
      region: { col0: 1, col1: 14, row0: 0, row1: 8 },
    },
    ice: {
      count: w([
        [0, 90],
        [2, 10],
      ]),
      region: { col0: 1, col1: 15, row0: 0, row1: 8 },
    },
    rocks: {
      count: w([
        [10, 1],
        [12, 1],
        [14, 1],
      ]),
      region: { col0: 1, col1: 15, row0: 0, row1: 8 },
    },
    walls: w([
      [10, 15],
      [11, 15],
      [12, 30],
      [13, 5],
      [14, 35],
    ]),
  },
  complex: {
    name: 'Complex',
    width: 19,
    height: 9,
    layout: { kind: 'edges', left: 'all', right: 'all' },
    checkpoints: {
      count: w([
        [3, 50],
        [4, 20],
        [5, 30],
      ]),
      region: { col0: 1, col1: 17, row0: 0, row1: 8 },
    },
    teleports: {
      pairs: w([
        [1, 75],
        [2, 25],
      ]),
      region: { col0: 1, col1: 17, row0: 0, row1: 8 },
    },
    ice: {
      count: w([
        [0, 60],
        [3, 35],
        [6, 5],
      ]),
      region: { col0: 1, col1: 17, row0: 0, row1: 8 },
    },
    rocks: {
      count: w([
        [8, 10],
        [11, 45],
        [14, 45],
      ]),
      region: { col0: 1, col1: 17, row0: 0, row1: 8 },
    },
    walls: uniform(15, 22),
  },
  centralized: {
    name: 'Centralized',
    width: 19,
    height: 9,
    layout: { kind: 'fixed', start: { row: 4, col: 8 }, finish: { row: 4, col: 10 } },
    // Checkpoints never landed in col 18 (60 sampled); rocks use the whole grid.
    checkpoints: { count: w([[3, 1]]), region: { col0: 0, col1: 17, row0: 0, row1: 8 } },
    rocks: { count: uniform(16, 20), region: { col0: 0, col1: 18, row0: 0, row1: 8 } },
    walls: w([
      [16, 35],
      [17, 40],
      [19, 15],
      [20, 10],
    ]),
  },
};
