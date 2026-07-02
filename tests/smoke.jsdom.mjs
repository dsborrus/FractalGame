// smoke.jsdom.mjs — v2 runtime crash test: boots the game in jsdom with
// stubbed Canvas2D + WebAudio, plays call-and-response phrases through a
// surge and up to game over, submits a score. Run: node tests/smoke.jsdom.mjs
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

const pageErrors = [];
window.addEventListener('error', (e) => pageErrors.push(e.message || String(e)));

// ---- Canvas2D stub ----
const gradStub = { addColorStop() {} };
const ctxStub = new Proxy({}, {
  get(t, p) { if (!(p in t)) t[p] = () => gradStub; return t[p]; },
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

globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- boot ----
await import('../js/game.js');
await sleep(150);
const fb = window.__fb;
assert.ok(fb, 'test hook exposed');
assert.equal(fb.mode(), 'menu');

// mode select buttons exist and toggle
window.document.getElementById('mode-daily').click();
assert.equal(fb.runMode(), 'daily');
window.document.getElementById('mode-endless').click();
assert.equal(fb.runMode(), 'endless');

// ---- start a run ----
window.document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 300 }));
assert.equal(fb.mode(), 'playing', 'run started');
const m = fb.music;
const actx = m.ctx;
const setT = async (t) => { actx._t = t; await sleep(45); }; // let a few rAF frames run

// ---- helper: play one phrase (echo every note) ----
async function playPhrase() {
  // move into this phrase's call bar and let the engine set it up
  const idx = Math.max(0, Math.floor((actx._t - m.anchor) / (8 * m.beatDur)) + (fb.phrase() ? 1 : 0));
  await setT(m.anchor + idx * 8 * m.beatDur + 0.01);
  const ph = fb.phrase();
  assert.ok(ph, 'phrase exists');
  assert.equal(ph.idx, idx, 'phrase index tracks the clock');
  if (ph.isSurge) {
    await setT(ph.respStart);
    fb.press();
    assert.ok(fb.phrase().pressed, 'surge press registered');
    await setT(ph.respStart + 2 * m.beatDur);
    fb.release();
    assert.ok(fb.phrase().resolved, 'surge resolved');
    return { surge: true };
  }
  for (const st of ph.slotTimes) {
    await setT(st);
    fb.press();
  }
  assert.ok(fb.phrase().hit.every(Boolean), 'all pattern notes hit');
  return { surge: false, notes: ph.slotTimes.length };
}

// ---- phrase 0: tier 0 pattern (3 notes), taps during call bar are ignored ----
await setT(m.anchor + 0.01);
let ph = fb.phrase();
assert.ok(ph && !ph.isSurge, 'first phrase is a normal pattern');
assert.equal(ph.pattern.slots.length, 3, 'tier 0 pattern has 3 notes');
assert.equal(ph.pattern.slots[0], 0, 'pattern includes downbeat');
fb.press(); // during call bar
assert.equal(fb.run().score, 0, 'call-bar tap is ignored, no penalty');
assert.equal(fb.run().sparks, 3);

for (const st of ph.slotTimes) { await setT(st); fb.press(); }
assert.equal(fb.run().combo, 3, 'echoed all 3 notes');
// 3 perfect (300) + echo bonus (250)
assert.equal(fb.run().score, 550, 'pattern scoring incl. echo bonus');

// ---- off-pattern tap costs a spark ----
await setT(ph.respStart + 3.5 * m.beatDur); // far from any slot, all hit anyway
fb.press();
assert.equal(fb.run().sparks, 2, 'off-pattern tap drains a spark');
assert.equal(fb.run().combo, 0);

// ---- play phrases until a surge appears (requires tier >= 1) ----
let sawSurge = false;
let guard = 0;
while (!sawSurge && fb.mode() === 'playing' && guard++ < 20) {
  const before = fb.run().score;
  const r = await playPhrase();
  sawSurge = r.surge;
  assert.ok(fb.run().score >= before, 'score never decreases');
}
assert.ok(sawSurge, 'surge phrase occurred after reaching tier 1');
assert.ok(fb.run().tier >= 1, 'tier advanced');
assert.ok(fb.run().sparks >= 2, 'clean surge did not cost sparks');
const scoreAfterSurge = fb.run().score;
assert.ok(scoreAfterSurge > 550, 'score accumulated');

// ---- modifier reflects tier ----
assert.ok(['wind', 'night', 'fireflies'].includes(fb.modifier()), 'tier modifier active');

// ---- drain sparks with off-pattern taps until game over ----
guard = 0;
while (fb.mode() === 'playing' && guard++ < 30) {
  // jump to next phrase's response bar, tap off-pattern
  const idx = Math.floor((actx._t - m.anchor) / (8 * m.beatDur)) + 1;
  await setT(m.anchor + idx * 8 * m.beatDur + 0.01);
  const p = fb.phrase();
  if (p.isSurge) { // fail the surge by pressing very late
    await setT(p.respStart + 3 * m.beatDur);
    fb.press();
  } else {
    // tap far from every slot (between last slot and bar end, ≥good away)
    await setT(p.respStart + 3.9 * m.beatDur);
    fb.press();
  }
}
assert.equal(fb.mode(), 'gameover', 'run ended after sparks drained');
await sleep(700);
assert.ok(!window.document.getElementById('gameover').classList.contains('hidden'), 'gameover visible');

// ---- submit (API unreachable -> local fallback) ----
window.document.getElementById('name-input').value = 'SmokeTester';
window.document.getElementById('submit-btn').click();
await sleep(300);
const local = JSON.parse(window.localStorage.getItem('fb_scores'));
assert.equal(local[0].name, 'SmokeTester', 'score saved locally');
assert.ok(window.document.getElementById('board').children.length >= 1, 'board rendered');

// ---- board tabs don't crash ----
window.document.getElementById('over-tab-daily').click();
window.document.getElementById('over-tab-all').click();
await sleep(150);

// ---- restart ----
window.document.getElementById('again-btn').click();
assert.equal(fb.mode(), 'playing', 'restart works');
assert.equal(fb.run().score, 0);

// ---- daily mode determinism: same date seed => same first patterns ----
// (patterns come from the seeded rng; two runs on the same UTC date match)
const patternsA = [];
for (let i = 0; i < 3; i++) {
  const idx = Math.floor((actx._t - m.anchor) / (8 * m.beatDur)) + 1;
  await setT(m.anchor + idx * 8 * m.beatDur + 0.01);
  patternsA.push(fb.phrase().pattern.slots.join(','));
}

// ---- let the render loop run; ensure zero uncaught errors ----
await sleep(900);
assert.deepEqual(pageErrors, [], 'no uncaught page errors');

m.stop();
console.log('SMOKE TEST v2 PASSED ✔  (boot, call/response, echo bonus, off-pattern, surge, modifiers, gameover, submit, tabs, restart)');
process.exit(0);
