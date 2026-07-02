// api/leaderboard.js — Vercel serverless function backed by Upstash Redis.
// Boards: all-time ("all") and daily ("daily", keyed by server UTC date).
import { Redis } from '@upstash/redis';
import { sanitizeName, validScore } from './_validate.js';

const KEY_ALL = 'fractalbloom:leaderboard';
const DAILY_TTL = 60 * 60 * 24 * 60; // keep daily boards for 60 days

function dailyKey() {
  return 'fractalbloom:daily:' + new Date().toISOString().slice(0, 10);
}

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function topScores(redis, key) {
  const raw = await redis.zrange(key, 0, 19, { rev: true, withScores: true });
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
      const board = req.query && req.query.board === 'daily' ? 'daily' : 'all';
      const key = board === 'daily' ? dailyKey() : KEY_ALL;
      return res.status(200).json({ board, scores: await topScores(redis, key) });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
      const name = sanitizeName(body.name) || 'anon';
      const score = Number(body.score);
      if (!validScore(score)) return res.status(400).json({ error: 'invalid score' });
      const daily = body.board === 'daily';
      // Keep each player's best score only (GT = only raise).
      await redis.zadd(KEY_ALL, { gt: true }, { score, member: name });
      if (daily) {
        const dk = dailyKey();
        await redis.zadd(dk, { gt: true }, { score, member: name });
        await redis.expire(dk, DAILY_TTL);
      }
      const key = daily ? dailyKey() : KEY_ALL;
      return res.status(200).json({ ok: true, scores: await topScores(redis, key) });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('leaderboard error:', err);
    return res.status(500).json({ error: 'server error' });
  }
}
