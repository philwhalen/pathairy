/**
 * Game state for one map: the walls the player has placed, the wall budget and an undo stack.
 * Pure (no DOM), so the UI and tests drive it the same way.
 *
 * Walls are edited in strokes: `beginStroke` on the first cell decides whether the stroke adds or
 * removes walls, `paint` applies that to each cell the pointer crosses, and `endStroke` closes it.
 * A whole stroke is one undo step. `toggle` is a one-cell stroke (a plain click or tap).
 */
import type { Coord, MapData, Solution } from '../engine/types';
import { isWallable } from '../engine/rules';
import { serializeSolution } from '../engine/mapcode';

export type StrokeMode = 'add' | 'remove';

/** What happened to one cell during a stroke. */
export type PaintResult = 'placed' | 'removed' | 'unchanged' | 'not-buildable' | 'no-walls-left';

export class GameState {
  readonly map: MapData;
  /** Map key ("complex-123456"), used for storage and links. */
  readonly key: string;
  private wallList: Coord[] = [];
  private readonly wallCells = new Set<number>();
  private readonly undoStack: Coord[][] = [];
  private stroke: { mode: StrokeMode; before: Coord[]; changed: boolean } | null = null;

  constructor(map: MapData, key: string) {
    this.map = map;
    this.key = key;
  }

  /** Placed walls, in placement order. */
  get walls(): readonly Coord[] {
    return this.wallList;
  }

  get budget(): number {
    return this.map.walls;
  }

  get wallsLeft(): number {
    return this.map.walls - this.wallList.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Solution string for storage and sharing (`.r,c.r,c.:`). */
  get solutionString(): string {
    return serializeSolution(this.wallList);
  }

  /** A copy of the walls, safe to keep. */
  solution(): Solution {
    return this.wallList.map((c) => ({ ...c }));
  }

  isBuildable(c: Coord): boolean {
    const t = this.map.tiles[c.row]?.[c.col];
    return t !== undefined && isWallable(t);
  }

  hasWall(c: Coord): boolean {
    return this.wallCells.has(this.cellId(c));
  }

  /**
   * Starts a stroke on cell `c`. Returns the stroke mode (remove if `c` has a wall, else add), or
   * null if `c` can't hold a wall (then no stroke is started).
   */
  beginStroke(c: Coord): StrokeMode | null {
    if (!this.isBuildable(c)) return null;
    if (this.stroke) this.endStroke();
    const mode: StrokeMode = this.hasWall(c) ? 'remove' : 'add';
    this.stroke = { mode, before: this.wallList.slice(), changed: false };
    return mode;
  }

  /** Applies the current stroke's mode to cell `c`. Without a stroke, behaves like `toggle`. */
  paint(c: Coord): PaintResult {
    if (!this.stroke) return this.toggle(c);
    if (!this.isBuildable(c)) return 'not-buildable';
    const id = this.cellId(c);
    if (this.stroke.mode === 'add') {
      if (this.wallCells.has(id)) return 'unchanged';
      if (this.wallsLeft <= 0) return 'no-walls-left';
      this.wallCells.add(id);
      this.wallList.push({ row: c.row, col: c.col });
      this.stroke.changed = true;
      return 'placed';
    }
    if (!this.wallCells.has(id)) return 'unchanged';
    this.wallCells.delete(id);
    this.wallList = this.wallList.filter((w) => this.cellId(w) !== id);
    this.stroke.changed = true;
    return 'removed';
  }

  /** Ends the stroke. Returns whether it changed anything (only then is it an undo step). */
  endStroke(): boolean {
    const s = this.stroke;
    this.stroke = null;
    if (!s || !s.changed) return false;
    this.undoStack.push(s.before);
    return true;
  }

  /** Toggles a wall on one cell as its own undo step. */
  toggle(c: Coord): PaintResult {
    if (this.beginStroke(c) === null) return 'not-buildable';
    const r = this.paint(c);
    this.endStroke();
    return r;
  }

  /** Restores the walls before the last change. Returns false if there is nothing to undo. */
  undo(): boolean {
    if (this.stroke) this.endStroke();
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.setWalls(prev);
    return true;
  }

  /** Removes every wall (undoable). Returns false if there were none. */
  reset(): boolean {
    if (this.stroke) this.endStroke();
    if (this.wallList.length === 0) return false;
    this.undoStack.push(this.wallList.slice());
    this.setWalls([]);
    return true;
  }

  /**
   * Replaces the walls with `walls` (undoable), e.g. to load a stored best solution. Rejects the
   * whole list if any wall is not buildable, is a duplicate, or the list is over budget.
   */
  load(walls: readonly Coord[]): boolean {
    if (walls.length > this.budget) return false;
    const seen = new Set<number>();
    for (const w of walls) {
      if (!this.isBuildable(w) || seen.has(this.cellId(w))) return false;
      seen.add(this.cellId(w));
    }
    if (this.stroke) this.endStroke();
    this.undoStack.push(this.wallList.slice());
    this.setWalls(walls);
    return true;
  }

  private setWalls(walls: readonly Coord[]): void {
    this.wallList = walls.map((w) => ({ row: w.row, col: w.col }));
    this.wallCells.clear();
    for (const w of this.wallList) this.wallCells.add(this.cellId(w));
  }

  private cellId(c: Coord): number {
    return c.row * this.map.width + c.col;
  }
}
