import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMapCode, parseSolution } from '../src/engine/mapcode';
import { computePaths, createEngine, validateSolution } from '../src/engine/pathing';
import type { Coord, MapData, PathsResult, Tile, TileType } from '../src/engine/types';

const FIXTURES = join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------------------------
// Server fixtures: every recorded getpath response must match exactly.

interface ServerPath {
  start: string;
  end: string;
  moves: number;
  blocked?: boolean;
  pathArray: (string | number)[];
}
interface OracleFixture {
  name: string;
  code: string;
  solution: string;
  error?: boolean;
  response: { totalMoves: number; blocked?: boolean; path: ServerPath[] };
}

const oracleDir = join(FIXTURES, 'oracle');
const oracle: OracleFixture[] = readdirSync(oracleDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(oracleDir, f), 'utf8')) as OracleFixture)
  .filter((o) => !o.error && Array.isArray(o.response?.path));

/** The comparable part of a result (a blocked path's `end` is junk on the server). */
function shape(
  paths: { tokens: unknown; moves: number; blocked: boolean; start: string; end: string }[],
) {
  return paths.map((p) => ({
    tokens: p.tokens,
    moves: p.moves,
    blocked: p.blocked,
    start: p.start,
    end: p.blocked ? null : p.end,
  }));
}

