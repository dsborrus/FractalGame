// game.js — Fractal Bloom v2: call-and-response rhythm, surges, modifiers,
// daily blooms. Rendering, input, UI, leaderboard client.
import {
  PHRASE_BEATS,
  tierTempo, timingWindows, judge,
  applyTap, newRunState, sanitizeName, validScore,
  hashSeed, makeRng, utcDateString, generatePattern,
  isSurgePhrase, modifierForTier, judgeResponseTap,
  applyPatternBonus, applySurgeBonus,
} from './core.js';
import { MusicEngine } from './audio.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const music = new MusicEngine();

const $ = (id) => document.getElementById(id);
const ui = {
  menu: $('menu'), hud: $('hud'), over: $('gameover'),
  score: $('score'), combo: $('combo'), sparks: $('sparks'), tier: $('tier'),
  finalScore: $('final-score'), finalStats: $('final-stats'),
  name: $('name-input'), submit: $('submit-btn'), again: $('again-btn'),
  board: $('board'), boardTitle: $('board-title'),
  menuBoard: $('menu-board'), mute: $('mute-btn'), hint: $('hint'),
  modeEndless: $('mode-endless'), modeDaily: $('mode-daily'),
  tabAll: $('tab-all'), tabDaily: $('tab-daily'),
  overTabAll: $('over-tab-all'), overTabDaily: $('over-tab-daily'),
};

// ---------- sizing ----------
let W = 0, H = 0, DPR = 1, unit = 100, seedX = 0, seedY = 0, ringR = 24;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  unit = Math.min(W, H) * 0.26;
  seedX = W / 2;
  seedY = H * (H > W ? 0.72 : 0.8);
  ringR = Math.max(18, unit * 0.13);
}
window.addEventListener('resize', resize);
resize();

// ---------- game state ----------
let mode = 'menu';            // menu | playing | gameover
let runMode = localStorage.getItem('fb_mode') === 'daily' ? 'daily' : 'endless';
let run = newRunState();
let rng = makeRng(1);
let baseHue = 210;
let lastTapT = -10;
let beatFlash = 0;
let lastBeatNum = -1;
let shake = 0;
let modifier = 'none';

// Phrase engine: 1 bar "listen" (call) + 1 bar "echo" (response).
let phrase = null; // {idx, pattern, isSurge, callStart, respStart, respEnd, slotTimes, hit, dots, resolved, pressed}
let hold = null;   // {pressJ, tone} while a surge hold is active

// ---------- tree ----------
let branches = [], leaves = [];
let oldTree = null;

function resetTree(now) {
  branches = []; leaves = [];
  const trunk = { x0: 0, y0: 0, x1: 0, y1: 1, depth: 0, bornAt: now, wither: 0, witherT: 0, hueOff: 0 };
  branches.push(trunk); leaves.push(trunk);
}

function growGeneration(now, biasX = 0) {
  const lean = Math.max(-1, Math.min(1, biasX)) * 0.09; // steer with tap side
  const next = [];
  for (const b of leaves) {
    const ang = Math.atan2(b.x1 - b.x0, b.y1 - b.y0);
    const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) * (0.7 + Math.random() * 0.06);
    for (const side of [-1, 1]) {
      const a = ang + side * (0.38 + Math.random() * 0.22) + lean;
      const child = {
        x0: b.x1, y0: b.y1,
        x1: b.x1 + Math.sin(a) * len,
        y1: b.y1 + Math.cos(a) * len,
        depth: b.depth + 1, bornAt: now, wither: 0, witherT: 0,
        hueOff: b.hueOff + side * (2 + Math.random() * 4),
      };
      branches.push(child); next.push(child);
    }
  }
  leaves = next;
}

function witherSome() {
  const n = Math.min(leaves.length, 6 + Math.floor(Math.random() * 3));
  for (let i = 0; i < n; i++) leaves[(Math.random() * leaves.length) | 0].witherT = 1;
}

const tx = (x) => seedX + x * unit;
const ty = (y) => seedY - y * unit;

// ---------- particles ----------
const parts = [];
const MAX_PARTS = 420;
function spawn(p) { if (parts.length < MAX_PARTS) parts.push(p); }

