/**
 * The board: a CSS grid of cells, one per tile. Draws tiles and walls, turns pointer and keyboard
 * input into wall strokes (click, tap, or drag to paint), and implements the animation surface
 * (trail, used targets, teleport flash).
 */
import type { Coord, MapData, Tile } from '../engine/types';
import type { AnimationSurface } from './animate';
import { checkpointLetter, targetColor } from './animate';

export interface BoardHandlers {
  /** Pointer went down on a cell. Return false if no stroke starts there. */
  strokeStart(c: Coord): boolean;
  /** The pointer moved onto another cell during a stroke. */
  strokeMove(c: Coord): void;
  strokeEnd(): void;
}

/** Trail stays fully visible this long, then fades (original: ~860 ms). */
const TRAIL_MS = 860;
const FLASH_MS = 900;

/** Colors of teleport pairs 1-7 (ring around the number). */
const TELEPORT_COLORS = [
  '#4263eb',
  '#0ca678',
  '#e8590c',
  '#ae3ec9',
  '#1098ad',
  '#f08c00',
  '#c2255c',
];

const SVG_NS = 'http://www.w3.org/2000/svg';

function startIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M6 4 L14 10 L6 16');
  svg.append(p);
  return svg;
}

function tileLabel(t: Tile): string {
  switch (t.type) {
    case 'o':
      return 'open';
    case 'r':
      return 'rock';
    case 's':
      return t.value === 2 ? 'red start' : 'start';
    case 'f':
      return 'finish';
    case 'c':
      return `checkpoint ${checkpointLetter(t.value)}`;
    case 't':
      return `teleport ${t.value} entrance`;
    case 'u':
      return `teleport ${t.value} exit`;
    case 'p':
      return 'unbuildable';
    case 'x':
      return t.value === 1 ? 'blocks green path' : 'blocks red path';
    case 'z':
      return t.value === 5 ? 'ice' : t.value === 1 ? 'rock' : 'open';
  }
}

export class Board implements AnimationSurface {
  readonly el: HTMLElement;
  private map: MapData | null = null;
  private cells: HTMLElement[] = [];
  /** Trail layers: fx[pathIndex][cellIndex]. */
  private fx: HTMLElement[][] = [];
  private readonly timers = new Map<HTMLElement, number>();
  private readonly used = new Set<HTMLElement>();
  private focusIndex = 0;
  private dragging: { pointerId: number; last: number } | null = null;

  constructor(private readonly handlers: BoardHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'board';
    this.el.setAttribute('role', 'grid');
    this.el.setAttribute('aria-label', 'Map. Choose an open cell to place or remove a wall.');
    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.el.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.el.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  render(map: MapData): void {
    this.clearEffects();
    this.map = map;
    this.el.replaceChildren();
    this.el.style.setProperty('--cols', String(map.width));
    this.el.style.setProperty('--rows', String(map.height));
    this.cells = [];
    this.fx = [[], []];
    this.focusIndex = 0;
    let firstOpen = -1;
    for (let row = 0; row < map.height; row++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'board-row';
      rowEl.setAttribute('role', 'row');
      for (let col = 0; col < map.width; col++) {
        const t = map.tiles[row]![col]!;
        const cell = this.makeCell(t, row, col);
        if (firstOpen < 0 && t.type === 'o') firstOpen = this.cells.length;
        this.cells.push(cell);
        rowEl.append(cell);
      }
      this.el.append(rowEl);
    }
    this.focusIndex = Math.max(0, firstOpen);
    this.cells[this.focusIndex]?.setAttribute('tabindex', '0');
  }

  /** Redraws walls. `placed` (optional) gets the placement pop animation. */
  syncWalls(hasWall: (c: Coord) => boolean, placed?: Coord): void {
    const map = this.map;
    if (!map) return;
    this.cells.forEach((cell, i) => {
      if (!cell.classList.contains('buildable')) return;
      const c = { row: Math.floor(i / map.width), col: i % map.width };
      const on = hasWall(c);
      cell.classList.toggle('wall', on);
      cell.setAttribute('aria-label', on ? 'wall' : 'open');
    });
    if (placed) {
      const cell = this.cellAt(placed);
      if (cell) {
        cell.classList.remove('pop');
        void cell.offsetWidth; // restart the CSS animation
        cell.classList.add('pop');
      }
    }
  }

  /** Short shake on a cell (e.g. no walls left). */
  nudge(c: Coord): void {
    const cell = this.cellAt(c);
    if (!cell) return;
    cell.classList.remove('nope');
    void cell.offsetWidth;
    cell.classList.add('nope');
  }

  // AnimationSurface

  trail(c: Coord, color: string, pathIndex: number, dir: number | undefined): void {
    const i = this.index(c);
    const fx = this.fx[pathIndex === 1 ? 1 : 0]![i];
    if (!fx) return;
    fx.style.setProperty('--trail', color);
    fx.dataset.dir = dir === undefined ? '0' : String(dir);
    fx.classList.add('on');
    this.later(fx, () => fx.classList.remove('on'), TRAIL_MS);
  }

  markUsed(c: Coord): void {
    const cell = this.cellAt(c);
    if (!cell) return;
    cell.classList.add('used');
    this.used.add(cell);
  }

  flash(c: Coord, color: string): void {
    const cell = this.cellAt(c);
    if (!cell) return;
    cell.style.setProperty('--flash', color);
    cell.classList.remove('flash');
    void cell.offsetWidth;
    cell.classList.add('flash');
    this.later(cell, () => cell.classList.remove('flash'), FLASH_MS);
  }

  restore(): void {
    for (const cell of this.used) cell.classList.remove('used');
    this.used.clear();
  }

  clearEffects(): void {
    for (const id of this.timers.values()) clearTimeout(id);
    this.timers.clear();
    this.restore();
    for (const layer of this.fx) for (const fx of layer) fx.classList.remove('on');
    for (const cell of this.cells) cell.classList.remove('flash');
  }

  // Internals

  private makeCell(t: Tile, row: number, col: number): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('tabindex', '-1');
    cell.setAttribute('aria-label', tileLabel(t));
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    const kind = t.type === 'z' && t.value === 1 ? 'r' : t.type;
    cell.classList.add(`t-${kind}`);
    switch (t.type) {
      case 'o':
        cell.classList.add('buildable');
        break;
      case 'r':
        cell.classList.add(t.value === 3 ? 't-r3' : 't-r1');
        break;
      case 's':
        cell.classList.add(t.value === 2 ? 't-s2' : 't-s1');
        cell.append(startIcon());
        break;
      case 'c':
        cell.style.setProperty('--tile', targetColor(`c${t.value}`));
        cell.append(this.glyph(checkpointLetter(t.value)));
        break;
      case 't':
      case 'u':
        cell.style.setProperty('--tile', TELEPORT_COLORS[(t.value - 1) % 7] ?? '#4263eb');
        cell.append(this.glyph(String(t.value)));
        break;
      case 'x':
        cell.classList.add(t.value === 2 ? 't-x2' : 't-x1');
        break;
      case 'z':
        if (t.value === 5) cell.classList.add('t-ice');
        else if (t.value === 1) cell.classList.add('t-r1');
        break;
    }
    for (const layer of this.fx) {
      const fx = document.createElement('span');
      fx.className = `fx fx${layer === this.fx[0] ? 1 : 2}`;
      cell.append(fx);
      layer.push(fx);
    }
    return cell;
  }

