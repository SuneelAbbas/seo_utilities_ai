import { Router, type Request, type Response } from 'express';
import PQueue from 'p-queue';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import {
  type MuffetResult,
  MuffetCrawler,
  buildAssetExcludePattern,
  filterPageRoutes,
} from '../core/MuffetCrawler.js';

// ─── Router ──────────────────────────────────────────────────────────

const router = Router();

// ═════════════════════════════════════════════════════════════════════
//  CONFIGURATION (from environment)
// ═════════════════════════════════════════════════════════════════════

/**
 * Max muffet processes running in parallel (1–50).
 * env: MUFFET_MAX_CONCURRENCY  (default: 5)
 */
const MUFFET_QUEUE_CONCURRENCY = Math.max(
  1,
  Math.min(50, Number(process.env.MUFFET_MAX_CONCURRENCY) || 5)
);

/**
 * Max number of queued (waiting) requests before we return 503.
 * This is a safety valve for extreme bursts (e.g. 1000 req/s).
 * env: MUFFET_MAX_QUEUE_SIZE  (default: 200)
 *
 * With MUFFET_MAX_CONCURRENCY=5 and each crawl taking ~5s average,
 * 200 queue slots = ~200s of backlog = ~40 crawls/minute throughput.
 * On StackHost's 512MB RAM this prevents unbounded memory growth.
 */
const MUFFET_MAX_QUEUE_SIZE = Math.max(
  10,
  Math.min(1000, Number(process.env.MUFFET_MAX_QUEUE_SIZE) || 200)
);

// ═════════════════════════════════════════════════════════════════════
//  PQUEUE — FIFO crawl queue
// ═════════════════════════════════════════════════════════════════════

const crawlQueue = new PQueue({
  concurrency: MUFFET_QUEUE_CONCURRENCY,
  autoStart: true,
});

// Track currently active (actually processing, not queued) crawls
let activeProcessing = 0;

function getQueueStats() {
  return {
    queueLength: crawlQueue.size,
    pendingCount: crawlQueue.pending,
    activeProcessing,
    maxConcurrency: MUFFET_QUEUE_CONCURRENCY,
    maxQueueSize: MUFFET_MAX_QUEUE_SIZE,
  };
}

// ═════════════════════════════════════════════════════════════════════
//  JOB TRACKER — live SSE queue-position updates
// ═════════════════════════════════════════════════════════════════════

interface JobInfo {
  jobId: string;
  url: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  position: number;
  createdAt: number;
  /** EventEmitter for streaming position updates to SSE clients */
  emitter: EventEmitter;
}

/**
 * In-memory job registry. Each submitted crawl gets a unique jobId and
 * an EventEmitter. As the queue processes, position updates are emitted
 * so SSE clients get live queue-position streaming.
 *
 * The Map preserves insertion order, which matches PQueue's FIFO order
 * (since we add jobs in sequence).
 */
const jobs = new Map<string, JobInfo>();

/** Clean up completed/failed jobs older than 10 minutes */
const JOB_TTL_MS = 10 * 60 * 1000;

// Periodically purge stale jobs to prevent memory leaks
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (
      (job.status === 'completed' || job.status === 'failed') &&
      job.createdAt < cutoff
    ) {
      job.emitter.removeAllListeners();
      jobs.delete(id);
    }
  }
}, 60_000);

/**
 * Calculate the current queue position of a queued job based on
 * insertion order (all queued jobs before it in the Map).
 */
function recalculatePosition(jobId: string): number {
  let pos = 1;
  for (const [id, job] of jobs) {
    if (id === jobId) return pos;
    if (job.status === 'queued') pos++;
  }
  return pos;
}

/**
 * Notify all queued jobs of their updated position. Called whenever
 * a job completes/fails (which moves everyone behind it forward).
 */
function broadcastPositionUpdates() {
  let pos = 1;
  for (const [, job] of jobs) {
    if (job.status === 'queued') {
      const oldPos = job.position;
      job.position = pos;
      if (oldPos !== pos) {
        job.emitter.emit('position', {
          status: 'queued',
          position: pos,
          updatedAt: Date.now(),
        });
      }
      pos++;
    }
  }
}

// ─── URL validation ──────────────────────────────────────────────────

function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── Verbose output parser ───────────────────────────────────────────

