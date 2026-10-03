import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PathResult } from '../src/engine/types';
import type { AnimationSurface, Frame } from '../src/ui/animate';
import {
  PathPlayer,
  RESTORE_MS,
  buildFrames,
  frameDelay,
  targetColor,
  targetName,
} from '../src/ui/animate';

const path = (tokens: PathResult['tokens'], start: string, moves: number): PathResult => ({
  tokens,
  moves,
  blocked: false,
  start,
  end: '',
});

const summary = (frames: Frame[]) =>
  frames.map((f) => `${f.kind}@${f.cell.row},${f.cell.col}${f.dir ? `>${f.dir}` : ''}#${f.moves}`);

describe('targetColor / targetName', () => {
  it('uses the original colors', () => {
    expect(targetColor('c1')).toBe('#F777FF');
    expect(targetColor('c5')).toBe('#00FFFF');
    expect(targetColor('c15')).toBe('#fffac8');
    expect(targetColor('f1')).toBe('#cccccc');
    expect(targetColor('c99')).toBe('#cccccc');
  });
  it('names targets', () => {
    expect(targetName('c2')).toBe('checkpoint B');
    expect(targetName('f1')).toBe('the finish');
  });
});

describe('buildFrames', () => {
  it('walks directions from the start ("x,y" = col,row) with colors per target', () => {
    // Real server response shape (Simple 23462): start "0,0".
    const f = buildFrames(path(['c1', 2, 3, 'r', 'f1', 2, 1, 4, 'r'], '0,0', 5));
    expect(summary(f)).toEqual([
      'start@0,0#0',
      'move@0,1>2#1',
      'move@1,1>3#2',
      'reach@1,1#2',
      'move@1,2>2#3',
      'move@0,2>1#4',
      'move@0,1>4#5',
      'reach@0,1#5',
    ]);
    expect(f[0]!.color).toBe(targetColor('c1'));
    expect(f[2]!.color).toBe(targetColor('c1'));
    expect(f[4]!.color).toBe(targetColor('f1'));
    expect(f[3]!.pause).toBe(true); // a new target follows
    expect(f[7]!.pause).toBe(false); // end of the path
  });

  it('turns "u","x,y","u" into a teleport pause and a zero-move warp', () => {
    const f = buildFrames(path(['f1', 2, 'u', '5,2', 'u', 3, 't1', 2, 'r'], '0,1', 3));
    expect(summary(f)).toEqual([
      'start@1,0#0',
      'move@1,1>2#1',
      'teleport@1,1#1',
      'arrive@2,5#1',
      'move@3,5>3#2',
      'move@3,6>2#3',
      'reach@3,6#3',
    ]);
  });

  it('ignores spent teleport tokens and returns nothing for blocked paths', () => {
    expect(buildFrames(path(['f1', 2, 't2', 2, 'r'], '0,0', 2)).map((x) => x.kind)).toEqual([
      'start',
      'move',
      'move',
      'reach',
    ]);
    expect(buildFrames({ ...path(['c2'], '0,0', 0), blocked: true })).toEqual([]);
  });

  it('final moves equal the path moves', () => {
    const p = path(['c1', 2, 2, 3, 'r', 'c2', 4, 'u', '0,0', 'u', 3, 'r', 'f1', 2, 'r'], '0,0', 6);
    const f = buildFrames(p);
    expect(f.at(-1)!.moves).toBe(p.moves);
  });
});

describe('frameDelay', () => {
  const frame = (kind: Frame['kind'], pause?: boolean): Frame => ({
    kind,
    cell: { row: 0, col: 0 },
    color: '#000',
    moves: 0,
    pause,
  });
  it('uses the per-speed step', () => {
    expect(frameDelay(frame('move'), 'slow')).toBe(180);
    expect(frameDelay(frame('move'), 'med')).toBe(94);
    expect(frameDelay(frame('move'), 'fast')).toBe(44);
    expect(frameDelay(frame('move'), 'ultra')).toBe(22);
  });
  it('pauses at targets (+200 more at Slow/Med) and teleports', () => {
    expect(frameDelay(frame('reach', true), 'slow')).toBe(2 * 180 + 450);
    expect(frameDelay(frame('reach', true), 'fast')).toBe(2 * 44 + 250);
    expect(frameDelay(frame('reach', false), 'fast')).toBe(44);
    expect(frameDelay(frame('teleport'), 'slow')).toBe(180 + 1250);
    expect(frameDelay(frame('teleport'), 'ultra')).toBe(22 + 950);
    expect(frameDelay(frame('arrive'), 'med')).toBe(188);
  });
});

describe('PathPlayer', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers();
    const log: string[] = [];
    const surface: AnimationSurface = {
      trail: (c, _color, p, dir) => log.push(`trail${p} ${c.row},${c.col} ${dir ?? '-'}`),
      markUsed: (c) => log.push(`used ${c.row},${c.col}`),
      flash: (c) => log.push(`flash ${c.row},${c.col}`),
      restore: () => log.push('restore'),
      clearEffects: () => log.push('clear'),
    };
    const player = new PathPlayer(surface, () => 'fast');
    return { log, player };
  }

  it('plays all paths at the same time and reports moves per path', () => {
    const { log, player } = setup();
    const progress: number[][] = [];
    let done = 0;
    player.play([path(['f1', 2, 2, 'r'], '0,0', 2), path(['f1', 3, 'r'], '0,0', 1)], {
      onProgress: (m) => progress.push(m),
      onDone: () => done++,
    });
    expect(player.isRunning).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(done).toBe(1);
    expect(player.isRunning).toBe(false);
    expect(progress.at(-1)).toEqual([2, 1]);
    expect(log).toContain('trail0 0,2 2');
    expect(log).toContain('trail1 1,0 3');
    expect(log.at(-1)).toBe('restore'); // used targets come back after RESTORE_MS
  });

  it('cancel stops the run cleanly', () => {
    const { log, player } = setup();
    let done = 0;
    player.play([path(['f1', 2, 2, 2, 2, 'r'], '0,0', 4)], {
      onProgress: () => {},
      onDone: () => done++,
    });
    vi.advanceTimersByTime(50);
    player.cancel();
    const n = log.length;
    vi.advanceTimersByTime(RESTORE_MS * 2);
    expect(log.length).toBe(n);
    expect(log.at(-1)).toBe('clear');
    expect(done).toBe(0);
    expect(player.isRunning).toBe(false);
  });

  it('a new play cancels the previous one', () => {
    const { player } = setup();
    let first = 0;
    let second = 0;
    player.play([path(['f1', 2, 2, 2, 'r'], '0,0', 3)], {
      onProgress: () => {},
      onDone: () => first++,
    });
    player.play([path(['f1', 2, 'r'], '0,0', 1)], { onProgress: () => {}, onDone: () => second++ });
    vi.advanceTimersByTime(10_000);
    expect(first).toBe(0);
    expect(second).toBe(1);
  });
});