describe('server fixtures (tests/fixtures/oracle)', () => {
  it('has fixtures', () => {
    expect(oracle.length).toBeGreaterThanOrEqual(20);
  });

  for (const o of oracle) {
    it(o.name, () => {
      const r = computePaths(parseMapCode(o.code), parseSolution(o.solution));
      const s = o.response;
      const expected = shape(
        s.path.map((p) => ({ ...p, tokens: p.pathArray, blocked: !!p.blocked })),
      );
      expect(shape(r.paths)).toEqual(expected);
      expect(r.totalMoves).toBe(s.totalMoves);
      expect(r.blocked).toBe(!!s.blocked);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Scoreboard: server-scored real solutions. `moves` is the total over both paths on dual maps.

interface ScoreRow {
  mapId: number;
  name: string;
  code: string;
  solution: string;
  moves: number;
  features: string[];
}
const rows: ScoreRow[] = JSON.parse(readFileSync(join(FIXTURES, 'scoreboard.json'), 'utf8'));
const byMap = new Map<number, ScoreRow[]>();
for (const r of rows) byMap.set(r.mapId, [...(byMap.get(r.mapId) ?? []), r]);

describe('scoreboard rows (tests/fixtures/scoreboard.json)', () => {
  it('has rows', () => {
    expect(rows.length).toBeGreaterThan(500);
  });

  for (const [mapId, list] of byMap) {
    const f = list[0]!.features.join('+') || 'plain';
    it(`map ${mapId} (${f}, ${list.length} solutions)`, () => {
      const engine = createEngine(parseMapCode(list[0]!.code));
      for (const r of list) {
        const walls = parseSolution(r.solution);
        expect(validateSolution(engine.map, walls), r.solution).toBeNull();
        const res = engine.compute(walls);
        expect(res.totalMoves, r.solution).toBe(r.moves);
        expect(engine.score(walls), r.solution).toBe(r.moves);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Hand-written rule tests on small grids.

/**
 * ASCII map: `.` open, `#` r1, `S` s1, `R` s2, `F` f1, `1`-`9` checkpoints, `a`-`g` t1-t7,
 * `A`-`G` u1-u7, `Z` z5 (ice), `p` p1, `x` x1, `y` x2, `k`-`n` z1-z4, `W` = player wall on `o`.
 */
function board(rows: string[]): { map: MapData; walls: Coord[] } {
  const walls: Coord[] = [];
  const tiles = rows.map((line, row) =>
    [...line].map((ch, col): Tile => {
      const t = (type: TileType, value = 1): Tile => ({ type, value });
      if (ch === '.') return t('o');
      if (ch === 'W') {
        walls.push({ row, col });
        return t('o');
      }
      if (ch === '#') return t('r');
      if (ch === 'S') return t('s', 1);
      if (ch === 'R') return t('s', 2);
      if (ch === 'F') return t('f');
      if (ch === 'Z') return t('z', 5);
      if (ch === 'p') return t('p');
      if (ch === 'x') return t('x', 1);
      if (ch === 'y') return t('x', 2);
      if (/[1-9]/.test(ch)) return t('c', Number(ch));
      if (/[a-g]/.test(ch)) return t('t', ch.charCodeAt(0) - 96);
      if (/[A-G]/.test(ch)) return t('u', ch.charCodeAt(0) - 64);
      if (/[k-n]/.test(ch)) return t('z', ch.charCodeAt(0) - 106);
      throw new Error(`bad board char ${ch}`);
    }),
  );
  const map: MapData = {
    width: rows[0]!.length,
    height: rows.length,
    walls: 999,
    name: 'T',
    headerExtra: ['', '', ''],
    tiles,
  };
  return { map, walls };
}

function run(rows: string[]): PathsResult {
  const { map, walls } = board(rows);
  return computePaths(map, walls);
}

const tokens = (r: PathsResult) => r.paths.map((p) => p.tokens);

describe('rules: shortest path and tie-breaking', () => {
  it('prefers Up, then Right, then Down, then Left', () => {
    expect(tokens(run(['...F', '....', 'S...']))).toEqual([['f1', 1, 1, 2, 2, 2, 'r']]);
    expect(tokens(run(['...S', '....', 'F...']))).toEqual([['f1', 3, 3, 4, 4, 4, 'r']]);
    expect(tokens(run(['S..', '...', '..F']))).toEqual([['f1', 2, 2, 3, 3, 'r']]);
  });

  it('goes greedily to the current target only', () => {
    // c1 is right next to the start; the path goes there even though F then costs more.
    const r = run(['F.S1']);
    expect(tokens(r)).toEqual([['c1', 2, 'r', 'f1', 4, 4, 4, 'r']]);
    expect(r.totalMoves).toBe(4);
  });

  it('reports start/end as "x,y" (col,row)', () => {
    const r = run(['....', '.S..', '...F']);
    expect(r.paths[0]).toMatchObject({ start: '1,1', end: '3,2', moves: 3, blocked: false });
  });
});

describe('rules: passability', () => {
  it('rocks and walls block; walls on non-open tiles are ignored', () => {
    expect(run(['S#F', '...']).totalMoves).toBe(4);
    expect(run(['SWF', '...']).totalMoves).toBe(4);
    const { map } = board(['S.F', '...']);
    for (const value of [2, 3]) {
      map.tiles[0]![1] = { type: 'r', value };
      expect(computePaths(map, []).totalMoves).toBe(4);
    }
    // A wall on the finish tile is not a legal wall: ignored by the engine, rejected by the server.
    expect(computePaths(map, [{ row: 0, col: 2 }]).totalMoves).toBe(4);
    expect(validateSolution(map, [{ row: 0, col: 2 }])).toBe('Invalid solution');
  });

  it('validateSolution mirrors the server checks', () => {
    const { map } = board(['S..F']);
    map.walls = 1;
    expect(validateSolution(map, [{ row: 0, col: 1 }])).toBeNull();
    expect(validateSolution(map, [{ row: 0, col: 9 }])).toBe('Invalid solution');
    expect(
      validateSolution(map, [
        { row: 0, col: 1 },
        { row: 0, col: 2 },
      ]),
    ).toBe('Out of walls???');
  });

  it('p1 is passable', () => {
    expect(run(['SpF']).totalMoves).toBe(2);
  });

  it('x1 blocks path 1 only, x2 blocks path 2 only', () => {
    expect(run(['SxF', '...']).totalMoves).toBe(4);
    expect(run(['SyF', '...']).totalMoves).toBe(2);
    const dual = run(['SxF', '.y.', 'R..']);
    // green (blocked by x): down is y (passable for green) -> 1,1 then right... shortest is 4
    expect(dual.paths.map((p) => p.moves)).toEqual([4, 4]);
    expect(tokens(dual)[1]).toEqual(['f1', 1, 1, 2, 2, 'r']); // red goes through x1 (row 0)
  });

  it('z1 blocks like a rock; z2-z4 are plain', () => {
    expect(run(['SkF', '...']).totalMoves).toBe(4);
    for (const z of 'lmn') expect(run([`S${z}F`, '...']).totalMoves).toBe(2);
  });

  it('fully blocked map: blocked, score 0, partial tokens', () => {
    const r = run(['S.W.F']);
    expect(r).toEqual({
      blocked: true,
      totalMoves: 0,
      paths: [{ tokens: ['f1'], moves: 0, blocked: true, start: '0,0', end: '0,0' }],
    });
    const { map, walls } = board(['S.W.F']);
    expect(createEngine(map).score(walls)).toBe(-1);
  });
});

describe('rules: targets', () => {
  it('visits checkpoints in order, path 2 in reverse', () => {
    const r = run(['S.1.2.3', '......F', 'R......']);
    expect(tokens(r)[0]).toEqual(['c1', 2, 2, 'r', 'c2', 2, 2, 'r', 'c3', 2, 2, 'r', 'f1', 3, 'r']);
    expect(tokens(r)[1]![0]).toBe('c3');
    expect(tokens(r)[1]!.filter((t) => typeof t === 'string')).toEqual([
      'c3',
      'r',
      'c2',
      'r',
      'c1',
      'r',
      'f1',
      'r',
    ]);
  });

  it('goes to the nearest copy of a target; unreachable copies are ignored', () => {
    expect(run(['F..S...F']).paths[0]!.end).toBe('0,0');
    expect(run(['F#S..F']).paths[0]!.end).toBe('5,0');
  });

  it('a missing checkpoint number blocks the path there', () => {
    const r = run(['S.1..3F']);
    expect(r.blocked).toBe(true);
    expect(tokens(r)).toEqual([['c1', 2, 2, 'r', 'c2']]);
  });

  it('only the first blocked path is reported', () => {
    const r = run(['S.1..3F', 'R......']);
    expect(r.paths).toHaveLength(1);
    expect(r.totalMoves).toBe(0);
  });

  it('several starts: nearest wins, ties go to the first in row-major order', () => {
    expect(run(['S..S.F']).paths[0]!.start).toBe('3,0');
    expect(run(['S.F.S']).paths[0]!.start).toBe('0,0');
    expect(run(['..S', 'S.F']).paths[0]!.start).toBe('2,0');
  });
});

describe('rules: teleports', () => {
  it('warps on first use (0 moves), then emits tN on later visits', () => {
    // probe_teleport layout
    const r = run(['S..a..F', '.......', '...A...']);
    expect(tokens(r)).toEqual([['f1', 2, 2, 2, 'u', '3,2', 'u', 1, 1, 't1', 2, 2, 2, 'r']]);
    expect(r.totalMoves).toBe(8);
  });

  it('spends every tN of that number at once', () => {
    const r = run(['Sa.a..F', '.......', '..A....']);
    expect(tokens(r)).toEqual([['f1', 2, 'u', '2,2', 'u', 1, 1, 2, 't1', 2, 2, 2, 'r']]);
  });

  it('uses the uN exit nearest to the current target, tie -> row-major first', () => {
    expect(tokens(run(['Sa.A...A.F']))).toEqual([['f1', 2, 'u', '7,0', 'u', 2, 2, 'r']]);
    expect(tokens(run(['.A.', 'Sa.', '.AF']))[0]).toContain('1,2');
    expect(tokens(run(['.A.', 'Sa.', '.A.', '..F']))[0]).toContain('1,2');
    expect(tokens(run(['.A..', 'Sa.F', '.A..']))[0]).toContain('1,0');
  });

  it('a tN with no uN blocks the path, ending with "r"', () => {
    const r = run(['S.a..F']);
    expect(r.blocked).toBe(true);
    expect(tokens(r)).toEqual([['f1', 2, 2, 'r']]);
  });

  it('a uN with no tN is a plain tile', () => {
    expect(run(['S.A..F']).totalMoves).toBe(5);
  });

  it('teleport state is per path', () => {
    const r = run(['SR.a.A...F']);
    expect(r.paths.map((p) => p.tokens.includes('u'))).toEqual([true, true]);
  });

  it('teleports are not planned for: the route ignores them', () => {
    // Going via the teleport would be shorter, but it is not on the shortest route.
    expect(tokens(run(['S...F', '.....', 'a.A..']))).toEqual([['f1', 2, 2, 2, 2, 'r']]);
  });
});

describe('rules: ice (z5)', () => {
  it('cannot turn on ice (probe_ice)', () => {
    const r = computePaths(
      parseMapCode(
        '8.6.999.Pathing Demo 4...:8,r1.,r1.3,r1.2,s1.1,z5.,z5.,z5.3,r1.,r1.3,r1.13,f1.',
      ),
      [],
    );
    expect(r.totalMoves).toBe(12);
  });

  it('blocks at a dead end (rock, edge or wall ahead)', () => {
    expect(run(['SZ#', '#F#']).blocked).toBe(true);
    expect(run(['SZ', '#F']).blocked).toBe(true);
    expect(run(['SZW.', '.#F#']).blocked).toBe(true);
  });

  it('can turn on the first plain tile after ice', () => {
    expect(tokens(run(['SZ..', '##F#']))).toEqual([['f1', 2, 2, 3, 'r']]);
  });

  it('ties are broken in U,R,D,L order over the ice-aware search', () => {
    expect(tokens(run(['SZ.', '..F']))).toEqual([['f1', 2, 2, 3, 'r']]);
  });

  it('slides across several ice tiles, and avoids ice when that is shorter', () => {
    expect(tokens(run(['SZZZ.', '....F']))).toEqual([['f1', 2, 2, 2, 2, 3, 'r']]);
    expect(tokens(run(['SZZ#F', '.....']))).toEqual([['f1', 3, 2, 2, 2, 2, 1, 'r']]);
    expect(tokens(run(['.....', 'SZZ..', '..F..']))).toEqual([['f1', 3, 2, 2, 'r']]);
  });
});

describe('engine reuse', () => {
  it('gives the same results as fresh engines across many wall sets', () => {
    const map = parseMapCode(rows.find((r) => r.features.includes('teleport'))!.code);
    const engine = createEngine(map);
    const open: Coord[] = [];
    map.tiles.forEach((row, r) =>
      row.forEach((t, c) => {
        if (t.type === 'o') open.push({ row: r, col: c });
      }),
    );
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    for (let i = 0; i < 50; i++) {
      const walls = open.filter(() => rnd() < 0.1);
      const fresh = computePaths(map, walls);
      expect(engine.compute(walls)).toEqual(fresh);
      expect(engine.score(walls)).toBe(fresh.blocked ? -1 : fresh.totalMoves);
    }
  });
});