  private glyph(text: string): HTMLElement {
    const g = document.createElement('span');
    g.className = 'glyph';
    g.textContent = text;
    return g;
  }

  private later(el: HTMLElement, fn: () => void, ms: number): void {
    const prev = this.timers.get(el);
    if (prev !== undefined) clearTimeout(prev);
    this.timers.set(
      el,
      window.setTimeout(() => {
        this.timers.delete(el);
        fn();
      }, ms),
    );
  }

  private index(c: Coord): number {
    const w = this.map?.width ?? 0;
    if (c.col < 0 || c.col >= w || c.row < 0) return -1;
    return c.row * w + c.col;
  }

  private cellAt(c: Coord): HTMLElement | undefined {
    return this.cells[this.index(c)];
  }

  private coordOf(el: Element | null): { c: Coord; i: number } | null {
    const cell = el?.closest<HTMLElement>('.cell');
    if (!cell || !this.el.contains(cell)) return null;
    const c = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
    return { c, i: this.index(c) };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.dragging) return;
    const hit = this.coordOf(e.target as Element);
    if (!hit) return;
    this.setFocus(hit.i, false);
    if (!this.handlers.strokeStart(hit.c)) return;
    e.preventDefault();
    this.dragging = { pointerId: e.pointerId, last: hit.i };
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety; dragging still works inside the board without it.
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.dragging;
    if (!d || e.pointerId !== d.pointerId) return;
    // With pointer capture (and always for touch) the event target is not the cell under the pointer.
    const hit = this.coordOf(document.elementFromPoint(e.clientX, e.clientY));
    if (!hit || hit.i === d.last) return;
    d.last = hit.i;
    this.handlers.strokeMove(hit.c);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragging || e.pointerId !== this.dragging.pointerId) return;
    this.dragging = null;
    this.handlers.strokeEnd();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const map = this.map;
    if (!map) return;
    const w = map.width;
    const i = this.focusIndex;
    let next = -1;
    switch (e.key) {
      case 'ArrowUp':
        next = i - w;
        break;
      case 'ArrowDown':
        next = i + w;
        break;
      case 'ArrowLeft':
        next = i % w > 0 ? i - 1 : -1;
        break;
      case 'ArrowRight':
        next = i % w < w - 1 ? i + 1 : -1;
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const c = { row: Math.floor(i / w), col: i % w };
        if (this.handlers.strokeStart(c)) this.handlers.strokeEnd();
        return;
      }
      default:
        return;
    }
    e.preventDefault();
    if (next >= 0 && next < this.cells.length) this.setFocus(next, true);
  }

  private setFocus(i: number, focus: boolean): void {
    this.cells[this.focusIndex]?.setAttribute('tabindex', '-1');
    this.focusIndex = i;
    const cell = this.cells[i];
    cell?.setAttribute('tabindex', '0');
    if (focus) cell?.focus();
  }
}