function sparkBurst(x, y, hue, n, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random());
    spawn({ kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      life: 0, max: 0.5 + Math.random() * 0.5, hue: hue + Math.random() * 30 - 15, size: 1 + Math.random() * 2 });
  }
}

function petalsFromTips(count, hue) {
  const tips = leaves.length ? leaves : branches;
  if (!tips.length) return;
  for (let i = 0; i < count; i++) {
    const b = tips[(Math.random() * tips.length) | 0];
    spawn({ kind: 'petal', x: tx(b.x1), y: ty(b.y1),
      vx: (Math.random() - 0.5) * 30, vy: -20 - Math.random() * 40,
      life: 0, max: 2.5 + Math.random() * 2, hue: hue + Math.random() * 40 - 20,
      size: 2 + Math.random() * 3, sway: Math.random() * Math.PI * 2 });
  }
}

function floatText(x, y, text, hue) {
  spawn({ kind: 'text', x, y, vx: 0, vy: -34, life: 0, max: 0.9, hue, size: 15, text });
}

// ---------- HUD ----------
function setHud() {
  ui.score.textContent = run.score.toLocaleString();
  if (run.combo > 1) {
    ui.combo.textContent = run.combo + '×';
    ui.combo.classList.add('show');
  } else ui.combo.classList.remove('show');
  const modName = modifier !== 'none' && run.tier > 0 ? ' · ' + modifier : '';
  ui.tier.textContent = (run.tier > 0 ? 'tier ' + (run.tier + 1) : '') + modName;
  const dots = ui.sparks.children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('lost', i >= run.sparks);
}
function popCombo() {
  ui.combo.classList.remove('pop'); void ui.combo.offsetWidth; ui.combo.classList.add('pop');
}
function setHint(text) {
  if (text) { ui.hint.textContent = text; ui.hint.classList.remove('hidden'); }
  else ui.hint.classList.add('hidden');
}

// ---------- phrase engine ----------
function phraseWindowStart(idx) { return music.anchor + idx * PHRASE_BEATS * music.beatDur; }

function setupPhrase(idx, t) {
  // Settle the previous phrase: unhit notes / unattempted surge break the combo.
  if (phrase && mode === 'playing') {
    const missedNotes = !phrase.isSurge && phrase.hit.some((h) => !h);
    const skippedSurge = phrase.isSurge && !phrase.resolved && !phrase.pressed;
    if (phrase.isSurge && !phrase.resolved && phrase.pressed) resolveSurge(false, 'held too long');
    if ((missedNotes || skippedSurge) && run.combo > 0) {
      run = { ...run, combo: 0 };
      floatText(seedX, seedY - unit * 0.6, '…', 0);
      setHud();
    }
  }
  const d = music.beatDur;
  const callStart = phraseWindowStart(idx);
  const respStart = callStart + 4 * d;
  const isSurge = isSurgePhrase(idx, run.tier);
  const pattern = isSurge ? { slots: [], notes: [] } : generatePattern(run.tier, rng);
  const slotTimes = pattern.slots.map((s) => respStart + s * d / 2);
  // Dot anchor points (fireflies pin them to branch tips).
  const dots = pattern.slots.map((s, i) => {
    if (modifier === 'fireflies' && leaves.length) {
      const b = leaves[(Math.random() * leaves.length) | 0];
      return { slot: s, note: pattern.notes[i], fx: b.x1, fy: b.y1, firefly: true };
    }
    return { slot: s, note: pattern.notes[i], firefly: false };
  });
  phrase = {
    idx, pattern, isSurge, callStart, respStart,
    respEnd: respStart + 4 * d, slotTimes, dots,
    hit: pattern.slots.map(() => false),
    resolved: false, pressed: false,
  };
  // Schedule the call audio.
  const now = music.now();
  if (isSurge) {
    music.swellAt(Math.max(now + 0.02, callStart), 3.5 * d);
  } else {
    pattern.slots.forEach((s, i) => {
      music.pluckAt(Math.max(now + 0.02, callStart + s * d / 2), pattern.notes[i], false, 0.8);
    });
  }
}

