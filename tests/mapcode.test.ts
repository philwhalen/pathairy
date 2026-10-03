import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatXY,
  mapJsonToMapData,
  parseMapCode,
  parseSolution,
  parseXY,
  serializeMapCode,
  serializeSolution,
} from '../src/engine/mapcode';

const API = join(__dirname, '..', 'reference', 'original', 'api');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : [],
  );
}

function load(path: string): any {
  const txt = readFileSync(path, 'utf8');
  try {
    return JSON.parse(txt.slice(txt.indexOf('{')));
  } catch {
    return null;
  }
}

const files = walk(API);
const jsons = files.map((f) => ({ f, j: load(f) })).filter((x) => x.j);
const maps = jsons.filter((x) => x.j.code && x.j.tiles);

describe('map code round trip (reference data)', () => {
  it('finds the reference maps', () => {
    expect(maps.length).toBeGreaterThan(150);
  });

  for (const { f, j } of maps) {
    it(f.slice(API.length + 1), () => {
      const data = mapJsonToMapData(j);
      expect(serializeMapCode(data)).toBe(j.code);
      const parsed = parseMapCode(j.code);
      expect(parsed.tiles).toEqual(data.tiles);
      expect(parsed.width).toBe(Number(j.width));
      expect(parsed.height).toBe(Number(j.height));
      expect(parsed.walls).toBe(Number(j.walls));
      expect(parsed.name).toBe(j.name);
      expect(serializeMapCode(parsed)).toBe(j.code);
    });
  }

  it('round trips mapcodeExecuted in probes and getpath responses', () => {
    let n = 0;
    for (const { j } of jsons) {
      if (typeof j.mapcodeExecuted !== 'string') continue;
      const parsed = parseMapCode(j.mapcodeExecuted);
      // probe_multistart has entries past the end of the grid, which the server ignores.
      if (j.mapcodeExecuted.startsWith('3.3.0.M...:')) continue;
      // two probe_r* maps end in a bare trailing gap ('3,'), which is non-canonical.
      if (!j.mapcodeExecuted.endsWith('.')) continue;
      expect(serializeMapCode(parsed)).toBe(j.mapcodeExecuted);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(10);
  });
});

describe('solution round trip (reference data)', () => {
  it('scoreboard solutions', () => {
    let n = 0;
    for (const { f, j } of jsons) {
      if (!f.includes('scores') || !j.users) continue;
      for (const u of Object.values<any>(j.users)) {
        if (typeof u.solution !== 'string') continue;
        expect(serializeSolution(parseSolution(u.solution))).toBe(u.solution);
        n++;
      }
    }
    expect(n).toBeGreaterThan(500);
  });

  it('probe usedSolution', () => {
    let n = 0;
    for (const { j } of jsons) {
      if (typeof j.usedSolution !== 'string') continue;
      expect(serializeSolution(parseSolution(j.usedSolution))).toBe(j.usedSolution);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(20);
  });
});

describe('unit tests', () => {
  it('parses the report example', () => {
    const m = parseMapCode('13.6.8.Simple...:,s1.11,r3.,r3.1,r1.');
    expect(m).toMatchObject({ width: 13, height: 6, walls: 8, name: 'Simple' });
    expect(m.tiles[0]![0]).toEqual({ type: 's', value: 1 });
    expect(m.tiles[0]![12]).toEqual({ type: 'r', value: 3 });
    expect(m.tiles[1]![0]).toEqual({ type: 'r', value: 3 });
    expect(m.tiles[1]![2]).toEqual({ type: 'r', value: 1 });
    expect(m.tiles[1]![1]).toEqual({ type: 'o', value: 1 });
  });

  it('omits trailing open tiles and encodes gaps', () => {
    const m = parseMapCode('5.1.1.B...:,s1.3,f1.');
    expect(m.tiles[0]!.map((t) => t.type).join('')).toBe('sooof');
    expect(serializeMapCode(m)).toBe('5.1.1.B...:,s1.3,f1.');
    const open = parseMapCode('3.1.0.E...:,s1.');
    expect(serializeMapCode(open)).toBe('3.1.0.E...:,s1.');
  });

  it('rejects malformed codes', () => {
    expect(() => parseMapCode('nonsense')).toThrow();
    expect(
      parseMapCode('2.2.0.X...:9,r1.')
        .tiles.flat()
        .every((t) => t.type === 'o'),
    ).toBe(true);
    expect(() => parseMapCode('2.2.0.X...:,q1.')).toThrow();
  });

  it('solutions use row,col order', () => {
    expect(parseSolution('.3,5.4,6.:')).toEqual([
      { row: 3, col: 5 },
      { row: 4, col: 6 },
    ]);
    expect(serializeSolution([{ row: 3, col: 5 }])).toBe('.3,5.:');
    expect(serializeSolution([])).toBe('..:');
    expect(parseSolution('..:')).toEqual([]);
    expect(parseSolution('.1,2.3,4.')).toHaveLength(2); // old format without ":"
  });

  it('converts server x,y to row,col', () => {
    expect(parseXY('12,4')).toEqual({ row: 4, col: 12 });
    expect(formatXY({ row: 4, col: 12 })).toBe('12,4');
  });
});
