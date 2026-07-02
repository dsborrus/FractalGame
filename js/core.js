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

// ---------------------------------------------------------------------------
// v2: call-and-response patterns, surges, tier modifiers, daily seeds.
// ---------------------------------------------------------------------------

export const PATTERN_BONUS = 250; // × multiplier, for completing a full echo
export const SURGE_BONUS = 400;   // × multiplier, for a clean hold-and-release
export const PHRASE_BEATS = 8;    // 1 bar call + 1 bar response
export const SLOTS_PER_BAR = 8;   // eighth-note slots

// FNV-1a string hash → uint32 (for daily seeds).
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — tiny deterministic PRNG.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// UTC date string, e.g. "2026-07-02" — shared seed for the daily bloom.
export function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Generate a call pattern for one bar. Slots are eighth-note indices 0..7
// (0 = downbeat, always included). Density and syncopation rise with tier.
export function generatePattern(tier, rng) {
  const size = tier === 0 ? 3 : tier < 3 ? 4 : 5;
  const allowed = tier === 0 ? [2, 4, 6] : [1, 2, 3, 4, 5, 6, 7];
  const pool = [...allowed];
  const slots = [0];
  while (slots.length < size && pool.length) {
    slots.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  slots.sort((a, b) => a - b);
  // Melodic contour: a gentle upward walk over the pentatonic scale.
  let p = Math.floor(rng() * 3);
  const notes = slots.map(() => {
    const n = p;
    p = Math.min(9, p + Math.floor(rng() * 3));
    return n;
  });
  return { slots, notes };
}

// Every 4th phrase is a hold-and-release surge, once tier >= 1.
export function isSurgePhrase(phraseIdx, tier) {
  return tier >= 1 && phraseIdx % 4 === 3;
}

// Visual/attention modifier per tier: none → wind → night → fireflies → rotate.
export function modifierForTier(tier) {
  if (tier <= 0) return 'none';
  if (tier <= 3) return ['wind', 'night', 'fireflies'][tier - 1];
  return ['wind', 'night', 'fireflies'][(tier - 1) % 3];
}

// Judge a response-bar tap against the pattern's slot times.
// Returns { slot, judgment, delta }; slot = -1 means off-pattern (a miss).
export function judgeResponseTap(t, slotTimes, hit, windows) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < slotTimes.length; i++) {
    if (hit[i]) continue;
    const d = Math.abs(t - slotTimes[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return { slot: -1, judgment: 'miss', delta: Infinity };
  const j = judge(bestD * 1000, windows);
  return { slot: j === 'miss' ? -1 : best, judgment: j, delta: bestD };
}

// Bonus applications (pure, like applyTap).
export function applyPatternBonus(state) {
  const s = { ...state };
  s.score += PATTERN_BONUS * multiplierFor(s.combo);
  return s;
}

export function applySurgeBonus(state) {
  const s = { ...state };
  s.score += SURGE_BONUS * multiplierFor(s.combo);
  return s;
}