function curHue() { return (baseHue + run.tier * 12) % 360; }

// ---------- flow ----------
function startRun() {
  run = newRunState();
  const seedStr = runMode === 'daily' ? utcDateString() : String((Math.random() * 1e9) | 0);
  rng = makeRng(runMode === 'daily' ? hashSeed('fb:' + seedStr) : hashSeed('fb:' + seedStr));
  modifier = modifierForTier(0);
  music.start();
  music.setTempo(tierTempo(0));
  const now = music.now();
  resetTree(now);
  oldTree = null;
  parts.length = 0;
  phrase = null;
  hold = null;
  baseHue = 190 + Math.random() * 120;
  lastBeatNum = -1;
  mode = 'playing';
  ui.menu.classList.add('hidden');
  ui.over.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  setHint('listen to the call — echo it back');
  setHud();
}

function endRun() {
  mode = 'gameover';
  if (hold) { hold.tone && hold.tone.end(false); hold = null; }
  music.stop();
  setHint('');
  ui.hud.classList.add('hidden');
  ui.finalScore.textContent = run.score.toLocaleString();
  ui.finalStats.textContent =
    `best combo ${run.bestCombo}×  ·  tier ${run.tier + 1}  ·  ${runMode === 'daily' ? 'daily bloom' : 'endless'}`;
  ui.submit.disabled = false;
  ui.submit.textContent = 'submit score';
  ui.board.innerHTML = '';
  ui.boardTitle.textContent = '';
  ui.name.value = localStorage.getItem('fb_name') || '';
  setTimeout(() => ui.over.classList.remove('hidden'), 600);
  const best = +(localStorage.getItem('fb_best') || 0);
  if (run.score > best) localStorage.setItem('fb_best', String(run.score));
}

function processEvents(events, judgment, tapX, tapY) {
  const hue = curHue();
  for (const ev of events) {
    if (ev === 'grow') {
      growGeneration(music.now(), tapX !== undefined ? (tapX - seedX) / (W / 2) : 0);
      sparkBurst(seedX, seedY, hue, judgment === 'perfect' ? 22 : 10, judgment === 'perfect' ? 160 : 90);
      popCombo();
      if (judgment === 'perfect') beatFlash = Math.max(beatFlash, 1);
    } else if (ev === 'bloom') {
      music.bloomChord();
      petalsFromTips(60, hue);
      floatText(seedX, seedY - unit * 1.2, 'bloom', hue);
      baseHue = (baseHue + 26) % 360;
    } else if (ev === 'seed') {
      petalsFromTips(140, hue);
      sparkBurst(seedX, seedY - unit * 0.8, hue, 60, 220);
      oldTree = { branches, fadeStart: music.now() };
      resetTree(music.now());
      music.setTempo(tierTempo(run.tier));
      modifier = modifierForTier(run.tier);
      const modText = { wind: 'the wind rises', night: 'night falls — play by ear', fireflies: 'fireflies' }[modifier];
      floatText(seedX, seedY - unit, 'seed · tier ' + (run.tier + 1), hue);
      if (modText) setTimeout(() => floatText(seedX, seedY - unit * 1.4, modText, hue), 700);
    } else if (ev === 'wither') {
      music.missThud();
      witherSome();
      shake = 1;
    } else if (ev === 'gameover') {
      endRun();
    }
  }
}

function resolveSurge(ok, failText) {
  if (!phrase || phrase.resolved) return;
  phrase.resolved = true;
  if (hold) { hold.tone && hold.tone.end(ok); }
  const pressJ = hold ? hold.pressJ : 'miss';
  hold = null;
  if (ok) {
    let res = applyTap(run, pressJ);
    run = res.state;
    processEvents(res.events, pressJ, seedX, seedY);
    if (mode !== 'playing') return;
    res = applyTap(run, 'perfect');
    run = res.state;
    run = applySurgeBonus(run);
    processEvents(res.events, 'perfect', seedX, seedY);
    floatText(seedX, seedY - unit, 'surge!', curHue());
  } else {
    const res = applyTap(run, 'miss');
    run = res.state;
    floatText(seedX, seedY - unit * 0.5, failText || 'surge lost', 0);
    processEvents(res.events, 'miss');
  }
  setHud();
}