function parseVerboseOutput(lines: string[]): MuffetResult[] {
  const results: MuffetResult[] = [];
  for (const line of lines) {
    if (line.startsWith('\t')) {
      const trimmed = line.trim();
      const parts = trimmed.split('\t');
      if (parts.length >= 2) {
        const statusStr = parts[0]!;
        const url = parts[1]!;
        const status = parseInt(statusStr, 10);
        if (!isNaN(status) && url) {
          results.push({ url, status });
        }
      }
    }
  }
  return results;
}

// ═════════════════════════════════════════════════════════════════════
//  GET /api/muffet/queue/:jobId  (SSE — live queue-position tracking)
// ═════════════════════════════════════════════════════════════════════
//
// Clients receive real-time SSE events as their queued position changes.
// Useful when the queue is long — the client can show a live countdown.
//
// Events:
//   - { type: "connected", jobId, status, position, ... }
//   - { type: "position",  status, position, updatedAt }
//   - { type: "started",   status: "processing" }
//   - { type: "completed", status: "completed"|"failed" }
//   - { type: "error",     message }

router.get('/queue/:jobId', (req: Request, res: Response) => {
  const jobId = req.params.jobId as string;

  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({
      success: false,
      error: `Job ${jobId} not found. It may have already been purged (jobs kept for 10 min).`,
    });
    return;
  }

  // ── SSE setup ──────────────────────────────────────────────────
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);

  let aborted = false;

  const cleanup = () => {
    aborted = true;
    job.emitter.removeListener('position', onPosition);
    job.emitter.removeListener('started', onStarted);
    job.emitter.removeListener('completed', onCompleted);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);

  const sendSSE = (type: string, data: Record<string, unknown>) => {
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    }
  };

  // ── Send initial connection event ──────────────────────────────
  sendSSE('connected', {
    jobId,
    status: job.status,
    position: job.position,
    url: job.url,
    queueStats: getQueueStats(),
    message:
      job.status === 'queued'
        ? `You are #${job.position} in the queue. Waiting for ${job.position - 1} request(s) ahead.`
        : job.status === 'processing'
          ? 'Your crawl is now processing.'
          : job.status === 'completed'
            ? 'Your crawl has completed.'
            : 'Your crawl has failed.',
  });

  // ── Attach listeners for live updates ──────────────────────────
  const onPosition = (data: { status: string; position: number; updatedAt: number }) => {
    sendSSE('position', data);
  };

  const onStarted = () => {
    sendSSE('started', { status: 'processing', position: 0 });
  };

  const onCompleted = (data: { status: string }) => {
    sendSSE('completed', data);
    // After sending the final event, close the connection
    setTimeout(() => {
      if (!aborted) {
        res.end();
        cleanup();
      }
    }, 100);
  };

  job.emitter.on('position', onPosition);
  job.emitter.on('started', onStarted);
  job.emitter.on('completed', onCompleted);

  // If job is already completed/failed by the time the client subscribes,
  // send the terminal event immediately
  if (job.status === 'completed') {
    sendSSE('completed', { status: 'completed' });
    setTimeout(() => { if (!aborted) { res.end(); cleanup(); } }, 100);
  } else if (job.status === 'failed') {
    sendSSE('completed', { status: 'failed' });
    setTimeout(() => { if (!aborted) { res.end(); cleanup(); } }, 100);
  }
});

// ═════════════════════════════════════════════════════════════════════
//  GET /api/muffet/stream (SSE — real-time crawl progress via spawn)
// ═════════════════════════════════════════════════════════════════════
// Note: This is the old SSE endpoint for live muffet output. It spawns
// muffet directly (bypasses queue) for real-time streaming use cases.

