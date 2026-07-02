// core.js — pure game logic (no DOM, no audio). Shared by game + tests.

export const BASE_BPM = 112;
export const MAX_BPM = 128;
export const MAX_DEPTH = 9;
export const MAX_SPARKS = 3;
export const BLOOM_EVERY = 8;

// Tempo rises 2 BPM per tier, capped.
export function tierTempo(tier) {
  return Math.min(MAX_BPM, BASE_BPM + tier * 2);
}

// Timing windows (ms) tighten slightly per tier.
export function timingWindows(tier) {
  return {
    perfect: Math.max(50, 70 - tier * 3),
    good: Math.max(110, 150 - tier * 5),
  };
}

// Signed offset (seconds) from t to the nearest beat, given anchor + beat duration.
export function nearestBeatDelta(t, anchor, beatDur) {
  const x = (t - anchor) / beatDur;
  return (x - Math.round(x)) * beatDur;
}

// Judge a tap. deltaMs = |offset from nearest beat| in ms.
export function judge(deltaMs, windows) {
  if (deltaMs <= windows.perfect) return 'perfect';
  if (deltaMs <= windows.good) return 'good';
  return 'miss';
}

export function multiplierFor(combo) {
  return 1 + Math.floor(combo / BLOOM_EVERY);
}

export function scoreFor(judgment, mult) {
  if (judgment === 'perfect') return 100 * mult;
  if (judgment === 'good') return 50 * mult;
  return 0;
}

export function isBloomCombo(combo) {
  return combo > 0 && combo % BLOOM_EVERY === 0;
}

export function seedBonus(tier) {
  return 1000 * (tier + 1);
}

// Apply one tap to game state; returns new state + events. State is immutable-ish.
export function applyTap(state, judgment) {
  const s = { ...state };
  const events = [];
  if (judgment === 'miss') {
    s.combo = 0;
    s.sparks -= 1;
    events.push('wither');
    if (s.sparks <= 0) events.push('gameover');
    return { state: s, events };
  }
  s.combo += 1;
  s.bestCombo = Math.max(s.bestCombo, s.combo);
  const mult = multiplierFor(s.combo);
  s.score += scoreFor(judgment, mult);
  events.push('grow');
  if (isBloomCombo(s.combo)) {
    s.score += 500 * mult;
    s.sparks = Math.min(MAX_SPARKS, s.sparks + 1);
    events.push('bloom');
  }
  s.depth += 1;
  if (s.depth >= MAX_DEPTH) {
    s.score += seedBonus(s.tier);
    s.tier += 1;
    s.depth = 0;
    events.push('seed');
  }
  return { state: s, events };
}

export function newRunState() {
  return { score: 0, combo: 0, bestCombo: 0, sparks: MAX_SPARKS, depth: 0, tier: 0 };
}

// Shared with the API conceptually — client-side sanitize before submit.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
}

export function validScore(n) {
  return Number.isInteger(n) && n > 0 && n < 10_000_000;
}