// ---------- input ----------
function onPress(px, py) {
  if (mode === 'menu') { startRun(); return; }
  if (mode !== 'playing' || !phrase) return;
  const t = music.now();
  if (t - lastTapT < 0.12) return;
  lastTapT = t;
  const w = timingWindows(run.tier);
  const goodS = w.good / 1000;

  // Surge phrases: judge the press against the response downbeat.
  if (phrase.isSurge) {
    if (phrase.resolved || hold) return;
    if (t < phrase.respStart - goodS) { setHint('wait for it… hold on the beat'); return; }
    phrase.pressed = true;
    const j = judge(Math.abs(t - phrase.respStart) * 1000, w);
    if (j === 'miss') { resolveSurge(false, 'late'); return; }
    hold = { pressJ: j, tone: music.startHoldTone() };
    setHint('hold… release on the pulse');
    return;
  }

  // Call bar: just listen.
  if (t < phrase.respStart - goodS) {
    setHint('listen…');
    return;
  }

  // Response bar: judge against the pattern.
  const { slot, judgment } = judgeResponseTap(t, phrase.slotTimes, phrase.hit, w);
  if (slot >= 0) {
    phrase.hit[slot] = true;
    // Fireflies: must tap near the lit tip (pointer input only).
    const dot = phrase.dots[slot];
    if (dot.firefly && px !== undefined) {
      const dx = tx(dot.fx) - px, dy = ty(dot.fy) - py;
      if (Math.hypot(dx, dy) > unit * 1.1) {
        phrase.hit[slot] = false;
        setHint('closer to the firefly…');
        return;
      }
    }
    setHint('');
    music.pluckAt(music.now(), dot.note, judgment === 'perfect');
    const res = applyTap(run, judgment);
    run = res.state;
    floatText(px ?? seedX, (py ?? seedY) - 30, judgment, judgment === 'perfect' ? curHue() : curHue() + 40);
    processEvents(res.events, judgment, px, py);
    if (mode === 'playing' && phrase && !phrase.isSurge && phrase.hit.every(Boolean)) {
      run = applyPatternBonus(run);
      floatText(seedX, seedY - unit * 0.9, 'echo!', curHue());
      petalsFromTips(16, curHue());
    }
    setHud();
  } else {
    // Off-pattern tap.
    const res = applyTap(run, 'miss');
    run = res.state;
    floatText(px ?? seedX, (py ?? seedY) - 30, 'off pattern', 0);
    processEvents(res.events, 'miss');
    setHud();
  }
}

function onRelease() {
  if (mode !== 'playing' || !phrase || !phrase.isSurge || !hold) return;
  const t = music.now();
  const target = phrase.respStart + 2 * music.beatDur;
  const j = judge(Math.abs(t - target) * 1000, timingWindows(run.tier));
  setHint('');
  resolveSurge(j !== 'miss', 'released off-beat');
}

document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, input, a, .ui-block')) return;
  onPress(e.clientX, e.clientY);
});
document.addEventListener('pointerup', () => onRelease());
document.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
    if (e.target === ui.name) return;
    e.preventDefault();
    onPress();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'Enter') onRelease();
});

ui.again.addEventListener('click', () => startRun());
ui.submit.addEventListener('click', async () => {
  const name = sanitizeName(ui.name.value) || 'anon';
  localStorage.setItem('fb_name', name);
  ui.submit.disabled = true;
  ui.submit.textContent = 'sending…';
  const ok = await submitScore(name, run.score, runMode === 'daily');
  ui.submit.textContent = ok ? 'submitted ✓' : 'saved locally';
  setBoardTabs(runMode === 'daily' ? 'daily' : 'all');
  renderBoard(ui.board, ui.boardTitle, name, currentBoard);
});
ui.name.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') { e.preventDefault(); ui.submit.click(); }
});