router.get('/stream', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string | undefined;
    const internalOnly = req.query.internalOnly !== 'false';
    const excludeAssets = req.query.excludeAssets !== 'false';

    if (!url || typeof url !== 'string') {
      res.status(400).json({ success: false, error: 'Missing "url" query parameter' });
      return;
    }

    if (!isValidUrl(url)) {
      res.status(400).json({ success: false, error: 'Invalid URL format. URL must start with http:// or https://.' });
      return;
    }

    activeProcessing++;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);

    let aborted = false;

    function cleanup() {
      if (aborted) return;
      aborted = true;
      if (child && !child.killed) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      activeProcessing = Math.max(0, activeProcessing - 1);
    }

    req.on('close', cleanup);
    req.on('error', cleanup);

    function sendSSE(type: string, data: Record<string, unknown>) {
      if (!aborted) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    }

    const startTime = Date.now();
    sendSSE('start', {
      url,
      queueStats: getQueueStats(),
      message: 'Muffet crawl started',
      timestamp: startTime,
    });

    const hostname = new URL(url).hostname;
    const excludePattern = excludeAssets ? buildAssetExcludePattern() : undefined;

    console.log('');
    console.log('══════════════════════════════════════════════════════');
    console.log('[MUFFET-SSE] URL:', url);
    console.log('[MUFFET-SSE] excludeAssets:', excludeAssets);
    console.log('[MUFFET-SSE] excludePattern:', excludePattern ?? '(none — no --exclude flag)');
    console.log('══════════════════════════════════════════════════════');
    console.log('');

    const child = MuffetCrawler.spawnStream(url, undefined, undefined, undefined, excludePattern);
    const stdoutLines: string[] = [];
    let urlsChecked = 0;
    let currentUrl = '';
    let lineBuffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = lineBuffer + chunk.toString();
      const lines = text.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        stdoutLines.push(line);

        if (line.startsWith('\t')) {
          const parts = trimmed.split('\t');
          if (parts.length >= 2) {
            const statusStr = parts[0]!;
            const linkedUrl = parts[1]!;
            const status = parseInt(statusStr, 10);
            if (!isNaN(status) && linkedUrl) {
              sendSSE('result', { url: linkedUrl, status, urlsChecked });
            }
          }
        } else {
          urlsChecked++;
          currentUrl = trimmed;
          sendSSE('progress', {
            url: currentUrl,
            urlsChecked,
            elapsedSec: Number(((Date.now() - startTime) / 1000).toFixed(2)),
          });
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      text.split('\n').filter(l => l.trim()).forEach(line => {
        console.error(`[muffet stderr] ${line.trim()}`);
      });
    });

    child.on('close', (exitCode) => {
      if (aborted) return;

      if (lineBuffer) {
        const trimmed = lineBuffer.trim();
        if (trimmed) {
          stdoutLines.push(lineBuffer);
          if (lineBuffer.startsWith('\t')) {
            const parts = trimmed.split('\t');
            if (parts.length >= 2) {
              const status = parseInt(parts[0]!, 10);
              if (!isNaN(status) && parts[1]!) {
                sendSSE('result', { url: parts[1]!, status, urlsChecked });
              }
            }
          } else {
            urlsChecked++;
            currentUrl = trimmed;
          }
        }
      }

      let results = parseVerboseOutput(stdoutLines);
      const elapsedSec = Number(((Date.now() - startTime) / 1000).toFixed(2));

      if (results.length > 0) {
        if (internalOnly) {
          results = results.filter((r) => {
            try {
              return new URL(r.url).hostname === hostname;
            } catch {
              return false;
            }
          });
        }
        if (excludeAssets) {
          results = filterPageRoutes(results);
        }
      }

      const hasResults = results.length > 0;
      const success = hasResults;

      if (!hasResults) {
        console.error(
          `[muffet] No results parsed. exitCode=${exitCode}, stdoutLines=${stdoutLines.length}`
        );
        const samples = stdoutLines.slice(0, 5).map(l => JSON.stringify(l));
        console.error(`[muffet] Sample stdout lines: ${samples.join(', ')}`);
      }

      sendSSE('complete', {
        success,
        exitCode,
        totalPages: results.length,
        results,
        urlsChecked,
        elapsedSec,
        message: exitCode === 0
          ? 'Crawl completed successfully'
          : hasResults
            ? 'Crawl completed — some links returned errors'
            : 'Crawl failed — no results were parsed',
      });

      res.end();
      activeProcessing = Math.max(0, activeProcessing - 1);
    });

    child.on('error', (err: Error) => {
      if (aborted) return;
      sendSSE('error', {
        error: err.message,
        errorType: 'process_error',
      });
      res.end();
      activeProcessing = Math.max(0, activeProcessing - 1);
    });

  } catch (err) {
    activeProcessing = Math.max(0, activeProcessing - 1);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Internal server error during SSE setup' });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Internal server error' })}\n\n`);
      res.end();
    }
  }
});

// ═════════════════════════════════════════════════════════════════════
//  POST /api/muffet/crawl  (queue-based — NEVER returns 429)
// ═════════════════════════════════════════════════════════════════════
//
// Behavior:
//   1. Validate URL (400 if invalid)
//   2. Check queue capacity (503 if MUFFET_MAX_QUEUE_SIZE exceeded)
//   3. Create job entry with unique jobId
//   4. Return 202 Accepted with { status: "queued", jobId, position, ... }
//   5. Process in background via PQueue
//
// The client can use GET /api/muffet/queue/:jobId (SSE) to track their
// position live, or simply wait and check queue-status periodically.

router.post('/crawl', async (req: Request, res: Response) => {
  try {
    const { url, concurrency, internalOnly, excludeAssets } = req.body;

    // ── 1. Validate URL ──────────────────────────────────────────
    if (!url || typeof url !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid "url" field. Please provide a valid website URL starting with http:// or https://',
      });
      return;
    }

    if (!isValidUrl(url)) {
      res.status(400).json({
        success: false,
        error: 'Invalid URL format. URL must start with http:// or https:// and be a valid web address.',
      });
      return;
    }

    // ── 2. Check queue capacity (safety valve) ───────────────────
    //      Prevents unbounded memory growth on StackHost's 512MB RAM.
    const currentQueued = crawlQueue.size;
    if (currentQueued >= MUFFET_MAX_QUEUE_SIZE) {
      console.warn(
        `[MUFFET-QUEUE] ⛔ Queue full (${currentQueued}/${MUFFET_MAX_QUEUE_SIZE}). ` +
        `Rejecting crawl for ${url}`
      );
      res.status(503).json({
        status: 'rejected',
        error: 'Server at capacity. Please try again in a few minutes.',
        queueStats: getQueueStats(),
      });
      return;
    }

    // ── 3. Create job entry ──────────────────────────────────────
    const jobId = crypto.randomUUID();
    const emitter = new EventEmitter();

    const job: JobInfo = {
      jobId,
      url,
      status: 'queued',
      position: 0, // will be set after add
      createdAt: Date.now(),
      emitter,
    };

    // Calculate position: current queue depth + 1
    const queuePosition = crawlQueue.size + crawlQueue.pending + 1;
    job.position = queuePosition;

    jobs.set(jobId, job);

    console.log(
      `[MUFFET-QUEUE] 📥 Queued ${url} | jobId: ${jobId.slice(0, 8)}… | ` +
      `position: ${queuePosition} | queue: ${crawlQueue.size}/${MUFFET_MAX_QUEUE_SIZE}`
    );

    // ── 4. Send 202 Accepted immediately ─────────────────────────
    res.status(202).json({
      status: 'queued',
      jobId,
      queuePosition,
      message: `Request accepted and queued. Position: ${queuePosition}. Currently processing: ${activeProcessing}, waiting: ${crawlQueue.size}. Use GET /api/muffet/queue/${jobId} for live SSE position tracking.`,
      queueStats: getQueueStats(),
    });

    // ── 5. Queue the crawl in background ─────────────────────────
    crawlQueue.add(async () => {
      // ── Mark as processing ────────────────────────────────────
      job.status = 'processing';
      activeProcessing++;
      job.emitter.emit('started');

      try {
        const crawler = new MuffetCrawler();
        const result = await crawler.crawl({
          url,
          concurrency: typeof concurrency === 'number' && concurrency > 0 ? concurrency : undefined,
          internalOnly: internalOnly !== false,
          excludeAssets: excludeAssets !== false,
        });

        job.status = 'completed';
        console.log(
          `[MUFFET-QUEUE] ✅ Completed ${jobId.slice(0, 8)}… for ${url} | ` +
          `${result.totalPages} pages in ${result.durationSec}s | ` +
          `Queue: ${crawlQueue.size} waiting, ${activeProcessing - 1} processing`
        );
      } catch (err) {
        job.status = 'failed';
        console.error(`[MUFFET-QUEUE] ❌ Failed ${jobId.slice(0, 8)}… for ${url}:`, err);
      } finally {
        activeProcessing = Math.max(0, activeProcessing - 1);
        job.emitter.emit('completed', { status: job.status });
        // Remove listeners to allow GC
        setTimeout(() => job.emitter.removeAllListeners(), 1000);
        // Broadcast new positions to remaining queued jobs
        broadcastPositionUpdates();
      }
    });

  } catch (err) {
    console.error('Muffet queue error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        engine: 'muffet',
        totalPages: 0,
        results: [],
        error: err instanceof Error ? err.message : 'Internal server error',
        errorType: 'process_error',
      });
    }
  }
});

// ═════════════════════════════════════════════════════════════════════
//  GET /api/muffet/queue-status  (poll-based queue monitoring)
// ═════════════════════════════════════════════════════════════════════

router.get('/queue-status', (_req: Request, res: Response) => {
  res.json({
    success: true,
    ...getQueueStats(),
  });
});

export default router;
