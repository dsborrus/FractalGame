// smoke.jsdom.mjs — full runtime crash test: boots the game in jsdom with
// stubbed Canvas2D + WebAudio, plays through to game over, submits a score.
// Run: node tests/smoke.jsdom.mjs   (requires: npm i -D jsdom)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const { window } = dom;

// ---- track any uncaught errors from the page ----
const pageErrors = [];
window.addEventListener('error', (e) => pageErrors.push(e.message || String(e)));

// ---- Canvas2D stub ----
const gradStub = { addColorStop() {} };
const ctxStub = new Proxy({}, {
  get(t, p) {
    if (p in t) return t[p];
    t[p] = () => gradStub;
    return t[p];
  },
  set(t, p, v) { t[p] = v; return true; },
});
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;

// ---- WebAudio stub with controllable clock ----
const param = () => ({
  value: 0,
  setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {},
  cancelScheduledValues() {}, setTargetAtTime() {},
});
const node = () => ({
  connect(n) { return n; }, start() {}, stop() {},
  gain: param(), frequency: param(), detune: param(),
  Q: param(), threshold: param(), ratio: param(),
  type: '', buffer: null,
});
class FakeAudioContext {
  constructor() {
    this._t = 0;
    this.state = 'running';
    this.sampleRate = 44100;
    this.destination = node();
    FakeAudioContext.last = this;
  }
  get currentTime() { return this._t; }
  resume() { return Promise.resolve(); }
  createGain() { return node(); }
  createOscillator() { return node(); }
  createBiquadFilter() { return node(); }
  createDynamicsCompressor() { return node(); }
  createBufferSource() { return node(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
}
window.AudioContext = FakeAudioContext;

// ---- expose browser globals to the module ----
for (const k of ['window', 'document', 'localStorage', 'requestAnimationFrame',
  'cancelAnimationFrame', 'HTMLCanvasElement']) {
  globalThis[k] = window[k] ?? window;
}
globalThis.window = window;
globalThis.document = window.document;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tapAt = (fb, t) => { fb.music.ctx._t = t; fb.tap(); };

// ---- boot the game ----
await import('../js/game.js');
await sleep(150); // let menu leaderboard fetch fail -> local fallback
const fb = window.__fb;
assert.ok(fb, 'test hook exposed');
assert.equal(fb.mode(), 'menu');
assert.ok(!window.document.getElementById('menu').classList.contains('hidden'), 'menu visible');

// ---- start a run via pointerdown ----
window.document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 300 }));
assert.equal(fb.mode(), 'playing', 'run started on tap');
assert.ok(window.document.getElementById('menu').classList.contains('hidden'), 'menu hidden');
assert.ok(!window.document.getElementById('hud').classList.contains('hidden'), 'hud visible');

const music = fb.music;
const beat = music.beatDur;
assert.ok(Math.abs(beat - 60 / 112) < 1e-9, 'tempo is 112 bpm');

// ---- taps during grace period are ignored ----
tapAt(fb, music.anchor + 1 * beat);
assert.equal(fb.run().score, 0, 'grace period tap ignored');

// ---- perfect taps on the beat ----
let n = 5;
for (let i = 0; i < 3; i++) tapAt(fb, music.anchor + (n + i) * beat);
assert.equal(fb.run().combo, 3, 'three perfect taps -> combo 3');
assert.equal(fb.run().score, 300, 'perfect tap scoring');
assert.equal(window.document.getElementById('score').textContent, '300', 'HUD score updated');

// ---- debounce: instant double tap does nothing ----
tapAt(fb, music.anchor + 7 * beat + 0.05);
assert.equal(fb.run().combo, 3, 'debounced double tap ignored');

// ---- good tap (inside good window, outside perfect) ----
tapAt(fb, music.anchor + 9 * beat + 0.100); // 100ms late @112bpm
assert.equal(fb.run().combo, 4);
assert.equal(fb.run().score, 350, 'good tap = +50');

// ---- off-beat taps drain sparks, then game over ----
for (let i = 0; i < 3; i++) tapAt(fb, music.anchor + (11 + i) * beat + beat * 0.45);
assert.equal(fb.run().sparks, 0, 'three misses drain sparks');
assert.equal(fb.mode(), 'gameover', 'game over triggered');
await sleep(700); // gameover screen shows after a beat
assert.ok(!window.document.getElementById('gameover').classList.contains('hidden'), 'gameover visible');
assert.equal(window.document.getElementById('final-score').textContent, '350');

// ---- submit score (API unreachable -> local fallback) ----
window.document.getElementById('name-input').value = 'SmokeTester';
window.document.getElementById('submit-btn').click();
await sleep(300);
const local = JSON.parse(window.localStorage.getItem('fb_scores'));
assert.equal(local[0].name, 'SmokeTester', 'score saved locally');
assert.equal(local[0].score, 350);
const board = window.document.getElementById('board');
assert.ok(board.children.length >= 1, 'leaderboard rendered');
assert.match(window.document.getElementById('board-title').textContent, /this device/, 'offline fallback labeled');

// ---- play again ----
window.document.getElementById('again-btn').click();
assert.equal(fb.mode(), 'playing', 'restart works');
assert.equal(fb.run().score, 0);

// ---- let the render loop run a while; ensure zero uncaught errors ----
await sleep(1200);
assert.deepEqual(pageErrors, [], 'no uncaught page errors during render loop');

music.stop();
console.log('SMOKE TEST PASSED ✔  (boot, run, scoring, miss/gameover, submit, restart, render loop)');
process.exit(0);
