/**
 * App controller: wires the game state, engine, storage and UI together.
 * The actions object at the bottom is what keyboard shortcuts (Phase 6) should call too.
 */
import './ui/styles.css';
import { computePaths } from './engine/pathing';
import { parseSolution } from './engine/mapcode';
import type { Coord, PathsResult } from './engine/types';
import { generateMap, parseMapKey, randomSeed } from './generator/generate';
import type { GeneratedMap, MapType } from './generator/generate';
import { dailySeed, dateString, isDaily } from './game/daily';
import { GameState } from './game/state';
import { GameStorage } from './game/storage';
import type { RunVerdict } from './game/storage';
import { PathPlayer, targetName } from './ui/animate';
import type { Speed } from './ui/animate';
import { Board } from './ui/board';
import { Controls } from './ui/controls';
import { installShortcuts } from './ui/shortcuts';
import { Sound } from './ui/sound';

const DEFAULT_TYPE: MapType = 'normal';
const FLASH_MS = 2200;

const storage = new GameStorage();
let speed: Speed = storage.getPrefs().speed;
const sound = new Sound(storage.getPrefs().mute);
let current: GeneratedMap;
let game: GameState;
/** The last run's per-path moves, shown (dimmed) until the next run. */
let lastMoves: number[] | null = null;

const board = new Board({
  strokeStart(c) {
    if (game.beginStroke(c) === null) return false;
    stopRun();
    paint(c);
    return true;
  },
  strokeMove: (c) => paint(c),
  strokeEnd() {
    game.endStroke();
    refresh();
  },
});
const player = new PathPlayer(board, () => speed);

const controls = new Controls(
  document.querySelector<HTMLElement>('#app')!,
  {
    newMap: (type) => actions.newMap(type),
    loadKey: (text) => actions.loadKey(text),
    copyLink: () => void actions.copyLink(),
    go: () => actions.go(),
    undo: () => actions.undo(),
    reset: () => actions.reset(),
    setSpeed(s) {
      speed = s;
      storage.setPrefs({ speed: s });
    },
    loadBest: () => actions.loadBest(),
    daily: () => actions.daily(),
    setMute(mute) {
      sound.muted = mute;
      storage.setPrefs({ mute });
      sound.unlock();
      sound.play('tick');
    },
  },
  speed,
  sound.muted,
);
controls.boardSlot.append(board.el);

function paint(c: Coord): void {
  const r = game.paint(c);
  if (r === 'no-walls-left') {
    controls.flashWalls();
    board.nudge(c);
    controls.say('No walls left. Remove one to place it somewhere else.', 'warn', FLASH_MS);
    return;
  }
  if (r === 'placed' || r === 'removed') {
    board.syncWalls((x) => game.hasWall(x), r === 'placed' ? c : undefined);
    controls.setWalls(game.wallsLeft, game.budget);
  }
}

/** Cancels any running animation (walls changed or a new run starts). */
function stopRun(): void {
  if (player.isRunning) controls.say('');
  player.cancel();
  controls.setRunning(false);
  controls.setMoves(lastMoves, true);
}

/** Updates everything that depends on the walls. */
function refresh(): void {
  board.syncWalls((x) => game.hasWall(x));
  controls.setWalls(game.wallsLeft, game.budget);
  controls.setEditState(game.canUndo, game.walls.length > 0);
  const best = storage.getBest(game.key);
  controls.setBest(best?.moves ?? null, !!best && !sameWalls(best.solution));
}

function sameWalls(solution: string): boolean {
  try {
    const walls = parseSolution(solution);
    return walls.length === game.walls.length && walls.every((w) => game.hasWall(w));
  } catch {
    return false;
  }
}

function load(g: GeneratedMap): void {
  player.cancel();
  current = g;
  game = new GameState(g.map, g.key);
  lastMoves = null;
  board.render(g.map);
  controls.setMap(g.type, g.seed, isDaily(g.type, g.seed));
  controls.setRunning(false);
  controls.setMoves(null);
  controls.say('');
  refresh();
  storage.setPrefs({ lastMap: g.key });
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('map', g.key);
    window.history.replaceState(null, '', url);
  } catch {
    // Some embedded contexts refuse history changes; the link button still works.
  }
}

/** Generates and loads a map; returns false (with a message) if that fails. */
function loadByKey(type: MapType, seed: number): boolean {
  try {
    load(generateMap(type, seed));
    return true;
  } catch (e) {
    controls.say(`Couldn't make a ${type} map from seed ${seed}: ${String(e)}`, 'warn');
    return false;
  }
}

