import type { Coord, MapData, Tile, TileType } from '../engine/types';
import { computePaths } from '../engine/pathing';
import { MAP_TYPES, PRESETS } from './presets';
import type { MapType, Region, Weighted } from './presets';
import { createRng } from './rng';
import type { Rng } from './rng';

export type { MapType } from './presets';
export { MAP_TYPES } from './presets';

export interface GeneratedMap {
  key: string;
  type: MapType;
  seed: number;
  map: MapData;
  /** How many candidate maps were rolled before one passed validation (site: numberOfAttempts). */
  attempts: number;
}

const MAX_ATTEMPTS = 1000;

export function randomSeed(): number {
  return 100000 + Math.floor(Math.random() * 900000);
}

export function mapKey(type: MapType, seed: number): string {
  return `${type}-${seed}`;
}

export function parseMapKey(key: string): { type: MapType; seed: number } | null {
  const m = /^([a-z]+)-(\d+)$/.exec(key.trim().toLowerCase());
  if (!m) return null;
  const type = MAP_TYPES.find((t) => t === m[1]);
  const seed = Number(m[2]);
  if (!type || !Number.isSafeInteger(seed)) return null;
  return { type, seed };
}

const tile = (type: TileType, value = 1): Tile => ({ type, value });

/** Fixed layout of a type: borders plus start/finish. */
function emptyGrid(type: MapType, rng: Rng): Tile[][] {
  const p = PRESETS[type];
  const tiles = Array.from({ length: p.height }, () =>
    Array.from({ length: p.width }, () => tile('o')),
  );
  const l = p.layout;
  if (l.kind === 'fixed') {
    tiles[l.start.row]![l.start.col] = tile('s');
    tiles[l.finish.row]![l.finish.col] = tile('f');
    return tiles;
  }
  const fillEdge = (col: number, kind: 'one-in-rock-border' | 'all', t: TileType) => {
    const special = kind === 'all' ? -1 : rng.int(0, p.height - 1);
    for (let row = 0; row < p.height; row++) {
      tiles[row]![col] = kind === 'all' || row === special ? tile(t) : tile('r', 3);
    }
  };
  fillEdge(0, l.left, 's');
  fillEdge(p.width - 1, l.right, 'f');
  return tiles;
}

function freeCells(tiles: Tile[][], r: Region): Coord[] {
  const out: Coord[] = [];
  for (let row = r.row0; row <= r.row1; row++) {
    for (let col = r.col0; col <= r.col1; col++) {
      if (tiles[row]![col]!.type === 'o') out.push({ row, col });
    }
  }
  return out;
}

/** Puts a tile on a random free cell of the region; returns false if the region is full. */
function place(tiles: Tile[][], rng: Rng, region: Region, t: Tile): boolean {
  const cells = freeCells(tiles, region);
  if (cells.length === 0) return false;
  const c = rng.pick(cells);
  tiles[c.row]![c.col] = t;
  return true;
}

function roll(type: MapType, rng: Rng): MapData {
  const p = PRESETS[type];
  const tiles = emptyGrid(type, rng);
  const count = (w: Weighted[]) => rng.weighted(w);

  const nCp = count(p.checkpoints.count);
  for (let i = 1; i <= nCp; i++) place(tiles, rng, p.checkpoints.region, tile('c', i));
  if (p.teleports) {
    const pairs = count(p.teleports.pairs);
    for (let i = 1; i <= pairs; i++) {
      place(tiles, rng, p.teleports.region, tile('t', i));
      place(tiles, rng, p.teleports.region, tile('u', i));
    }
  }
  if (p.ice) {
    const n = count(p.ice.count);
    for (let i = 0; i < n; i++) place(tiles, rng, p.ice.region, tile('z', 5));
  }
  const nRocks = count(p.rocks.count);
  for (let i = 0; i < nRocks; i++) place(tiles, rng, p.rocks.region, tile('r', 1));

  return {
    width: p.width,
    height: p.height,
    walls: count(p.walls),
    name: p.name,
    headerExtra: ['', '', ''],
    tiles,
  };
}

/**
 * Deterministic for (type, seed): one RNG stream is consumed candidate by candidate until a
 * candidate passes validation (no walls placed, every target reachable).
 */
export function generateMap(type: MapType, seed: number): GeneratedMap {
  const rng = createRng(seed);
  for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
    const map = roll(type, rng);
    if (!computePaths(map, []).blocked) {
      return { key: mapKey(type, seed), type, seed, map, attempts };
    }
  }
  throw new Error(`No valid ${type} map for seed ${seed} after ${MAX_ATTEMPTS} attempts`);
}
