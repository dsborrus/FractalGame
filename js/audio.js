// audio.js — generative minimal deep-house engine + SFX (WebAudio).
// The audio clock is the game clock: beats live at anchor + n * beatDur.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Chord progression (4 bars each): Am7, Fmaj7, Cmaj7, G6 — soft, diatonic.
const CHORDS = [
  { root: 45, pad: [57, 60, 64, 67] }, // A2 root, pad A3 C4 E4 G4
  { root: 41, pad: [57, 60, 65, 69] }, // F2, A3 C4 F4 A4
  { root: 48, pad: [55, 60, 64, 71] }, // C3, G3 C4 E4 B4
  { root: 43, pad: [55, 59, 62, 64] }, // G2, G3 B3 D4 E4
];

// A-minor pentatonic for tap plucks.
const PENTA = [69, 72, 74, 76, 79, 81, 84, 86, 88, 91];

export class MusicEngine {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.bpm = 112;
    this.anchor = 0;          // time of beat 0
    this.beatIndex = 0;       // next beat to schedule
    this.lookahead = 0.15;    // seconds
    this.timer = null;
    this.muted = false;
    this.onBeat = null;       // callback(beatNumber, atTime) — fired via rAF polling, not here
  }

  get beatDur() { return 60 / this.bpm; }

  now() { return this.ctx ? this.ctx.currentTime : 0; }

  start() {
    if (this.running) return;
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.anchor = this.ctx.currentTime + 0.1;
    this.beatIndex = 0;
    this.running = true;
    this.timer = setInterval(() => this._schedule(), 30);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setTempo(bpm) {
    if (!this.ctx || bpm === this.bpm) { this.bpm = bpm; return; }
    // Re-anchor so beat phase is continuous at the change.
    const t = this.ctx.currentTime;
    const oldDur = this.beatDur;
    const beatsElapsed = (t - this.anchor) / oldDur;
    this.bpm = bpm;
    this.anchor = t - beatsElapsed * this.beatDur;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.now(), 0.05);
  }

  _buildGraph() {
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0.9;
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.ratio.value = 4;
    this.master.connect(this.comp).connect(c.destination);

    // Duckable bus for bass + pads (sidechain feel against the kick).
    this.duck = c.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.master);

    this.sfxGain = c.createGain();
    this.sfxGain.gain.value = 0.5;
    this.sfxGain.connect(this.master);
  }

  // ---- scheduling ----
  _schedule() {
    if (!this.running) return;
    const until = this.ctx.currentTime + this.lookahead;
    while (this.anchor + this.beatIndex * this.beatDur < until) {
      this._scheduleBeat(this.beatIndex, this.anchor + this.beatIndex * this.beatDur);
      this.beatIndex++;
    }
  }

  _scheduleBeat(n, t) {
    const d = this.beatDur;
    const bar = Math.floor(n / 4);
    const beatInBar = n % 4;
    const chord = CHORDS[Math.floor(bar / 4) % CHORDS.length];

    this._kick(t);
    this._duckAt(t);
    this._hat(t + d / 2, 0.12);                     // offbeat hat
    if (beatInBar === 1 || beatInBar === 3) this._hat(t, 0.05); // ghost hat

    // Bass: root on the "and" of every beat, octave up on beat 3's and.
    const bn = beatInBar === 2 ? chord.root + 12 : chord.root;
    this._bass(t + d / 2, midi(bn), d * 0.42);

    // Pad: retrigger at the start of each chord (every 4 bars), long swell.
    if (n % 16 === 0) this._pad(t, chord.pad, 16 * d);
  }

  _kick(t) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.09);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.26);
  }

  _duckAt(t) {
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.45, t);
    g.linearRampToValueAtTime(1, t + this.beatDur * 0.7);
  }

  _hat(t, vol) {
    const c = this.ctx;
    const len = 0.04;
    const buf = this._noise(len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 8000;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(hp).connect(g).connect(this.master);
    src.start(t);
  }

  _noise(len) {
    if (!this._noiseBuf) {
      const c = this.ctx;
      const b = c.createBuffer(1, c.sampleRate * 0.1, c.sampleRate);
      const ch = b.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
      this._noiseBuf = b;
    }
    return this._noiseBuf;
  }

  _bass(t, freq, dur) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 320; f.Q.value = 1;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.42, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f).connect(g).connect(this.duck);
    o.start(t); o.stop(t + dur + 0.05);
  }

  _pad(t, notes, dur) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.085, t + dur * 0.25);
    g.gain.setValueAtTime(0.085, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 0.5;
    g.connect(f).connect(this.duck);
    for (const n of notes) {
      for (const det of [-4, 4]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midi(n);
        o.detune.value = det;
        const og = c.createGain();
        og.gain.value = 1 / (notes.length * 2);
        o.connect(og).connect(g);
        o.start(t); o.stop(t + dur + 0.1);
      }
    }
  }

  // ---- SFX ----
  pluck(step = 0, perfect = false) {
    if (!this.ctx) return;
    this.pluckAt(this.ctx.currentTime, step, perfect);
  }

  // Schedule a pentatonic pluck at an absolute audio-clock time (call melody).
  pluckAt(t, step = 0, perfect = false, vel = 1) {
    if (!this.ctx) return;
    const c = this.ctx;
    const note = PENTA[Math.min(Math.max(0, step), PENTA.length - 1)];
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midi(note);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(4000, t);
    f.frequency.exponentialRampToValueAtTime(600, t + 0.3);
    const g = c.createGain();
    const v = (perfect ? 0.5 : 0.3) * vel;
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(f).connect(g).connect(this.sfxGain);
    o.start(t); o.stop(t + 0.55);
    if (perfect) { // soft octave shimmer
      const o2 = c.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = midi(note + 12);
      const g2 = c.createGain();
      g2.gain.setValueAtTime(0.12, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      o2.connect(g2).connect(this.sfxGain);
      o2.start(t); o2.stop(t + 0.75);
    }
  }

  bloomChord() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [69, 76, 81, 88].forEach((n, i) => {
      const c = this.ctx;
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = midi(n);
      const g = c.createGain();
      const t0 = t + i * 0.06;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.1);
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 1.2);
    });
  }

  missThud() {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.15);
    const g = c.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(this.sfxGain);
    o.start(t); o.stop(t + 0.22);
  }

  // Rising filtered swell announcing a surge (the "call" of a hold phrase).
  swellAt(t, dur) {
    if (!this.ctx) return;
    const c = this.ctx;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 4;
    f.frequency.setValueAtTime(200, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + dur);
    g.connect(f).connect(this.sfxGain);
    for (const det of [-6, 6]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(57); // A3
      o.detune.value = det;
      const og = c.createGain(); og.gain.value = 0.5;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + dur + 0.1);
    }
  }

  // Sustained tone while the player holds; returns a handle to end it.
  startHoldTone() {
    if (!this.ctx) return null;
    const c = this.ctx;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(midi(57), t);
    o.frequency.linearRampToValueAtTime(midi(69), t + 2.5);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.14, t + 0.08);
    o.connect(g).connect(this.sfxGain);
    o.start(t);
    return {
      end: (ok) => {
        const te = c.currentTime;
        g.gain.cancelScheduledValues(te);
        g.gain.setValueAtTime(g.gain.value || 0.14, te);
        g.gain.exponentialRampToValueAtTime(0.001, te + 0.15);
        o.stop(te + 0.2);
        if (ok) this.surgeRelease();
      },
    };
  }

  // Big open chord for a successful surge release.
  surgeRelease() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [57, 64, 69, 76, 81].forEach((n, i) => {
      const c = this.ctx;
      const o = c.createOscillator();
      o.type = i < 2 ? 'triangle' : 'sine';
      o.frequency.value = midi(n);
      const g = c.createGain();
      const t0 = t + i * 0.03;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.4);
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 1.5);
    });
  }
}
