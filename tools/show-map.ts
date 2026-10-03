/** Prints an ASCII render of a generated map: npx tsx tools/show-map.ts complex 12345 */
import { generateMap, randomSeed } from '../src/generator/generate';
import type { MapType } from '../src/generator/generate';
import { MAP_TYPES } from '../src/generator/presets';
import { serializeMapCode } from '../src/engine/mapcode';
import type { MapData } from '../src/engine/types';

export function renderMap(map: MapData): string {
  const sym: Record<string, string> = { o: '.', r: '#', s: 'S', f: 'F', p: '_', z: '~', x: 'x' };
  return map.tiles
    .map((row) =>
      row
        .map(({ type, value }) =>
          type === 'c'
            ? String.fromCharCode(64 + value)
            : type === 't'
              ? String(value)
              : type === 'u'
                ? String.fromCharCode(96 + value)
                : type === 'r' && value === 3
                  ? '%'
                  : (sym[type] ?? '?'),
        )
        .join(''),
    )
    .join('\n');
}

const isMain = process.argv[1]?.replaceAll('\\', '/').endsWith('tools/show-map.ts');
if (isMain) {
  const type = (process.argv[2] ?? 'simple') as MapType;
  if (!MAP_TYPES.includes(type)) {
    console.error(`usage: show-map.ts <${MAP_TYPES.join('|')}> [seed]`);
    process.exit(1);
  }
  const seed = process.argv[3] !== undefined ? Number(process.argv[3]) : randomSeed();
  const g = generateMap(type, seed);
  console.log(
    `${g.key}  ${g.map.width}x${g.map.height}  walls ${g.map.walls}  attempts ${g.attempts}`,
  );
  console.log(renderMap(g.map));
  console.log(
    'legend: S start, F finish, A.. checkpoints, 1/2 teleport in, a/b exit, ~ ice, # rock, % border rock',
  );
  console.log(serializeMapCode(g.map));
}