// mode select + board tabs
function setModeButtons() {
  ui.modeEndless.classList.toggle('sel', runMode === 'endless');
  ui.modeDaily.classList.toggle('sel', runMode === 'daily');
}
ui.modeEndless.addEventListener('click', () => { runMode = 'endless'; localStorage.setItem('fb_mode', runMode); setModeButtons(); });
ui.modeDaily.addEventListener('click', () => { runMode = 'daily'; localStorage.setItem('fb_mode', runMode); setModeButtons(); });
setModeButtons();

let currentBoard = 'all';
function setBoardTabs(which) {
  currentBoard = which;
  for (const [el, w] of [[ui.tabAll, 'all'], [ui.tabDaily, 'daily'], [ui.overTabAll, 'all'], [ui.overTabDaily, 'daily']]) {
    el.classList.toggle('sel', w === which);
  }
}
for (const [el, w] of [[ui.tabAll, 'all'], [ui.tabDaily, 'daily']]) {
  el.addEventListener('click', () => { setBoardTabs(w); renderBoard(ui.menuBoard, $('menu-board-title'), null, w); });
}
for (const [el, w] of [[ui.overTabAll, 'all'], [ui.overTabDaily, 'daily']]) {
  el.addEventListener('click', () => { setBoardTabs(w); renderBoard(ui.board, ui.boardTitle, null, w); });
}

const MUTE_KEY = 'fb_muted';
function applyMute() {
  const m = localStorage.getItem(MUTE_KEY) === '1';
  music.setMuted(m);
  ui.mute.textContent = m ? '♪ off' : '♪ on';
}
ui.mute.addEventListener('click', () => {
  localStorage.setItem(MUTE_KEY, localStorage.getItem(MUTE_KEY) === '1' ? '0' : '1');
  applyMute();
});
applyMute();

// ---------- leaderboard client ----------
async function fetchScores(board = 'all') {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 5000);
    const url = board === 'daily' ? '/api/leaderboard?board=daily' : '/api/leaderboard';
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error('bad status');
    const data = await r.json();
    if (!Array.isArray(data.scores)) throw new Error('bad payload');
    return { online: true, scores: data.scores };
  } catch {
    return { online: false, scores: localScores() };
  }
}
function localScores() {
  try { return JSON.parse(localStorage.getItem('fb_scores') || '[]'); } catch { return []; }
}
function saveLocal(name, score) {
  const s = localScores();
  s.push({ name, score });
  s.sort((a, b) => b.score - a.score);
  localStorage.setItem('fb_scores', JSON.stringify(s.slice(0, 20)));
}
async function submitScore(name, score, daily) {
  if (!validScore(score)) return false;
  saveLocal(name, score);
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score, board: daily ? 'daily' : 'all' }),
      signal: ctl.signal,
    });
    clearTimeout(to);
    return r.ok;
  } catch { return false; }
}
async function renderBoard(el, titleEl, highlightName, board = 'all') {
  const { online, scores } = await fetchScores(board);
  const label = board === 'daily' ? "today's blooms" : 'top blooms';
  titleEl.textContent = online ? label : label + ' (this device)';
  el.innerHTML = '';
  scores.slice(0, 10).forEach((s, i) => {
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.textContent = `${i + 1}. ${s.name}`;
    const sc = document.createElement('span');
    sc.textContent = Number(s.score).toLocaleString();
    li.append(nm, sc);
    if (highlightName && s.name === highlightName) li.classList.add('me');
    el.appendChild(li);
  });
  if (!scores.length) {
    const li = document.createElement('li');
    li.textContent = 'no scores yet — be the first';
    el.appendChild(li);
  }
}
renderBoard(ui.menuBoard, $('menu-board-title'), null, 'all');

