// game.js — Fractal Bloom: rendering, input, UI, leaderboard client.
import {
  MAX_DEPTH, MAX_SPARKS, BLOOM_EVERY,
  tierTempo, timingWindows, nearestBeatDelta, judge,
  applyTap, newRunState, sanitizeName, validScore,
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
  ringR = Math.max(20, unit * 0.16);
}
window.addEventListener('resize', resize);
resize();

// ---------- game state ----------
let mode = 'menu'; // menu | playing | gameover
let run = newRunState();
let baseHue = 210;
let lastTapT = -10;
let graceUntil = 0;
let beatFlash = 0;
let lastBeatNum = -1;
let shake = 0;

// ---------- tree (coords in tree-space: seed at origin, y up, trunk length 1) ----------
let branches = [];   // {x0,y0,x1,y1,depth,bornAt,wither,witherT,hueOff}
let leaves = [];
let oldTree = null;  // {branches, fadeStart}

function resetTree(now) {
  branches = []; leaves = [];
  const trunk = { x0: 0, y0: 0, x1: 0, y1: 1, depth: 0, bornAt: now, wither: 0, witherT: 0, hueOff: 0 };
  branches.push(trunk); leaves.push(trunk);
}

function growGeneration(now) {
  const next = [];
  for (const b of leaves) {
    const ang = Math.atan2(b.x1 - b.x0, b.y1 - b.y0); // 0 = straight up
    const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) * (0.7 + Math.random() * 0.06);
    for (const side of [-1, 1]) {
      const a = ang + side * (0.38 + Math.random() * 0.22);
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
  for (let i = 0; i < n; i++) {
    const b = leaves[(Math.random() * leaves.length) | 0];
    b.witherT = 1;
  }
}

const tx = (x) => seedX + x * unit;
const ty = (y) => seedY - y * unit;

// ---------- particles ----------
const parts = []; // {kind:'spark'|'petal'|'text', x,y,vx,vy,life,max,hue,size,text}
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
  ui.tier.textContent = run.tier > 0 ? 'tier ' + (run.tier + 1) : '';
  const dots = ui.sparks.children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('lost', i >= run.sparks);
}
function popCombo() {
  ui.combo.classList.remove('pop'); void ui.combo.offsetWidth; ui.combo.classList.add('pop');
}

// ---------- flow ----------
function startRun() {
  run = newRunState();
  music.start();
  music.setTempo(tierTempo(0));
  const now = music.now();
  resetTree(now);
  oldTree = null;
  parts.length = 0;
  baseHue = 190 + Math.random() * 120;
  graceUntil = music.anchor + 4 * music.beatDur;
  lastBeatNum = -1;
  mode = 'playing';
  ui.menu.classList.add('hidden');
  ui.over.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.hint.textContent = 'feel the pulse — tap on the beat';
  ui.hint.classList.remove('hidden');
  setHud();
}

function endRun() {
  mode = 'gameover';
  music.stop();
  ui.hud.classList.add('hidden');
  ui.finalScore.textContent = run.score.toLocaleString();
  ui.finalStats.textContent = `best combo ${run.bestCombo}×  ·  tier ${run.tier + 1}`;
  ui.submit.disabled = false;
  ui.submit.textContent = 'submit score';
  ui.board.innerHTML = '';
  ui.boardTitle.textContent = '';
  ui.name.value = localStorage.getItem('fb_name') || '';
  setTimeout(() => ui.over.classList.remove('hidden'), 600);
  const best = +(localStorage.getItem('fb_best') || 0);
  if (run.score > best) localStorage.setItem('fb_best', String(run.score));
}

function onTap(px, py) {
  if (mode === 'menu') { startRun(); return; }
  if (mode !== 'playing') return;
  const t = music.now();
  if (t - lastTapT < 0.18) return;
  lastTapT = t;
  if (t < graceUntil) return;
  ui.hint.classList.add('hidden');

  const delta = nearestBeatDelta(t, music.anchor, music.beatDur);
  const j = judge(Math.abs(delta) * 1000, timingWindows(run.tier));
  const res = applyTap(run, j);
  run = res.state;
  const hue = curHue();
  const tapX = px ?? seedX, tapY = py ?? seedY;

  for (const ev of res.events) {
    if (ev === 'grow') {
      growGeneration(t);
      music.pluck((run.combo - 1) % BLOOM_EVERY, j === 'perfect');
      sparkBurst(seedX, seedY, hue, j === 'perfect' ? 22 : 10, j === 'perfect' ? 160 : 90);
      floatText(tapX, tapY - 30, j === 'perfect' ? 'perfect' : 'good', j === 'perfect' ? hue : hue + 40);
      popCombo();
      if (j === 'perfect') beatFlash = Math.max(beatFlash, 1);
    } else if (ev === 'bloom') {
      music.bloomChord();
      petalsFromTips(60, hue);
      floatText(seedX, seedY - unit * 1.2, 'bloom', hue);
      baseHue = (baseHue + 26) % 360;
    } else if (ev === 'seed') {
      petalsFromTips(140, hue);
      sparkBurst(seedX, seedY - unit * 0.8, hue, 60, 220);
      oldTree = { branches, fadeStart: t };
      resetTree(t);
      music.setTempo(tierTempo(run.tier));
      floatText(seedX, seedY - unit, 'seed · tier ' + (run.tier + 1), hue);
    } else if (ev === 'wither') {
      music.missThud();
      witherSome();
      shake = 1;
      floatText(tapX, tapY - 30, 'off beat', 0);
    } else if (ev === 'gameover') {
      endRun();
    }
  }
  setHud();
}

