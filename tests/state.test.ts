import { describe, expect, it } from 'vitest';
import { parseMapCode, parseSolution } from '../src/engine/mapcode';
import { GameState } from '../src/game/state';

// 4x2, 2 walls: s1 r1 o o / o p o f1
//   row 0: s1 at (0,0), rock at (0,1), open (0,2), (0,3)
//   row 1: open (1,0), p at (1,1), open (1,2), f1 at (1,3)
const MAP = parseMapCode('4.2.2.Test...:,s1.,r1.3,p1.1,f1.');

function fresh() {
  return new GameState(MAP, 'test-1');
}

describe('GameState', () => {
  it('starts empty with the full budget', () => {
    const g = fresh();
    expect(g.walls).toEqual([]);
    expect(g.wallsLeft).toBe(2);
    expect(g.budget).toBe(2);
    expect(g.canUndo).toBe(false);
    expect(g.solutionString).toBe('..:');
  });

  it('only open tiles are buildable', () => {
    const g = fresh();
    expect(g.isBuildable({ row: 0, col: 2 })).toBe(true);
    expect(g.isBuildable({ row: 1, col: 0 })).toBe(true);
    for (const c of [
      { row: 0, col: 0 }, // start
      { row: 0, col: 1 }, // rock
      { row: 1, col: 1 }, // unbuildable
      { row: 1, col: 3 }, // finish
      { row: 2, col: 0 }, // off grid
      { row: 0, col: -1 },
    ]) {
      expect(g.isBuildable(c)).toBe(false);
      expect(g.toggle(c)).toBe('not-buildable');
      expect(g.beginStroke(c)).toBeNull();
    }
    expect(g.walls).toEqual([]);
    expect(g.canUndo).toBe(false);
  });

  it('toggles walls and keeps placement order', () => {
    const g = fresh();
    expect(g.toggle({ row: 1, col: 2 })).toBe('placed');
    expect(g.toggle({ row: 0, col: 2 })).toBe('placed');
    expect(g.walls).toEqual([
      { row: 1, col: 2 },
      { row: 0, col: 2 },
    ]);
    expect(g.solutionString).toBe('.1,2.0,2.:');
    expect(g.hasWall({ row: 1, col: 2 })).toBe(true);
    expect(g.wallsLeft).toBe(0);
    expect(g.toggle({ row: 1, col: 2 })).toBe('removed');
    expect(g.hasWall({ row: 1, col: 2 })).toBe(false);
    expect(g.walls).toEqual([{ row: 0, col: 2 }]);
  });

  it('refuses a new wall when the budget is used up, but still allows removing', () => {
    const g = fresh();
    g.toggle({ row: 0, col: 2 });
    g.toggle({ row: 0, col: 3 });
    expect(g.toggle({ row: 1, col: 0 })).toBe('no-walls-left');
    expect(g.walls).toHaveLength(2);
    expect(g.toggle({ row: 0, col: 3 })).toBe('removed');
    expect(g.toggle({ row: 1, col: 0 })).toBe('placed');
  });

  it('a failed toggle is not an undo step', () => {
    const g = fresh();
    g.toggle({ row: 0, col: 2 });
    g.toggle({ row: 0, col: 3 });
    g.toggle({ row: 1, col: 0 }); // no walls left
    g.undo();
    expect(g.walls).toEqual([{ row: 0, col: 2 }]);
  });

  it('undo restores each previous state in turn', () => {
    const g = fresh();
    g.toggle({ row: 0, col: 2 });
    g.toggle({ row: 0, col: 3 });
    g.toggle({ row: 0, col: 2 });
    expect(g.walls).toEqual([{ row: 0, col: 3 }]);
    expect(g.undo()).toBe(true);
    expect(g.walls).toEqual([
      { row: 0, col: 2 },
      { row: 0, col: 3 },
    ]);
    expect(g.undo()).toBe(true);
    expect(g.walls).toEqual([{ row: 0, col: 2 }]);
    expect(g.undo()).toBe(true);
    expect(g.walls).toEqual([]);
    expect(g.undo()).toBe(false);
    expect(g.canUndo).toBe(false);
  });

  it('a drag stroke paints in one mode and is a single undo step', () => {
    const g = fresh();
    expect(g.beginStroke({ row: 0, col: 2 })).toBe('add');
    expect(g.paint({ row: 0, col: 2 })).toBe('placed');
    expect(g.paint({ row: 0, col: 1 })).toBe('not-buildable');
    expect(g.paint({ row: 0, col: 3 })).toBe('placed');
    expect(g.paint({ row: 1, col: 0 })).toBe('no-walls-left');
    expect(g.endStroke()).toBe(true);
    expect(g.walls).toHaveLength(2);

    // An erase stroke only removes walls, even over empty cells.
    expect(g.beginStroke({ row: 0, col: 3 })).toBe('remove');
    expect(g.paint({ row: 0, col: 3 })).toBe('removed');
    expect(g.paint({ row: 1, col: 0 })).toBe('unchanged');
    expect(g.paint({ row: 0, col: 2 })).toBe('removed');
    g.endStroke();
    expect(g.walls).toEqual([]);

    g.undo();
    expect(g.walls).toHaveLength(2);
    g.undo();
    expect(g.walls).toEqual([]);
    expect(g.canUndo).toBe(false);
  });

  it('a stroke that changes nothing is not an undo step', () => {
    const g = fresh();
    g.toggle({ row: 0, col: 2 });
    g.toggle({ row: 0, col: 3 });
    g.beginStroke({ row: 1, col: 0 }); // add mode, but no walls left
    expect(g.paint({ row: 1, col: 0 })).toBe('no-walls-left');
    expect(g.endStroke()).toBe(false);
    g.undo();
    expect(g.walls).toEqual([{ row: 0, col: 2 }]);
  });

  it('reset clears all walls and can be undone', () => {
    const g = fresh();
    expect(g.reset()).toBe(false);
    g.toggle({ row: 0, col: 2 });
    g.toggle({ row: 1, col: 2 });
    expect(g.reset()).toBe(true);
    expect(g.walls).toEqual([]);
    expect(g.wallsLeft).toBe(2);
    g.undo();
    expect(g.walls).toEqual([
      { row: 0, col: 2 },
      { row: 1, col: 2 },
    ]);
  });

  it('loads a valid solution (undoable) and rejects invalid ones whole', () => {
    const g = fresh();
    g.toggle({ row: 1, col: 0 });
    expect(g.load(parseSolution('.0,2.1,2.:'))).toBe(true);
    expect(g.solutionString).toBe('.0,2.1,2.:');
    expect(g.hasWall({ row: 1, col: 0 })).toBe(false);

    expect(g.load(parseSolution('.0,1.:'))).toBe(false); // rock
    expect(g.load(parseSolution('.0,2.0,2.:'))).toBe(false); // duplicate
    expect(g.load(parseSolution('.0,2.0,3.1,0.:'))).toBe(false); // over budget
    expect(g.solutionString).toBe('.0,2.1,2.:');

    g.undo();
    expect(g.walls).toEqual([{ row: 1, col: 0 }]);
  });

  it('solution() returns a copy', () => {
    const g = fresh();
    g.toggle({ row: 0, col: 2 });
    const s = g.solution();
    s[0]!.col = 3;
    expect(g.hasWall({ row: 0, col: 2 })).toBe(true);
  });
});
