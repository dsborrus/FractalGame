// api.test.mjs — exercises api/leaderboard.js against a fake Upstash REST server.
// Run: node tests/api.test.mjs   (requires npm install)
import assert from 'node:assert/strict';

// ---- fake Upstash REST backend (multi-key) ----
const stores = new Map(); // key -> Map(member -> score)
const ttls = new Map();
const keyStore = (k) => { if (!stores.has(k)) stores.set(k, new Map()); return stores.get(k); };
function execCommand(cmd) {
  const op = String(cmd[0]).toUpperCase();
  if (op === 'ZADD') {
    // ["ZADD", key, "GT", score, member]
    const store = keyStore(String(cmd[1]));
    const flags = cmd.slice(2, -2).map((s) => String(s).toUpperCase());
    const score = Number(cmd[cmd.length - 2]);
    const member = String(cmd[cmd.length - 1]);
    const prev = store.get(member);
    if (flags.includes('GT') && prev !== undefined && prev >= score) return 0;
    store.set(member, score);
    return prev === undefined ? 1 : 0;
  }
  if (op === 'ZRANGE') {
    const store = keyStore(String(cmd[1]));
    const start = Number(cmd[2]), stop = Number(cmd[3]);
    const rev = cmd.map((s) => String(s).toUpperCase()).includes('REV');
    const withScores = cmd.map((s) => String(s).toUpperCase()).includes('WITHSCORES');
    let entries = [...store.entries()].sort((a, b) => rev ? b[1] - a[1] : a[1] - b[1]);
    entries = entries.slice(start, stop + 1);
    const out = [];
    for (const [m, s] of entries) { out.push(m); if (withScores) out.push(String(s)); }
    return out;
  }
  if (op === 'EXPIRE') {
    ttls.set(String(cmd[1]), Number(cmd[2]));
    return 1;
  }
  throw new Error('fake upstash: unhandled command ' + op);
}

// The SDK requests base64-encoded responses (Upstash-Encoding: base64).
const enc = (v) => {
  if (typeof v === 'string') return Buffer.from(v).toString('base64');
  if (Array.isArray(v)) return v.map(enc);
  return v;
};
globalThis.fetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body || '[]');
  const useB64 = /base64/i.test(opts.headers?.['Upstash-Encoding'] || '');
  const run = (c) => (useB64 ? enc(execCommand(c)) : execCommand(c));
  const isPipeline = Array.isArray(body) && Array.isArray(body[0]);
  const payload = isPipeline
    ? body.map((c) => ({ result: run(c) }))
    : { result: run(body) };
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { default: handler } = await import('../api/leaderboard.js');

function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}
const call = async (method, body, query) => {
  const res = mockRes();
  await handler({ method, body, query: query || {} }, res);
  return res;
};

// empty leaderboard
let r = await call('GET');
assert.equal(r.statusCode, 200);
assert.deepEqual(r.body.scores, []);

// submit scores
r = await call('POST', { name: 'Daniel', score: 4200 });
assert.equal(r.statusCode, 200);
assert.equal(r.body.ok, true);
await call('POST', { name: 'Ada', score: 9000 });
await call('POST', { name: 'Grace', score: 100 });

// GT semantics: lower resubmission ignored, higher accepted
await call('POST', { name: 'Daniel', score: 50 });
await call('POST', { name: 'Grace', score: 7777 });

r = await call('GET');
assert.deepEqual(r.body.scores, [
  { name: 'Ada', score: 9000 },
  { name: 'Grace', score: 7777 },
  { name: 'Daniel', score: 4200 },
]);

// validation
r = await call('POST', { name: 'X', score: -5 });
assert.equal(r.statusCode, 400);
r = await call('POST', { name: 'X', score: 1.5 });
assert.equal(r.statusCode, 400);
r = await call('POST', { name: 'X', score: 99999999 });
assert.equal(r.statusCode, 400);
r = await call('POST', { name: '<script>x</script>', score: 10 });
assert.equal(r.statusCode, 200);
r = await call('GET');
assert.ok(r.body.scores.every((s) => !s.name.includes('<')), 'names sanitized');

// ---- daily board ----
const today = new Date().toISOString().slice(0, 10);
r = await call('POST', { name: 'DailyDan', score: 1234, board: 'daily' });
assert.equal(r.statusCode, 200);
assert.deepEqual(r.body.scores, [{ name: 'DailyDan', score: 1234 }], 'daily POST returns daily board');

r = await call('GET', null, { board: 'daily' });
assert.equal(r.body.board, 'daily');
assert.deepEqual(r.body.scores, [{ name: 'DailyDan', score: 1234 }]);
assert.ok(ttls.has('fractalbloom:daily:' + today), 'daily key gets a TTL');

// daily score also lands on the all-time board
r = await call('GET');
assert.ok(r.body.scores.some((s) => s.name === 'DailyDan'), 'daily score included in all-time');

// endless score does NOT land on the daily board
await call('POST', { name: 'EndlessEve', score: 5555 });
r = await call('GET', null, { board: 'daily' });
assert.ok(!r.body.scores.some((s) => s.name === 'EndlessEve'), 'endless score not on daily board');

// bad method
r = await call('DELETE');
assert.equal(r.statusCode, 405);

// unconfigured env -> 503
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
r = await call('GET');
assert.equal(r.statusCode, 503);

console.log('API TEST PASSED ✔  (GET/POST, GT best-score semantics, validation, sanitization, 405/503)');
