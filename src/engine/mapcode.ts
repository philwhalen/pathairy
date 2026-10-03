import type { Coord, MapData, Solution, Tile, TileType } from './types';
import { TILE_TYPES } from './types';

const TILE_RE = /^([a-z])(\d+)$/;

function isTileType(s: string): s is TileType {
  return (TILE_TYPES as readonly string[]).includes(s);
}

/**
 * Map code: `width.height.walls.name.e1.e2.e3:` + body.
 * Body is a list of non-open tiles in row-major order, each as `gap,<type><value>.`
 * (gap = number of open tiles skipped since the previous entry, empty when 0). Trailing open
 * tiles are omitted. Example: `13.6.8.Simple...:,s1.11,r3.` -> s1 at index 0, r3 at index 12.
 */
export function parseMapCode(code: string): MapData {
  const colon = code.indexOf(':');
  if (colon < 0) throw new Error('Map code missing ":"');
  const head = code.slice(0, colon).split('.');
  if (head.length < 7) throw new Error('Map code header too short');
  const width = Number(head[0]);
  const height = Number(head[1]);
  const walls = Number(head[2]);
  if (![width, height, walls].every(Number.isInteger) || width < 1 || height < 1) {
    throw new Error('Bad map code header');
  }
  // The name is head[3]; anything between it and the last 3 fields would be a name containing '.'.
  const name = head.slice(3, head.length - 3).join('.');
  const headerExtra = head.slice(head.length - 3) as [string, string, string];

  const tiles: Tile[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): Tile => ({ type: 'o', value: 1 })),
  );
  const entries = code.slice(colon + 1).split('.');
  // Canonical codes end in '.', so the last segment is ''. Hand-made probes may end in a bare
  // trailing gap like '3,' (no tile); like the server, ignore it.
  const last = entries.pop();
  if (last !== '' && !/^[0-9]*,$/.test(last ?? '')) throw new Error('Bad map code ending');
  let idx = -1;
  for (const entry of entries) {
    const comma = entry.indexOf(',');
    if (comma < 0) throw new Error(`Bad map code entry "${entry}"`);
    const gapStr = entry.slice(0, comma);
    const m = TILE_RE.exec(entry.slice(comma + 1));
    if (!m || !isTileType(m[1]!) || !/^\d*$/.test(gapStr)) {
      throw new Error(`Bad map code entry "${entry}"`);
    }
    idx += 1 + (gapStr === '' ? 0 : Number(gapStr));
    // The server silently ignores entries past the end of the grid (seen in probe_multistart).
    if (idx >= width * height) continue;
    tiles[Math.floor(idx / width)]![idx % width] = { type: m[1], value: Number(m[2]) };
  }
  return { width, height, walls, name, headerExtra, tiles };
}

export function serializeMapCode(map: MapData): string {
  let out = `${map.width}.${map.height}.${map.walls}.${map.name}.${map.headerExtra.join('.')}:`;
  let prev = -1;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const t = map.tiles[row]![col]!;
      if (t.type === 'o') continue;
      const idx = row * map.width + col;
      const gap = idx - prev - 1;
      out += `${gap === 0 ? '' : gap},${t.type}${t.value}.`;
      prev = idx;
    }
  }
  return out;
}

/** Server "x,y" (= "col,row") -> Coord. */
export function parseXY(s: string): Coord {
  const [x, y] = s.split(',').map(Number);
  if (x === undefined || y === undefined || !Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`Bad coordinate "${s}"`);
  }
  return { row: y, col: x };
}

/** Coord -> server "x,y" (= "col,row"). */
export function formatXY(c: Coord): string {
  return `${c.col},${c.row}`;
}

/**
 * Solution string: `.r,c.r,c.:` (row,col order, NOT x,y). Always starts with `.` and ends with
 * `.:`; the empty solution is `..:`. A missing trailing ":" is tolerated when parsing.
 */
export function parseSolution(str: string): Solution {
  const body = str.endsWith(':') ? str.slice(0, -1) : str;
  const walls: Solution = [];
  for (const part of body.split('.')) {
    if (part === '') continue;
    const [row, col] = part.split(',').map(Number);
    if (
      row === undefined ||
      col === undefined ||
      !Number.isInteger(row) ||
      !Number.isInteger(col)
    ) {
      throw new Error(`Bad solution entry "${part}"`);
    }
    walls.push({ row, col });
  }
  return walls;
}

export function serializeSolution(walls: Solution): string {
  return `.${walls.map((w) => `${w.row},${w.col}`).join('.')}.:`;
}

/** Convert a server map JSON (`tiles[row][col] = [type, value]`) to MapData. */
export function mapJsonToMapData(json: {
  width: number | string;
  height: number | string;
  walls: number | string;
  name: string;
  tiles: [string, number][][];
  code?: string;
}): MapData {
  const tiles = json.tiles.map((row) =>
    row.map(([type, value]): Tile => {
      if (!isTileType(type)) throw new Error(`Unknown tile type "${type}"`);
      return { type, value: Number(value) };
    }),
  );
  return {
    width: Number(json.width),
    height: Number(json.height),
    walls: Number(json.walls),
    name: json.name,
    headerExtra: ['', '', ''],
    tiles,
  };
}
