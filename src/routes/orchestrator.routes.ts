/**
 * orchestrator.routes.ts — Express router for the Smart Crawl Orchestrator.
 *
 * All orchestrator crawl requests are routed through the same adaptive PQueue
 * as muffet crawls, sharing a single concurrency pool (base 5 / boost 10).
 *
 * Endpoints:
 *   POST /api/orchestrator/crawl   → Trigger smart crawl (returns JSON)
 *   GET  /api/orchestrator/stream   → SSE progress stream (real-time updates)
 */

import { Router, type Request, type Response } from 'express';
import { SmartCrawlOrchestrator, type OrchestratorProgress } from '../core/SmartCrawlOrchestrator.js';
import { crawlQueue, recordCrawlRequest } from './muffet.routes.js';

const router = Router();

// ─── AbortController store for SSE clients ────────────────────────────
// Maps a unique request ID to its AbortController so the SSE stream can
// cancel the crawl when the client disconnects.
const activeControllers = new Map<string, AbortController>();

// ─── POST /crawl — Trigger smart crawl (queued) ──────────────────────
interface CrawlBody {
  url?: string;
}

router.post('/crawl', async (req: Request, res: Response) => {
  const { url } = req.body as CrawlBody;

  // Validate URL
  if (!url || typeof url !== 'string') {
    res.status(400).json({
      success: false,
      error: 'Missing or invalid "url" in request body.',
    });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http/https URLs are supported');
    }
  } catch {
    res.status(400).json({
      success: false,
      error: 'Invalid URL format. Must be a valid http/https URL.',
    });
    return;
  }

  // ── Record for adaptive concurrency ──────────────────────────────
  recordCrawlRequest();

  // ── Queue the orchestrator crawl (shares pool with muffet) ───────
  const requestId = `orchestrator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const abortController = new AbortController();
  activeControllers.set(requestId, abortController);

  try {
    const result = await crawlQueue.add(async () => {
      const orchestrator = new SmartCrawlOrchestrator();
      return orchestrator.crawl({
        url: parsed.toString(),
        signal: abortController.signal,
        onProgress: (_progress: OrchestratorProgress) => {
          // Progress is handled via SSE stream — noop for POST response
        },
      });
    });

    res.json(result);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      success: false,
      error: `Orchestrator error: ${errMsg}`,
    });
  } finally {
    activeControllers.delete(requestId);
  }
});

// ─── GET /stream — SSE progress stream (queued) ──────────────────────
interface StreamQuery {
  url?: string;
}

router.get('/stream', (req: Request, res: Response) => {
  const { url } = req.query as StreamQuery;

  // Validate URL
  if (!url || typeof url !== 'string') {
    res.status(400).json({
      success: false,
      error: 'Missing or invalid "url" query parameter.',
    });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http/https URLs are supported');
    }
  } catch {
    res.status(400).json({
      success: false,
      error: 'Invalid URL format. Must be a valid http/https URL.',
    });
    return;
  }

  // ── Record for adaptive concurrency ──────────────────────────────
  recordCrawlRequest();

  // ── SSE setup ────────────────────────────────────────────────────
  const requestId = `orchestrator-sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const abortController = new AbortController();
  activeControllers.set(requestId, abortController);

  // Cancellation flag — if client disconnects while waiting in queue,
  // the task becomes a fast no-op instead of starting a wasted crawl.
  let cancelled = false;

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send SSE comment to confirm connection
  res.write(':ok\n\n');

  // Handle client disconnect — abort running crawl, cancel queued task
  req.on('close', () => {
    cancelled = true;
    abortController.abort();
    activeControllers.delete(requestId);
  });

  // ── Queue the orchestrator crawl with SSE progress ───────────────
  crawlQueue
    .add(async () => {
      // If client disconnected while waiting in queue, skip
      if (cancelled) return;

      const orchestrator = new SmartCrawlOrchestrator();

      return orchestrator.crawl({
        url: parsed.toString(),
        signal: abortController.signal,
        onProgress: (progress: OrchestratorProgress) => {
          if (!res.writableEnded && !cancelled) {
            const data = JSON.stringify(progress);
            res.write(`event: progress\ndata: ${data}\n\n`);
          }
        },
      });
    })
    .then((finalResult) => {
      if (!res.writableEnded && !cancelled) {
        // Send final result as a separate event
        const data = JSON.stringify(finalResult);
        res.write(`event: complete\ndata: ${data}\n\n`);
        res.end();
      }
    })
    .catch((err) => {
      if (!res.writableEnded && !cancelled) {
        const errorPayload = JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        res.write(`event: error\ndata: ${errorPayload}\n\n`);
        res.end();
      }
    })
    .finally(() => {
      activeControllers.delete(requestId);
    });
});

// ─── GET /stats — Orchestrator cache stats ───────────────────────────
import { protectionCache } from '../core/ProtectionCache.js';

router.get('/stats', (_req: Request, res: Response) => {
  const stats = protectionCache.getStats();
  res.json({
    success: true,
    cache: stats,
  });
});

export default router;
