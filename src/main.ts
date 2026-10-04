/**
 * App controller: wires the game state, engine, storage and UI together.
 * The actions object at the bottom is what keyboard shortcuts (Phase 6) should call too.
 */
import './ui/styles.css';
import { computePaths } from './engine/pathing';
import { parseMapCode, parseSolution, serializeSolution } from './engine/mapcode';
import type { Coord, MapData, PathsResult } from './engine/types';
import { generateMap, mapKey, parseMapKey, randomSeed } from './generator/generate';
import type { GeneratedMap, MapType } from './generator/generate';
import { dailySeed, dateString, isDaily } from './game/daily';
import {
  fetchSiteDay,
  fetchSiteMap,
  parseSiteMapKey,
  patheryDate,
  SiteError,
  siteMapKey,
} from './game/pathery';
import type { SiteMapInfo } from './game/pathery';
import { GameState } from './game/state';
import { GameStorage } from './game/storage';
import type { BestRecord, RunVerdict } from './game/storage';
import { SOLVER_VERSION } from './solver/solve';
import { AiRunner } from './ui/ai';
import { PathPlayer, targetName } from './ui/animate';
import type { Speed } from './ui/animate';
import { Board } from './ui/board';
import { Controls } from './ui/controls';
import { installShortcuts } from './ui/shortcuts';
import { Sound } from './ui/sound';

const DEFAULT_TYPE: MapType = 'normal';
const FLASH_MS = 2200;
/** How long the solver works on each new map for the "AI best" target. */
const AI_TIME_MS = 5000;

const storage = new GameStorage();
let speed: Speed = storage.getPrefs().speed;
const sound = new Sound(storage.getPrefs().mute);
/** The map on the board: generated (`site` null) or downloaded from pathery.com. */
let current: { key: string; site: SiteMapInfo | null };
/** The generator type that Daily, N and bare seed numbers use (kept while a site map is shown). */
let mapType: MapType = DEFAULT_TYPE;
let game: GameState;
/** The last run's per-path moves, shown (dimmed) until the next run. */
let lastMoves: number[] | null = null;
const ai = new AiRunner();
/** The AI's result for the current map once it has finished (null while thinking or unavailable). */
let aiBest: BestRecord | null = null;
/** The solver's best so far while it is still thinking. */
let aiThinking: number | null = null;

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
    loadAi: () => actions.loadAi(),
    daily: () => actions.daily(),
    setMute(mute) {
      sound.muted = mute;
      storage.setPrefs({ mute });
      sound.unlock();
      sound.play('tick');
    },
    siteToday: () => void actions.siteToday(),
    openSiteMap: (id) => void actions.openSiteMap(id),
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
  if (aiBest) controls.setAi(aiBest.moves, false, !sameWalls(aiBest.solution));
  else controls.setAi(aiThinking, aiThinking !== null, false);
}

/** Shows the stored AI target for the map on the board, or starts the solver on it. */
function startAi(): void {
  const key = game.key;
  aiBest = storage.getAi(key, SOLVER_VERSION);
  aiThinking = null;
  if (aiBest) {
    ai.cancel();
    return;
  }
  ai.start(game.map, AI_TIME_MS, (u) => {
    if (game.key !== key) return;
    if (u.done) {
      aiBest = { moves: u.moves, solution: serializeSolution(u.walls) };
      aiThinking = null;
      storage.putAi(key, { ...aiBest, version: SOLVER_VERSION });
    } else {
      aiThinking = u.moves;
    }
    refresh();
  });
}

/** How a finished run compares with the AI target (empty if there is none yet). */
function aiComparison(moves: number): string {
  if (!aiBest) return '';
  if (moves > aiBest.moves) return ` You beat the AI's ${aiBest.moves}!`;
  if (moves === aiBest.moves) return ' You matched the AI.';
  return ` AI best: ${aiBest.moves}.`;
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
  mapType = g.type;
  show(g.key, g.map, null);
  controls.setMap(g.type, g.seed, isDaily(g.type, g.seed));
}

/** Loads a pathery.com map; returns false (with a message) if its code doesn't parse. */
function loadSite(info: SiteMapInfo): boolean {
  let map: MapData;
  try {
    map = parseMapCode(info.code);
  } catch (e) {
    controls.say(`Couldn't read pathery.com map ${info.id}: ${String(e)}`, 'warn');
    return false;
  }
  show(siteMapKey(info.id), map, info);
  controls.setSiteMap(info.id, info.name);
  return true;
}

function show(key: string, map: MapData, site: SiteMapInfo | null): void {
  player.cancel();
  current = { key, site };
  game = new GameState(map, key);
  lastMoves = null;
  board.render(map);
  controls.setRunning(false);
  controls.setMoves(null);
  controls.say('');
  startAi();
  refresh();
  storage.setPrefs({ lastMap: key });
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('map', key);
    window.history.replaceState(null, '', url);
  } catch {
    // Some embedded contexts refuse history changes; the link button still works.
  }
}

