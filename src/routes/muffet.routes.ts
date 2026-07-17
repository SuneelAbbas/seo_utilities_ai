import { Router, type Request, type Response } from 'express';
import {
  type MuffetResult,
  MuffetCrawler,
  buildInternalOnlyIncludePattern,
  buildAssetExcludePattern,
  filterPageRoutes,
} from '../core/MuffetCrawler.js';

// ─── Router ──────────────────────────────────────────────────────────

const router = Router();

// ─── Concurrency semaphore ───────────────────────────────────────────
// Max 2 concurrent muffet processes

interface QueuedRequest {
  resolve: () => void;
  reject: (err: Error) => void;
}

let activeMuffetProcesses = 0;
const MAX_CONCURRENT_MUFFET = 2;
const requestQueue: QueuedRequest[] = [];

/**
 * Acquire a semaphore slot. If at capacity, queue the request.
 */
function acquireMuffetSlot(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (activeMuffetProcesses < MAX_CONCURRENT_MUFFET) {
      activeMuffetProcesses++;
      resolve();
    } else {
      requestQueue.push({ resolve, reject });
    }
  });
}

/**
 * Release a semaphore slot and wake the next queued request (if any).
 */
function releaseMuffetSlot(): void {
  const next = requestQueue.shift();
  if (next) {
    // Don't increment — the slot is transferred directly
    next.resolve();
  } else {
    activeMuffetProcesses = Math.max(0, activeMuffetProcesses - 1);
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

/**
 * Parse muffet verbose output lines into MuffetResult-like objects.
 *
 * Verbose format:
 *   https://example.com/          ← URL being checked (no tab prefix)
 *   \t200\thttps://linked.com     ← tab-indented result (status + linked URL)
 */
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

// ─── GET /api/muffet/stream (SSE — real-time progress) ─────────────

router.get('/stream', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string | undefined;
    const internalOnly = req.query.internalOnly !== 'false'; // default true
    const excludeAssets = req.query.excludeAssets !== 'false'; // default true

    // ── Validate URL ─────────────────────────────────────────────
    if (!url || typeof url !== 'string') {
      res.status(400).json({ success: false, error: 'Missing "url" query parameter' });
      return;
    }

    if (!isValidUrl(url)) {
      res.status(400).json({ success: false, error: 'Invalid URL format. URL must start with http:// or https://.' });
      return;
    }

    // ── Acquire semaphore slot ───────────────────────────────────
    await acquireMuffetSlot();

    // ── SSE setup ────────────────────────────────────────────────
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Disable socket timeout for this long-lived streaming connection
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);

    let aborted = false;

    function cleanup() {
      if (aborted) return;
      aborted = true;
      if (child && !child.killed) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      releaseMuffetSlot();
    }

    req.on('close', cleanup);
    req.on('error', cleanup);

    function sendSSE(type: string, data: Record<string, unknown>) {
      if (!aborted) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    }

    // ── Send start event ─────────────────────────────────────────
    const startTime = Date.now();
    sendSSE('start', {
      url,
      message: 'Muffet crawl started',
      timestamp: startTime,
    });

    // ── Build include/exclude patterns ────────────────────────────
    const hostname = new URL(url).hostname;
    const includePattern = internalOnly
      ? buildInternalOnlyIncludePattern(hostname)
      : undefined;
    const excludePattern = excludeAssets
      ? buildAssetExcludePattern()
      : undefined;

    // ── DEBUG: log patterns before spawning ──────────────────────
    console.log('');
    console.log('══════════════════════════════════════════════════════');
    console.log('[MUFFET-SSE] URL:', url);
    console.log('[MUFFET-SSE] internalOnly:', internalOnly);
    console.log('[MUFFET-SSE] excludeAssets:', excludeAssets);
    console.log('[MUFFET-SSE] includePattern:', includePattern ?? '(none)');
    console.log('[MUFFET-SSE] excludePattern:', excludePattern ?? '(none)');
    console.log('══════════════════════════════════════════════════════');
    console.log('');

    // ── Spawn muffet process ─────────────────────────────────────
    const child = MuffetCrawler.spawnStream(url, undefined, undefined, undefined, includePattern, excludePattern);
    const stdoutLines: string[] = [];
    let urlsChecked = 0;
    let currentUrl = '';
    /** Buffer for partial lines that span across chunk boundaries */
    let lineBuffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      // Prepend any leftover partial line from the previous chunk
      const text = lineBuffer + chunk.toString();
      const lines = text.split('\n');
      // The last element may be an incomplete line; save it for the next chunk
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        stdoutLines.push(line);

        if (line.startsWith('\t')) {
          // Tab-indented line: result entry (status + linked URL)
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
          // Non-tab line: URL currently being checked
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
      // Muffet may send warnings to stderr — log them server-side only
      const text = chunk.toString();
      text.split('\n').filter(l => l.trim()).forEach(line => {
        console.error(`[muffet stderr] ${line.trim()}`);
      });
    });

    // ── Process exit ─────────────────────────────────────────────
    child.on('close', (exitCode) => {
      if (aborted) return;

      // Flush any remaining partial line in the buffer
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

      // Parse collected stdout for final results
      let results = parseVerboseOutput(stdoutLines);
      const elapsedSec = Number(((Date.now() - startTime) / 1000).toFixed(2));

      // Post-process: apply additional filtering (safety net)
      if (results.length > 0) {
        // Filter out external domains if internalOnly is true
        // (safety net in case the -i include flag misses some)
        if (internalOnly) {
          results = results.filter((r) => {
            try {
              return new URL(r.url).hostname === hostname;
            } catch {
              return false;
            }
          });
        }
        // Filter out asset URLs, WP paths, feeds, etc.
        if (excludeAssets) {
          results = filterPageRoutes(results);
        }
      }

      // muffet exits with code 0 (all OK) or code 1 (some links errored).
      // Both produce valid crawl results — only treat as failure if
      // the process was killed or produced no output.
      const hasResults = results.length > 0;
      const success = hasResults;

      // Debug logging when results are unexpectedly empty
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
      releaseMuffetSlot();
    });

    child.on('error', (err: Error) => {
      if (aborted) return;
      sendSSE('error', {
        error: err.message,
        errorType: 'process_error',
      });
      res.end();
      releaseMuffetSlot();
    });

  } catch (err) {
    releaseMuffetSlot();
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Internal server error during SSE setup' });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Internal server error' })}\n\n`);
      res.end();
    }
  }
});

// ─── POST /api/muffet/crawl ──────────────────────────────────────────

router.post('/crawl', async (req: Request, res: Response) => {
  try {
    const { url, concurrency, internalOnly, excludeAssets } = req.body;

    // ── Validate URL ─────────────────────────────────────────────
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

    // ── Acquire semaphore slot (wait if at capacity) ─────────────
    await acquireMuffetSlot();

    // ── Run muffet crawl ─────────────────────────────────────────
    const crawler = new MuffetCrawler();
    const result = await crawler.crawl({
      url,
      concurrency: typeof concurrency === 'number' && concurrency > 0 ? concurrency : undefined,
      internalOnly: internalOnly !== false, // default true
      excludeAssets: excludeAssets !== false, // default true
    });

    // Release semaphore slot
    releaseMuffetSlot();

    // ── Send response ────────────────────────────────────────────
    res.json(result);
  } catch (err) {
    // If we acquired a slot, make sure we release it
    releaseMuffetSlot();

    console.error('Muffet crawl error:', err);
    res.status(500).json({
      success: false,
      engine: 'muffet',
      totalPages: 0,
      results: [],
      error: err instanceof Error ? err.message : 'Internal server error',
      errorType: 'process_error',
    });
  }
});

export default router;