function blockedMessage(result: PathsResult): string {
  const i = result.paths.findIndex((p) => p.blocked);
  const p = result.paths[i];
  const label = typeof p?.tokens[0] === 'string' ? p.tokens[0] : 'f1';
  const which =
    result.paths.length > 1 ? (i === 1 ? 'the red path' : 'the green path') : 'the path';
  return `Blocked: ${which} can't reach ${targetName(label)}. Remove a wall to open a route.`;
}

function verdictMessage(v: RunVerdict): [string, 'good' | 'info'] {
  switch (v.kind) {
    case 'new':
      return [v.previous === null ? 'New best!' : `New best! Up from ${v.previous}.`, 'good'];
    case 'tied':
      return ['Tied best.', 'info'];
    case 'below':
      return [`Best is ${v.best}.`, 'info'];
  }
}

const actions = {
  newMap(type: MapType): void {
    loadByKey(type, randomSeed());
  },

  /** Today's map of the current type. */
  daily(): void {
    const seed = dailySeed(current.type, dateString());
    if (current.seed === seed) {
      controls.say("That's already today's map.", 'info', FLASH_MS);
      return;
    }
    loadByKey(current.type, seed);
  },

  loadKey(text: string): void {
    const t = text.trim();
    const key = /^\d+$/.test(t) ? `${current.type}-${t}` : t;
    const parsed = parseMapKey(key);
    if (!parsed) {
      controls.say('Enter a seed number, or a map key like complex-123456.', 'warn', FLASH_MS);
      controls.setMap(current.type, current.seed);
      return;
    }
    if (parsed.type === current.type && parsed.seed === current.seed) return;
    loadByKey(parsed.type, parsed.seed);
  },

  async copyLink(): Promise<void> {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('map', current.key);
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
      controls.say('Link copied.', 'info', FLASH_MS);
    } catch {
      controls.say(`Copy this link: ${link}`, 'info');
    }
  },

  go(): void {
    sound.unlock();
    stopRun();
    const result = computePaths(game.map, game.walls);
    if (result.blocked) {
      lastMoves = null;
      controls.setMoves(null);
      controls.say(blockedMessage(result), 'warn');
      return;
    }
    // The score counts once the run has played out (editing walls mid-run cancels it).
    const solution = game.solutionString;
    controls.say('');
    controls.setRunning(true);
    let lastHundred = 0;
    player.play(result.paths, {
      onProgress(moves) {
        controls.setMoves(moves);
        const total = moves.reduce((a, b) => a + b, 0);
        if (Math.floor(total / 100) > lastHundred) {
          lastHundred = Math.floor(total / 100);
          controls.pulseMoves();
          sound.play('tick');
        }
      },
      onEvent: (kind) => sound.play(kind === 'reach' ? 'checkpoint' : 'teleport'),
      onDone() {
        const verdict = storage.recordRun(game.key, result.totalMoves, solution);
        lastMoves = result.paths.map((p) => p.moves);
        controls.setMoves(lastMoves);
        controls.setRunning(false);
        controls.say(...verdictMessage(verdict));
        if (verdict.kind === 'new') sound.play('best');
        refresh();
      },
    });
  },

  undo(): void {
    stopRun();
    if (game.undo()) refresh();
  },

  reset(): void {
    stopRun();
    if (game.reset()) refresh();
  },

  loadBest(): void {
    const best = storage.getBest(game.key);
    if (!best) return;
    stopRun();
    let ok = false;
    try {
      ok = game.load(parseSolution(best.solution));
    } catch {
      ok = false;
    }
    if (!ok) {
      controls.say("The saved solution doesn't fit this map.", 'warn', FLASH_MS);
      return;
    }
    refresh();
    controls.say(`Loaded your best solution (${best.moves} moves). Press Go to watch it.`);
  },
};

// Shortcuts call the same actions as the buttons. (Any key press also unlocks audio.)
installShortcuts((a) => {
  sound.unlock();
  if (a === 'go') actions.go();
  else if (a === 'reset') actions.reset();
  else if (a === 'undo') actions.undo();
  else actions.newMap(current.type);
});

// Startup: ?map= first, then the last map played, then a new map.
function start(): void {
  const param = new URLSearchParams(window.location.search).get('map');
  const fromUrl = param ? parseMapKey(param) : null;
  if (fromUrl && loadByKey(fromUrl.type, fromUrl.seed)) return;
  const last = storage.getPrefs().lastMap;
  const fromPrefs = last ? parseMapKey(last) : null;
  if (!(fromPrefs && loadByKey(fromPrefs.type, fromPrefs.seed))) {
    loadByKey(DEFAULT_TYPE, randomSeed());
  }
  if (param && !fromUrl) controls.say(`"${param}" isn't a map key, so here's another map.`, 'warn');
}

start();
