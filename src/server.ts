#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import muffetRouter from './routes/muffet.routes.js';
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

// ─── Generic abuse-prevention rate limiter (NOT for crawl queuing) ──
// This is just a safety net — 100 req/min per IP — to prevent basic
// abuse/DoS. It is NOT responsible for crawl concurrency management.
// Crawl concurrency is handled by PQueue in the route handler itself,
// which queues (not rejects) every valid request.
const abuseLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,            // 100 requests per minute per IP — generous safety net
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
  message: {
    success: false,
    error: 'Too many requests. Please slow down.',
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

// ─── Muffet routes (auth + abuse prevention, queue-based concurrency) ─
// Concurrency is managed by PQueue inside muffet.routes.ts — no 429 rejection.
app.use('/api/muffet', apiKeyAuth, abuseLimiter, muffetRouter);

// ─── Orchestrator routes (auth + abuse prevention, queue-based) ─────
// Concurrency is managed by PQueue inside the orchestrator route.
app.use('/api/orchestrator', apiKeyAuth, abuseLimiter, orchestratorRouter);

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
});

export default app;
