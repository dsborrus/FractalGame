// api/leaderboard.js — Vercel serverless function backed by Upstash Redis.
import { Redis } from '@upstash/redis';
import { sanitizeName, validScore } from './_validate.js';

const KEY = 'fractalbloom:leaderboard';

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function topScores(redis) {
  const raw = await redis.zrange(KEY, 0, 19, { rev: true, withScores: true });
  const scores = [];
  if (Array.isArray(raw)) {
    if (raw.length && typeof raw[0] === 'object' && raw[0] !== null && 'member' in raw[0]) {
      for (const e of raw) scores.push({ name: String(e.member), score: Number(e.score) });
    } else {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        scores.push({ name: String(raw[i]), score: Number(raw[i + 1]) });
      }
    }
  }
  return scores;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'leaderboard not configured' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ scores: await topScores(redis) });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
      const name = sanitizeName(body.name) || 'anon';
      const score = Number(body.score);
      if (!validScore(score)) return res.status(400).json({ error: 'invalid score' });
      // Keep each player's best score only.
      await redis.zadd(KEY, { gt: true }, { score, member: name });
      return res.status(200).json({ ok: true, scores: await topScores(redis) });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('leaderboard error:', err);
    return res.status(500).json({ error: 'server error' });
  }
}
