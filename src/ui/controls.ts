/**
 * Page chrome around the board: header (new map buttons, map key / seed field, copy link), the
 * status strip (walls left, move counter, best) and the action bar (Go, Undo, Reset, speed).
 * Holds no game logic; it reports user intent through `ControlHandlers`.
 */
import type { MapType } from '../generator/generate';
import { MAP_TYPES } from '../generator/generate';
import type { Speed } from './animate';
import { SPEEDS, SPEED_LABELS } from './animate';

export interface ControlHandlers {
  newMap(type: MapType): void;
  /** Text typed in the seed field: a seed number or a whole key ("complex-123456"). */
  loadKey(text: string): void;
  copyLink(): void;
  go(): void;
  undo(): void;
  reset(): void;
  setSpeed(speed: Speed): void;
  loadBest(): void;
  daily(): void;
  setMute(mute: boolean): void;
}

export type Tone = 'info' | 'good' | 'warn';

const TYPE_LABELS: Record<MapType, string> = {
  simple: 'Simple',
  normal: 'Normal',
  complex: 'Complex',
  centralized: 'Centralized',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<'className' | 'textContent' | 'type' | 'id', string>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

export class Controls {
  /** Where the board goes. */
  readonly boardSlot: HTMLElement;
  private readonly typeButtons = new Map<MapType, HTMLButtonElement>();
  private readonly typePrefix: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly dailyTag: HTMLElement;
  private readonly wallsCount: HTMLElement;
  private readonly wallsBudget: HTMLElement;
  private readonly wallsBox: HTMLElement;
  private readonly moves: HTMLElement;
  private readonly bestBox: HTMLElement;
  private readonly bestValue: HTMLElement;
  private readonly loadBestBtn: HTMLButtonElement;
  private readonly goBtn: HTMLButtonElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly speedInputs = new Map<Speed, HTMLInputElement>();
  private readonly message: HTMLElement;
  private messageTimer = 0;

  constructor(root: HTMLElement, h: ControlHandlers, speed: Speed, muted: boolean) {
    // Header
    const brand = el('h1', { className: 'brand' }, 'Pathery');
    const typeNav = el('div', { className: 'new-map' });
    typeNav.setAttribute('role', 'group');
    typeNav.setAttribute('aria-label', 'New map');
    typeNav.append(el('span', { className: 'new-map-label', textContent: 'New map' }));
    for (const t of MAP_TYPES) {
      const b = el('button', { type: 'button', className: 'chip', textContent: TYPE_LABELS[t] });
      b.addEventListener('click', () => h.newMap(t));
      this.typeButtons.set(t, b);
      typeNav.append(b);
    }

    const dailyBtn = el('button', {
      type: 'button',
      className: 'chip daily',
      textContent: 'Daily',
    });
    dailyBtn.title = "Today's map for this type (same for everyone, one per day)";
    dailyBtn.addEventListener('click', () => h.daily());
    typeNav.append(dailyBtn);

    this.typePrefix = el('span', { className: 'seed-type' });
    this.dailyTag = el('span', { className: 'daily-tag', textContent: 'Daily' });
    this.dailyTag.hidden = true;
    this.seedInput = el('input', { className: 'seed-input', id: 'seed' });
    this.seedInput.inputMode = 'numeric';
    this.seedInput.autocomplete = 'off';
    this.seedInput.spellcheck = false;
    this.seedInput.setAttribute('aria-label', 'Seed (or a map key like complex-123456)');
    const seedForm = el(
      'form',
      { className: 'seed' },
      el('label', { className: 'seed-label', textContent: 'Seed' }),
      this.typePrefix,
      this.seedInput,
      this.dailyTag,
      el('button', { type: 'submit', className: 'chip', textContent: 'Load' }),
    );
    (seedForm.querySelector('label') as HTMLLabelElement).htmlFor = 'seed';
    seedForm.addEventListener('submit', (e) => {
      e.preventDefault();
      h.loadKey(this.seedInput.value);
      this.seedInput.blur();
    });
    const copyBtn = el('button', { type: 'button', className: 'chip', textContent: 'Copy link' });
    copyBtn.addEventListener('click', () => h.copyLink());

    const header = el(
      'header',
      { className: 'top' },
      brand,
      typeNav,
      el('div', { className: 'map-id' }, seedForm, copyBtn),
    );

    // Status strip
    this.wallsCount = el('strong', { className: 'num' });
    this.wallsBudget = el('span');
    this.wallsBox = el(
      'div',
      { className: 'stat walls' },
      this.wallsCount,
      el('span', { className: 'stat-label' }, this.wallsBudget),
    );
    this.moves = el('div', { className: 'moves num' });
    this.moves.setAttribute('aria-label', 'Moves');
    this.bestValue = el('strong', { className: 'num' });
    this.loadBestBtn = el('button', {
      type: 'button',
      className: 'link',
      textContent: 'Load best solution',
    });
    this.loadBestBtn.addEventListener('click', () => h.loadBest());
    this.bestBox = el(
      'div',
      { className: 'stat best' },
      this.bestValue,
      el('span', { className: 'stat-label', textContent: 'best' }),
      this.loadBestBtn,
    );
    const hud = el('section', { className: 'hud' }, this.wallsBox, this.moves, this.bestBox);

    this.boardSlot = el('div', { className: 'board-slot' });

    // Actions
    this.goBtn = el('button', { type: 'button', className: 'go', textContent: 'Go' });
    this.goBtn.addEventListener('click', () => h.go());
    this.undoBtn = el('button', { type: 'button', className: 'chip', textContent: 'Undo' });
    this.undoBtn.addEventListener('click', () => h.undo());
    this.resetBtn = el('button', { type: 'button', className: 'chip', textContent: 'Reset' });
    this.resetBtn.addEventListener('click', () => h.reset());

    this.goBtn.title = 'Go (G)';
    this.undoBtn.title = 'Undo (Ctrl+Z)';
    this.resetBtn.title = 'Reset (R)';
    for (const [t, b] of this.typeButtons) b.title = `New ${t} map (N)`;

    const muteBtn = el('button', { type: 'button', className: 'chip mute' });
    const showMute = (m: boolean) => {
      muteBtn.textContent = m ? 'Sound off' : 'Sound on';
      muteBtn.setAttribute('aria-pressed', String(m));
      muteBtn.title = m ? 'Turn sound effects on' : 'Turn sound effects off';
    };
    showMute(muted);
    muteBtn.addEventListener('click', () => {
      const m = muteBtn.getAttribute('aria-pressed') !== 'true';
      showMute(m);
      h.setMute(m);
    });

    const speedBox = el('fieldset', { className: 'speed' }, el('legend', { textContent: 'Speed' }));
    for (const s of SPEEDS) {
      const input = el('input', { type: 'radio' });
      input.name = 'speed';
      input.value = s;
      input.checked = s === speed;
      input.addEventListener('change', () => input.checked && h.setSpeed(s));
      this.speedInputs.set(s, input);
      speedBox.append(el('label', {}, input, el('span', { textContent: SPEED_LABELS[s] })));
    }
    const actions = el(
      'section',
      { className: 'actions' },
      this.goBtn,
      el('div', { className: 'edit' }, this.undoBtn, this.resetBtn),
      speedBox,
      muteBtn,
    );

    this.message = el('p', { className: 'message' });
    this.message.setAttribute('role', 'status');

    const hint = el('p', { className: 'hint' });
    hint.append(
      ...['G', 'R', 'Ctrl+Z', 'N'].flatMap((k, i) => [
        el('kbd', { textContent: k }),
        ` ${['go', 'reset', 'undo', 'new map'][i]}${i < 3 ? '  ' : ''}`,
      ]),
    );
    const main = el(
      'main',
      { className: 'play' },
      hud,
      this.boardSlot,
      this.message,
      actions,
      hint,
    );
    root.replaceChildren(header, main);
  }

  setMap(type: MapType, seed: number, daily = false): void {
    for (const [t, b] of this.typeButtons) b.setAttribute('aria-pressed', String(t === type));
    this.typePrefix.textContent = `${type}-`;
    this.dailyTag.hidden = !daily;
    this.seedInput.value = String(seed);
  }

  setWalls(left: number, budget: number): void {
    this.wallsCount.textContent = String(left);
    this.wallsBudget.textContent = `of ${budget} walls left`;
    this.wallsBox.classList.toggle('empty', left === 0);
  }

  /** Flashes the walls counter (no walls left). */
  flashWalls(): void {
    this.restartAnimation(this.wallsBox, 'flash');
  }

  /**
   * Shows the move counter: one number, or `green + red = total` for two paths. `null` = no run
   * yet. `stale` dims a count that no longer matches the walls.
   */
  setMoves(moves: readonly number[] | null, stale = false): void {
    this.moves.classList.toggle('stale', stale || moves === null);
    const total = moves ? moves.reduce((a, b) => a + b, 0) : 0;
    if (!moves || moves.length < 2) {
      this.moves.replaceChildren(
        el('span', { className: 'total', textContent: moves ? String(total) : '0' }),
        el('span', { className: 'unit', textContent: total === 1 ? 'move' : 'moves' }),
      );
      return;
    }
    this.moves.replaceChildren(
      el('span', { className: 'green', textContent: String(moves[0]) }),
      el('span', { className: 'op', textContent: '+' }),
      el('span', { className: 'red', textContent: String(moves[1]) }),
      el('span', { className: 'op', textContent: '=' }),
      el('span', { className: 'total', textContent: String(total) }),
      el('span', { className: 'unit', textContent: 'moves' }),
    );
  }

  /** Every 100 moves the counter pulses, like the original. */
  pulseMoves(): void {
    this.restartAnimation(this.moves, 'pulse');
  }

  setBest(best: number | null, canLoad: boolean): void {
    this.bestBox.hidden = best === null;
    this.bestValue.textContent = best === null ? '' : String(best);
    this.loadBestBtn.hidden = !canLoad;
  }

  setEditState(canUndo: boolean, canReset: boolean): void {
    this.undoBtn.disabled = !canUndo;
    this.resetBtn.disabled = !canReset;
  }

  setRunning(running: boolean): void {
    this.goBtn.classList.toggle('running', running);
    this.goBtn.textContent = running ? 'Restart' : 'Go';
  }

  /** Shows a message. With `ms`, it clears itself after that long. */
  say(text: string, tone: Tone = 'info', ms = 0): void {
    window.clearTimeout(this.messageTimer);
    this.message.textContent = text;
    this.message.dataset.tone = tone;
    if (text) this.restartAnimation(this.message, 'show');
    if (ms > 0) this.messageTimer = window.setTimeout(() => this.say(''), ms);
  }

  private restartAnimation(e: HTMLElement, cls: string): void {
    e.classList.remove(cls);
    void e.offsetWidth;
    e.classList.add(cls);
  }
}
