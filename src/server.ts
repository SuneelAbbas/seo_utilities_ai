#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import muffetRouter from './routes/muffet.routes.js';
import citationRouter from './routes/citation.routes.js';
import orchestratorRouter from './routes/orchestrator.routes.js';
import { apiKeyAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';

const PORT = Number(process.env.PORT) || 3000;

// ─── Parse ALLOWED_ORIGINS ────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin: allowedOrigins.includes('*')
    ? '*'
    : allowedOrigins,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
};

// ─── Load-sensing adaptive rate limiter (Muffet-specific) ──────────
//
// Instead of a fixed 5-crawls/hour limit, we dynamically adjust based
// on how many requests the server is currently handling:
//
//   HIGH LOAD  → 5 requests/hour per IP (strict — server is busy)
//   LOW LOAD   → 30 requests/hour per IP (relaxed — server is idle)
//
// "High load" means 2+ concurrent muffet processes are active OR 3+
// unique IPs have hit the crawl endpoint in the last 60 seconds.

const MAX_CONCURRENT = 2;
const ACTIVE_WINDOW_MS = 60_000; // 1-minute sliding window

let activeCrawlRequests = 0;
const recentRequestTimestamps: number[] = [];

/**
 * Check whether the server is currently under high load.
 * - 2+ concurrent crawls running → busy
 * - 3+ unique requests in the last 60 seconds → busy
 */
function isServerBusy(): boolean {
  // Prune timestamps older than the window
  const now = Date.now();
  while (recentRequestTimestamps.length > 0 && recentRequestTimestamps[0]! < now - ACTIVE_WINDOW_MS) {
    recentRequestTimestamps.shift();
  }
  return activeCrawlRequests >= MAX_CONCURRENT || recentRequestTimestamps.length >= 3;
}

/**
 * Middleware that tracks in-flight crawl requests.
 * Must be mounted BEFORE the rate limiter so the counter is accurate.
 */
function trackActiveRequests(_req: express.Request, _res: express.Response, next: express.NextFunction): void {
  activeCrawlRequests++;
  const timestamp = Date.now();
  recentRequestTimestamps.push(timestamp);

  _res.on('finish', () => {
    activeCrawlRequests = Math.max(0, activeCrawlRequests - 1);
  });

  next();
}

// ─── Dynamic rate limiter ─────────────────────────────────────────
const crawlLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour sliding window
  max: (_req) => {
    return isServerBusy() ? 5 : 30;
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
  message: (_req: express.Request) => {
    const limit = isServerBusy() ? 5 : 30;
    const reason = isServerBusy()
      ? `Server is currently busy (${activeCrawlRequests} active crawl(s)).`
      : `Rate limit reached.`;
    return {
      success: false,
      error: `Too many requests. ${reason} Current limit is ${limit} crawls per hour per IP address.`,
      activeCrawls: activeCrawlRequests,
      currentLimit: limit,
    };
  },
});

// ─── App setup ────────────────────────────────────────────────────────
const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

// ─── Health check (no auth required) ─────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Muffet routes (auth + rate limit + load tracking required) ─────
app.use('/api/muffet', apiKeyAuth, trackActiveRequests, crawlLimiter, muffetRouter);

// ─── Citation routes (auth required, no rate limit on AI calls) ─────
app.use('/api/citation', apiKeyAuth, citationRouter);

// ─── Orchestrator routes (auth required + load tracking) ────────────
app.use('/api/orchestrator', apiKeyAuth, trackActiveRequests, crawlLimiter, orchestratorRouter);

// ─── Error handler (must be last) ────────────────────────────────────
app.use(errorHandler);

// ─── Start server ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  🚀  SEO Utilities API');
  console.log('  ──────────────────────');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Health:  GET  http://localhost:${PORT}/api/health`);
  console.log('');
  console.log('  ── Muffet Crawler ──');
  console.log(`  Crawl:   POST http://localhost:${PORT}/api/muffet/crawl`);
  console.log(`  Stream:  GET  http://localhost:${PORT}/api/muffet/stream?url=<encoded-url>`);
  console.log('');
  console.log('  ── Smart Crawl Orchestrator ──');
  console.log(`  Crawl:   POST http://localhost:${PORT}/api/orchestrator/crawl`);
  console.log(`  Stream:  GET  http://localhost:${PORT}/api/orchestrator/stream?url=<encoded-url>`);
  console.log(`  Stats:   GET  http://localhost:${PORT}/api/orchestrator/stats`);
  console.log('');
  console.log('  ── AI Citation Tracker ──');
  console.log(`  Check:   POST http://localhost:${PORT}/api/citation/check`);
  console.log('');
});

export default app;
