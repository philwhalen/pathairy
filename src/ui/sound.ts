/**
 * Small synthesized sound effects (Web Audio oscillator blips, no asset files). The AudioContext
 * is created lazily on the first user gesture. Everything is a no-op when muted or when Web Audio
 * is unavailable.
 */
export type SoundName = 'tick' | 'checkpoint' | 'teleport' | 'best';

interface Blip {
  /** Frequency at the start and end, in Hz. */
  from: number;
  to: number;
  /** Seconds after the call the blip starts, and how long it lasts. */
  at: number;
  dur: number;
  type: OscillatorType;
  gain: number;
}

const BLIPS: Record<SoundName, Blip[]> = {
  tick: [{ from: 1200, to: 1000, at: 0, dur: 0.04, type: 'square', gain: 0.025 }],
  checkpoint: [{ from: 660, to: 880, at: 0, dur: 0.1, type: 'triangle', gain: 0.07 }],
  teleport: [{ from: 300, to: 1200, at: 0, dur: 0.22, type: 'sine', gain: 0.06 }],
  best: [
    { from: 523, to: 523, at: 0, dur: 0.1, type: 'triangle', gain: 0.07 },
    { from: 659, to: 659, at: 0.09, dur: 0.1, type: 'triangle', gain: 0.07 },
    { from: 784, to: 784, at: 0.18, dur: 0.18, type: 'triangle', gain: 0.07 },
  ],
};

export class Sound {
  private ctx: AudioContext | null = null;
  private failed = false;

  constructor(public muted: boolean) {}

  /** Call from a user gesture (click, key press): creates or resumes the audio context. */
  unlock(): void {
    if (this.muted) return;
    const ctx = this.context();
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  }

  play(name: SoundName): void {
    if (this.muted) return;
    const ctx = this.context();
    if (!ctx || ctx.state !== 'running') return;
    try {
      const now = ctx.currentTime;
      for (const b of BLIPS[name]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const t0 = now + b.at;
        osc.type = b.type;
        osc.frequency.setValueAtTime(b.from, t0);
        osc.frequency.linearRampToValueAtTime(b.to, t0 + b.dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(b.gain, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + b.dur);
        osc.connect(g).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + b.dur + 0.02);
      }
    } catch {
      // Audio is optional; never let it break the game.
    }
  }

  private context(): AudioContext | null {
    if (this.ctx || this.failed) return this.ctx;
    try {
      const Ctor =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('no Web Audio');
      this.ctx = new Ctor();
    } catch {
      this.failed = true;
    }
    return this.ctx;
  }
}
