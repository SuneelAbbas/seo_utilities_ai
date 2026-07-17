/**
 * orchestrator.routes.ts — Express router for the Smart Crawl Orchestrator.
 *
 * Endpoints:
 *   POST /api/orchestrator/crawl   → Trigger smart crawl (returns JSON)
 *   GET  /api/orchestrator/stream   → SSE progress stream (real-time updates)
 */

import { Router, type Request, type Response } from 'express';
import { SmartCrawlOrchestrator, type OrchestratorProgress } from '../core/SmartCrawlOrchestrator.js';

const router = Router();

// ─── AbortController store for SSE clients ────────────────────────────
// Maps a unique request ID to its AbortController so the SSE stream can
// cancel the crawl when the client disconnects.
const activeControllers = new Map<string, AbortController>();

// ─── POST /crawl — Trigger smart crawl ────────────────────────────────
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

  const requestId = `orchestrator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const abortController = new AbortController();
  activeControllers.set(requestId, abortController);

  try {
    const orchestrator = new SmartCrawlOrchestrator();

    const result = await orchestrator.crawl({
      url: parsed.toString(),
      signal: abortController.signal,
      onProgress: (_progress: OrchestratorProgress) => {
        // Progress is handled via SSE stream — noop for POST response
      },
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

// ─── GET /stream — SSE progress stream ────────────────────────────────
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

  // ── SSE setup ─────────────────────────────────────────────────────
  const requestId = `orchestrator-sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const abortController = new AbortController();
  activeControllers.set(requestId, abortController);

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send SSE comment to confirm connection
  res.write(':ok\n\n');

  // Handle client disconnect
  req.on('close', () => {
    abortController.abort();
    activeControllers.delete(requestId);
  });

  // ── Run orchestrator with SSE progress ────────────────────────────
  const orchestrator = new SmartCrawlOrchestrator();

  orchestrator
    .crawl({
      url: parsed.toString(),
      signal: abortController.signal,
      onProgress: (progress: OrchestratorProgress) => {
        if (!res.writableEnded) {
          const data = JSON.stringify(progress);
          res.write(`event: progress\ndata: ${data}\n\n`);
        }
      },
    })
    .then((finalResult) => {
      if (!res.writableEnded) {
        // Send final result as a separate event
        const data = JSON.stringify(finalResult);
        res.write(`event: complete\ndata: ${data}\n\n`);
        res.end();
      }
    })
    .catch((err) => {
      if (!res.writableEnded) {
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

// ─── GET /stats — Orchestrator cache stats ────────────────────────────
import { protectionCache } from '../core/ProtectionCache.js';

router.get('/stats', (_req: Request, res: Response) => {
  const stats = protectionCache.getStats();
  res.json({
    success: true,
    cache: stats,
  });
});

export default router;
