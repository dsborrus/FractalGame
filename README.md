# Fractal Bloom ❋

A minimal rhythm game. Tap with the pulse — the fractal tree grows. Miss the beat — it withers.

## How to play

Music pulses at ~112 BPM. A ring contracts toward the seed; tap anywhere (or press Space) the moment it lands.

- **Perfect / Good taps** grow the tree a generation and build your combo.
- **Every 8-hit combo** triggers a *bloom*: petal burst, score bonus, one spark restored.
- **Off-beat taps** wither branches and cost one of your 3 sparks. Zero sparks ends the run.
- **Fill the tree** (9 generations) and it *seeds*: dissolves into petals and regrows at a higher tier — faster tempo, tighter timing, bigger multipliers.

Score = precision × combo × tiers. Not tapping is always safe — breathe, find the pulse.

## Stack

- Vanilla JS + Canvas, zero front-end dependencies
- Generative deep-house audio (WebAudio — kick, hats, sub bass, pads; the audio clock is the game clock)
- Vercel serverless API + Upstash Redis sorted set for the global leaderboard (graceful local fallback)

## Develop

```bash
npx serve .        # local play (leaderboard falls back to local scores)
npm test           # unit tests (node --test)
```

## Deploy

1. Push to GitHub, import into Vercel (no framework preset, no build step).
2. Add Upstash Redis (Vercel Marketplace → Upstash) — env vars `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_*`) are picked up automatically.