function siteErrorText(e: unknown): string {
  return e instanceof SiteError ? e.message : `Download failed: ${String(e)}`;
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
    const seed = dailySeed(mapType, dateString());
    if (current.key === mapKey(mapType, seed)) {
      controls.say("That's already today's map.", 'info', FLASH_MS);
      return;
    }
    loadByKey(mapType, seed);
  },

  loadKey(text: string): void {
    const t = text.trim();
    // A bare number is a seed of the current type, or a pathery.com ID while one of those is shown.
    const key = /^\d+$/.test(t) ? `${current.site ? 'pathery' : mapType}-${t}` : t;
    const siteId = parseSiteMapKey(key);
    if (siteId !== null) {
      if (current.site?.id !== siteId) void actions.openSiteMap(siteId);
      return;
    }
    const parsed = parseMapKey(key);
    if (!parsed) {
      controls.say(
        'Enter a seed number, or a map key like complex-123456 or pathery-23445.',
        'warn',
        FLASH_MS,
      );
      controls.resetSeed();
      return;
    }
    if (current.key === mapKey(parsed.type, parsed.seed)) return;
    loadByKey(parsed.type, parsed.seed);
  },

  /**
   * Lists pathery.com's maps for today (downloading them the first time) and, unless one of them
   * is already on the board, loads the one named like the current type (else the first).
   */
  async siteToday(): Promise<void> {
    let day = storage.getSiteDay(patheryDate());
    if (!day) {
      controls.setSiteBusy(true);
      controls.say("Checking pathery.com for today's maps…");
      try {
        day = await fetchSiteDay();
      } catch (e) {
        controls.say(siteErrorText(e), 'warn');
        return;
      } finally {
        controls.setSiteBusy(false);
      }
      if (day.maps.length === 0) {
        controls.say(`pathery.com hasn't posted maps for ${day.date} yet.`, 'info');
        return;
      }
      storage.putSiteDay(day);
    }
    controls.setSiteMaps(day.date, day.maps, current.site?.id ?? null);
    if (day.maps.some((m) => m.id === current.site?.id)) {
      controls.say(`pathery.com maps for ${day.date}.`, 'info', FLASH_MS);
      return;
    }
    const pick = day.maps.find((m) => m.name.toLowerCase() === mapType) ?? day.maps[0]!;
    loadSite(pick);
  },

  /** Loads pathery.com map `id`, from local storage or downloaded. */
  async openSiteMap(id: number): Promise<boolean> {
    let info = storage.getSiteMap(id);
    if (!info) {
      controls.say(`Downloading pathery-${id}…`);
      try {
        info = await fetchSiteMap(id);
      } catch (e) {
        controls.say(siteErrorText(e), 'warn');
        controls.resetSeed();
        return false;
      }
      storage.putSiteMap(info);
    }
    return loadSite(info);
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
        lastMoves = result.paths.map((p) => p.moves);
        controls.setMoves(lastMoves);
        controls.setRunning(false);
        if (aiBest && sameWalls(aiBest.solution)) {
          // The AI's own walls don't count as the player's best.
          controls.say(`The AI's solution: ${result.totalMoves} moves.`, 'info');
          refresh();
          return;
        }
        const verdict = storage.recordRun(game.key, result.totalMoves, solution);
        const [text, tone] = verdictMessage(verdict);
        controls.say(text + aiComparison(result.totalMoves), tone);
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

  loadAi(): void {
    if (!aiBest) return;
    stopRun();
    let ok = false;
    try {
      ok = game.load(parseSolution(aiBest.solution));
    } catch {
      ok = false;
    }
    if (!ok) return;
    refresh();
    controls.say(
      `The AI's walls (${aiBest.moves} moves). Press Go to watch, or Undo to get yours back.`,
    );
  },
};

// Shortcuts call the same actions as the buttons. (Any key press also unlocks audio.)
installShortcuts((a) => {
  sound.unlock();
  if (a === 'go') actions.go();
  else if (a === 'reset') actions.reset();
  else if (a === 'undo') actions.undo();
  else actions.newMap(mapType);
});

/** Loads a generated map, or a pathery.com map saved locally, by key (no downloads). */
function loadSaved(key: string): boolean {
  const siteId = parseSiteMapKey(key);
  const info = siteId === null ? null : storage.getSiteMap(siteId);
  if (info) return loadSite(info);
  const parsed = parseMapKey(key);
  return !!parsed && loadByKey(parsed.type, parsed.seed);
}

// Startup: ?map= first, then the last map played, then a new map. A pathery.com map that isn't
// saved yet is downloaded once something else is on the board. Today's pathery.com maps are
// listed if they were downloaded earlier.
function start(): void {
  const param = new URLSearchParams(window.location.search).get('map');
  const today = storage.getSiteDay(patheryDate());
  if (today) controls.setSiteMaps(today.date, today.maps, null);
  if (param && loadSaved(param)) return;
  const last = storage.getPrefs().lastMap;
  if (!(last && loadSaved(last))) loadByKey(DEFAULT_TYPE, randomSeed());
  const siteId = param ? parseSiteMapKey(param) : null;
  if (siteId !== null) void actions.openSiteMap(siteId);
  else if (param && !parseMapKey(param)) {
    controls.say(`"${param}" isn't a map key, so here's another map.`, 'warn');
  }
}

start();