// ---------- render ----------
let lastFrame = performance.now() / 1000;
function frame() {
  const nowP = performance.now() / 1000;
  const dt = Math.min(0.05, nowP - lastFrame);
  lastFrame = nowP;
  const t = music.ctx ? music.now() : nowP;

  // phrase engine tick
  if (mode === 'playing' && music.running && t >= music.anchor) {
    const idx = Math.floor((t - music.anchor) / (PHRASE_BEATS * music.beatDur));
    if (!phrase || idx > phrase.idx) setupPhrase(idx, t);
    const bn = Math.floor((t - music.anchor) / music.beatDur);
    if (bn !== lastBeatNum && bn >= 0) { lastBeatNum = bn; beatFlash = Math.max(beatFlash, 0.7); }
  }
  beatFlash = Math.max(0, beatFlash - dt * 2.4);
  shake = Math.max(0, shake - dt * 3);

  const hue = curHue();

  // background
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const g = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.75);
  g.addColorStop(0, `hsl(${hue}, 30%, ${7 + beatFlash * 2.5}%)`);
  g.addColorStop(1, 'hsl(240, 25%, 3%)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  if (shake > 0) ctx.translate((Math.random() - 0.5) * 6 * shake, (Math.random() - 0.5) * 6 * shake);

  ctx.globalCompositeOperation = 'lighter';

  // trees
  if (oldTree) {
    const f = 1 - Math.min(1, (t - oldTree.fadeStart) / 1.6);
    if (f <= 0) oldTree = null;
    else drawTree(oldTree.branches, t, hue, f * 0.6);
  }
  drawTree(branches, t, hue, 1);

  // sequencer (ring + dots + sweep)
  if (mode === 'playing' && music.running && phrase) drawSequencer(t, hue);

  // particles
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life += dt;
    if (p.life >= p.max) { parts.splice(i, 1); continue; }
    const k = 1 - p.life / p.max;
    if (p.kind === 'spark') {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.96; p.vy *= 0.96;
      ctx.fillStyle = `hsla(${p.hue}, 85%, 72%, ${k})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * k + 0.4, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === 'petal') {
      p.sway += dt * 3;
      p.x += (p.vx + Math.sin(p.sway) * 24) * dt;
      p.y += p.vy * dt;
      p.vy += 26 * dt;
      ctx.fillStyle = `hsla(${p.hue}, 75%, 78%, ${0.75 * k})`;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.size, p.size * 0.55, p.sway, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.kind === 'text') {
      p.y += p.vy * dt;
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `500 ${p.size}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = p.hue === 0 ? `hsla(0, 0%, 62%, ${k})` : `hsla(${p.hue}, 80%, 80%, ${k})`;
      ctx.fillText(p.text, p.x, p.y);
      ctx.globalCompositeOperation = 'lighter';
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  requestAnimationFrame(frame);
}

function drawSequencer(t, hue) {
  const d = music.beatDur;
  const inResp = t >= phrase.respStart;
  const night = modifier === 'night';
  // wind sways the whole sequencer
  let cx = seedX, cy = seedY;
  if (modifier === 'wind') {
    cx += Math.sin(t * 1.7) * unit * 0.22;
    cy += Math.sin(t * 1.1) * unit * 0.06;
  }
  const R = ringR * 2.6;

  // base ring
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `hsla(${hue}, 70%, 75%, ${night && inResp ? 0.1 : 0.3})`;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

  // center pulse
  ctx.lineWidth = 2;
  ctx.strokeStyle = `hsla(${hue}, 80%, 80%, ${0.35 + beatFlash * 0.55})`;
  ctx.beginPath(); ctx.arc(cx, cy, ringR * (1 + beatFlash * 0.25), 0, Math.PI * 2); ctx.stroke();

  // sweep hand: one revolution per bar
  const barPhase = (((t - music.anchor) / d) % 4 + 4) % 4 / 4;
  const sa = barPhase * Math.PI * 2 - Math.PI / 2;
  ctx.lineWidth = inResp ? 2 : 1;
  ctx.strokeStyle = `hsla(${hue}, 85%, 82%, ${night && inResp ? 0.25 : inResp ? 0.8 : 0.3})`;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(sa) * ringR * 1.15, cy + Math.sin(sa) * ringR * 1.15);
  ctx.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R);
  ctx.stroke();

  if (phrase.isSurge) {
    // charging arc from response downbeat to release beat
    const target = phrase.respStart + 2 * d;
    if (hold) {
      const prog = Math.min(1, Math.max(0, (t - phrase.respStart) / (2 * d)));
      ctx.lineWidth = 4;
      ctx.strokeStyle = `hsla(${hue}, 90%, 78%, 0.85)`;
      ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `hsla(${hue}, 90%, 75%, ${0.12 + 0.25 * prog})`;
      ctx.beginPath(); ctx.arc(cx, cy, ringR * (1 + prog * 1.6), 0, Math.PI * 2); ctx.fill();
    } else if (t < phrase.respStart) {
      const anticip = 1 - Math.min(1, (phrase.respStart - t) / (4 * d));
      ctx.fillStyle = `hsla(${hue}, 90%, 75%, ${0.06 + anticip * 0.14})`;
      ctx.beginPath(); ctx.arc(cx, cy, ringR * (1 + anticip * 0.8), 0, Math.PI * 2); ctx.fill();
    }
    if (!phrase.resolved && t >= target - 0.05 && t < target + 0.1 && hold) {
      ctx.strokeStyle = `hsla(${hue}, 95%, 85%, 0.9)`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.08, 0, Math.PI * 2); ctx.stroke();
    }
    return;
  }

  // pattern dots
  for (let i = 0; i < phrase.dots.length; i++) {
    const dot = phrase.dots[i];
    const hitDone = phrase.hit[i];
    let dx, dy;
    if (dot.firefly) { dx = tx(dot.fx); dy = ty(dot.fy); }
    else {
      const a = (dot.slot / 8) * Math.PI * 2 - Math.PI / 2;
      dx = cx + Math.cos(a) * R; dy = cy + Math.sin(a) * R;
    }
    const callT = phrase.callStart + dot.slot * d / 2;
    const justCalled = t >= callT && t < callT + 0.35 && t < phrase.respStart;
    let alpha = inResp ? 0.85 : 0.45;
    if (night && inResp) alpha = 0;               // play by ear
    if (hitDone) alpha *= 0.15;
    const size = (justCalled ? 7 : 4.5) + (hitDone ? -1 : 0);
    if (alpha > 0) {
      ctx.fillStyle = `hsla(${(hue + 30) % 360}, 90%, ${justCalled ? 85 : 72}%, ${alpha})`;
      ctx.beginPath(); ctx.arc(dx, dy, size, 0, Math.PI * 2); ctx.fill();
      if (dot.firefly && !hitDone) {
        ctx.strokeStyle = `hsla(${(hue + 30) % 360}, 90%, 80%, ${alpha * 0.4})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(dx, dy, 10 + Math.sin(t * 6 + i) * 2, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (justCalled) sparkBurst(dx, dy, hue + 30, 2, 40);
  }
}

function drawTree(list, t, hue, alpha) {
  for (const b of list) {
    if (b.witherT > b.wither) b.wither = Math.min(b.witherT, b.wither + 0.03);
    const p = Math.min(1, (t - b.bornAt) / 0.4);
    const ease = 1 - (1 - p) * (1 - p);
    const x0 = tx(b.x0), y0 = ty(b.y0);
    const x1 = tx(b.x0 + (b.x1 - b.x0) * ease), y1 = ty(b.y0 + (b.y1 - b.y0) * ease);
    const w = Math.max(0.5, 5.5 * Math.pow(0.76, b.depth));
    const h = (hue + b.hueOff + b.depth * 6) % 360;
    const sat = 65 * (1 - b.wither);
    const lit = 68 - b.wither * 30;
    const a = alpha * (0.85 - b.wither * 0.5);
    ctx.strokeStyle = `hsla(${h}, ${sat}%, ${lit}%, ${a * 0.16})`;
    ctx.lineWidth = w * 3;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = `hsla(${h}, ${sat}%, ${Math.min(88, lit + 12)}%, ${a})`;
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    if (ease >= 1 && b.depth >= 3 && b.wither < 0.5) {
      ctx.fillStyle = `hsla(${h}, 80%, 80%, ${a * 0.5})`;
      ctx.beginPath(); ctx.arc(x1, y1, w * 0.9, 0, Math.PI * 2); ctx.fill();
    }
  }
}

resetTree(0);
requestAnimationFrame(frame);

// Test/debug hook (harmless in production; used by automated crash tests).
window.__fb = {
  music,
  press: onPress,
  release: onRelease,
  run: () => run,
  mode: () => mode,
  phrase: () => phrase,
  runMode: () => runMode,
  modifier: () => modifier,
};