function curHue() {
  return (baseHue + run.tier * 12) % 360;
}

// ---------- input ----------
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, input, a, .ui-block')) return;
  onTap(e.clientX, e.clientY);
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'Enter') {
    if (e.target === ui.name) return;
    e.preventDefault();
    onTap();
  }
});

ui.again.addEventListener('click', () => startRun());
ui.submit.addEventListener('click', async () => {
  const name = sanitizeName(ui.name.value) || 'anon';
  localStorage.setItem('fb_name', name);
  ui.submit.disabled = true;
  ui.submit.textContent = 'sending…';
  const ok = await submitScore(name, run.score);
  ui.submit.textContent = ok ? 'submitted ✓' : 'saved locally';
  renderBoard(ui.board, ui.boardTitle, name);
});
ui.name.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') { e.preventDefault(); ui.submit.click(); }
});

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
async function fetchScores() {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch('/api/leaderboard', { signal: ctl.signal });
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
async function submitScore(name, score) {
  if (!validScore(score)) return false;
  saveLocal(name, score);
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score }),
      signal: ctl.signal,
    });
    clearTimeout(to);
    return r.ok;
  } catch { return false; }
}
async function renderBoard(el, titleEl, highlightName) {
  const { online, scores } = await fetchScores();
  titleEl.textContent = online ? 'top blooms' : 'top blooms (this device)';
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
renderBoard(ui.menuBoard, $('menu-board-title'));

// ---------- render ----------
let lastFrame = performance.now() / 1000;
function frame() {
  const nowP = performance.now() / 1000;
  const dt = Math.min(0.05, nowP - lastFrame);
  lastFrame = nowP;
  const t = music.ctx ? music.now() : nowP;

  // beat pulse
  if (music.running) {
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

  if (shake > 0) {
    ctx.translate((Math.random() - 0.5) * 6 * shake, (Math.random() - 0.5) * 6 * shake);
  }

  ctx.globalCompositeOperation = 'lighter';

  // trees
  if (oldTree) {
    const f = 1 - Math.min(1, (t - oldTree.fadeStart) / 1.6);
    if (f <= 0) oldTree = null;
    else drawTree(oldTree.branches, t, hue, f * 0.6);
  }
  drawTree(branches, t, hue, 1);

  // pulse ring
  if (mode === 'playing' && music.running && t >= music.anchor) {
    const phase = ((t - music.anchor) / music.beatDur) % 1;
    const rMax = ringR * 3.2;
    const r = ringR + (rMax - ringR) * (1 - phase);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `hsla(${hue}, 70%, 75%, ${0.25 + 0.5 * phase})`;
    ctx.beginPath(); ctx.arc(seedX, seedY, r, 0, Math.PI * 2); ctx.stroke();
    // target ring
    ctx.lineWidth = 2;
    ctx.strokeStyle = `hsla(${hue}, 80%, 80%, ${0.5 + beatFlash * 0.5})`;
    ctx.beginPath(); ctx.arc(seedX, seedY, ringR, 0, Math.PI * 2); ctx.stroke();
    // beat flash fill
    if (beatFlash > 0) {
      ctx.fillStyle = `hsla(${hue}, 85%, 75%, ${beatFlash * 0.22})`;
      ctx.beginPath(); ctx.arc(seedX, seedY, ringR, 0, Math.PI * 2); ctx.fill();
    }
  }

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
      p.vy += 26 * dt; // gentle gravity after rise
      ctx.fillStyle = `hsla(${p.hue}, 75%, 78%, ${0.75 * k})`;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.size, p.size * 0.55, p.sway, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.kind === 'text') {
      p.y += p.vy * dt;
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `500 ${p.size}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = p.hue === 0
        ? `hsla(0, 0%, 62%, ${k})`
        : `hsla(${p.hue}, 80%, 80%, ${k})`;
      ctx.fillText(p.text, p.x, p.y);
      ctx.globalCompositeOperation = 'lighter';
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  requestAnimationFrame(frame);
}

function drawTree(list, t, hue, alpha) {
  for (const b of list) {
    // wither animation
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
    // halo pass
    ctx.strokeStyle = `hsla(${h}, ${sat}%, ${lit}%, ${a * 0.16})`;
    ctx.lineWidth = w * 3;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    // core pass
    ctx.strokeStyle = `hsla(${h}, ${sat}%, ${Math.min(88, lit + 12)}%, ${a})`;
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    // luminous tip
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
  tap: onTap,
  run: () => run,
  mode: () => mode,
  graceUntil: () => graceUntil,
};
