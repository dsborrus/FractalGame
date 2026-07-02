import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tierTempo, timingWindows, nearestBeatDelta, judge, multiplierFor,
  scoreFor, isBloomCombo, seedBonus, applyTap, newRunState,
  sanitizeName, validScore, MAX_DEPTH, MAX_SPARKS, BLOOM_EVERY,
} from '../js/core.js';
import * as apiValidate from '../api/_validate.js';

test('tempo rises with tier and caps at 128', () => {
  assert.equal(tierTempo(0), 112);
  assert.equal(tierTempo(3), 118);
  assert.equal(tierTempo(50), 128);
});

test('timing windows tighten but never below floor', () => {
  const t0 = timingWindows(0);
  assert.equal(t0.perfect, 70);
  assert.equal(t0.good, 150);
  const t20 = timingWindows(20);
  assert.equal(t20.perfect, 50);
  assert.equal(t20.good, 110);
});

test('nearestBeatDelta finds signed offset to nearest beat', () => {
  const dur = 0.5, anchor = 10;
  assert.ok(Math.abs(nearestBeatDelta(10.5, anchor, dur)) < 1e-9);      // on beat
  assert.ok(Math.abs(nearestBeatDelta(10.52, anchor, dur) - 0.02) < 1e-9); // late
  assert.ok(Math.abs(nearestBeatDelta(10.48, anchor, dur) + 0.02) < 1e-9); // early
  assert.ok(Math.abs(Math.abs(nearestBeatDelta(10.25, anchor, dur)) - 0.25) < 1e-9); // exactly between
});

test('judge maps offsets to judgments', () => {
  const w = timingWindows(0);
  assert.equal(judge(0, w), 'perfect');
  assert.equal(judge(70, w), 'perfect');
  assert.equal(judge(71, w), 'good');
  assert.equal(judge(150, w), 'good');
  assert.equal(judge(151, w), 'miss');
});

test('multiplier grows every 8 combo', () => {
  assert.equal(multiplierFor(0), 1);
  assert.equal(multiplierFor(7), 1);
  assert.equal(multiplierFor(8), 2);
  assert.equal(multiplierFor(16), 3);
});

test('scoring', () => {
  assert.equal(scoreFor('perfect', 1), 100);
  assert.equal(scoreFor('good', 2), 100);
  assert.equal(scoreFor('miss', 3), 0);
});

test('bloom combo detection', () => {
  assert.equal(isBloomCombo(0), false);
  assert.equal(isBloomCombo(8), true);
  assert.equal(isBloomCombo(9), false);
  assert.equal(isBloomCombo(16), true);
});

test('applyTap: perfect tap grows and scores', () => {
  const { state, events } = applyTap(newRunState(), 'perfect');
  assert.equal(state.score, 100);
  assert.equal(state.combo, 1);
  assert.equal(state.depth, 1);
  assert.deepEqual(events, ['grow']);
});

test('applyTap: miss drains spark and resets combo', () => {
  let s = newRunState();
  s.combo = 5;
  const { state, events } = applyTap(s, 'miss');
  assert.equal(state.combo, 0);
  assert.equal(state.sparks, MAX_SPARKS - 1);
  assert.ok(events.includes('wither'));
  assert.ok(!events.includes('gameover'));
});

test('applyTap: third miss triggers gameover', () => {
  let s = newRunState();
  s.sparks = 1;
  const { state, events } = applyTap(s, 'miss');
  assert.equal(state.sparks, 0);
  assert.ok(events.includes('gameover'));
});

test('applyTap: 8th combo blooms, restores spark, adds bonus', () => {
  let s = newRunState();
  s.combo = 7; s.sparks = 2;
  const { state, events } = applyTap(s, 'good');
  assert.ok(events.includes('bloom'));
  assert.equal(state.sparks, 3);
  assert.equal(state.combo, 8);
  // good (50 * mult 2 = 100) + bloom (500 * 2 = 1000)
  assert.equal(state.score, 1100);
});

test('applyTap: reaching max depth seeds a new tier', () => {
  let s = newRunState();
  s.depth = MAX_DEPTH - 1;
  const { state, events } = applyTap(s, 'perfect');
  assert.ok(events.includes('seed'));
  assert.equal(state.tier, 1);
  assert.equal(state.depth, 0);
  assert.equal(state.score, 100 + seedBonus(0));
});

test('full simulated run: 100 perfect taps never corrupts state', () => {
  let s = newRunState();
  for (let i = 0; i < 100; i++) {
    const r = applyTap(s, 'perfect');
    s = r.state;
    assert.ok(s.score >= 0 && Number.isInteger(s.score));
    assert.ok(s.depth >= 0 && s.depth < MAX_DEPTH);
    assert.ok(s.sparks >= 0 && s.sparks <= MAX_SPARKS);
  }
  assert.ok(s.tier >= 10); // 100 taps / 9 per tier
  assert.equal(s.bestCombo, 100);
});

test('sanitizeName strips angle brackets/control chars, trims, caps at 20', () => {
  for (const fn of [sanitizeName, apiValidate.sanitizeName]) {
    assert.equal(fn('  Daniel  '), 'Daniel');
    assert.equal(fn('<script>alert(1)</script>'), 'scriptalert(1)/scrip'); // capped at 20
    assert.equal(fn('a'.repeat(50)).length, 20);
    assert.equal(fn(null), '');
    assert.equal(fn(42), '');
    assert.equal(fn('nice name_123'), 'nice name_123');
  }
});

test('validScore accepts sane integers only', () => {
  for (const fn of [validScore, apiValidate.validScore]) {
    assert.equal(fn(100), true);
    assert.equal(fn(0), false);
    assert.equal(fn(-5), false);
    assert.equal(fn(1.5), false);
    assert.equal(fn(99_999_999), false);
    assert.equal(fn('100'), false);
    assert.equal(fn(NaN), false);
  }
});
