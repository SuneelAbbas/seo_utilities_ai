import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/**
 * Absolute path to the project-local muffet binary.
 * Installed at build-time by npm run install:muffet into ./bin/muffet.
 * Using a full path avoids reliance on $PATH, which is important on StackHost
 * where /usr/local/bin/ is write-protected for non-root users.
 */
const MUFFET_BINARY_PATH = join(process.cwd(), 'bin', 'muffet');

// ─── Types ───────────────────────────────────────────────────────────

export interface MuffetResult {
  url: string;
  status: number;
  /** Response time in milliseconds (may be null if muffet didn't report it) */
  timeMs?: number | null;
}

export interface MuffetCrawlResponse {
  success: boolean;
  engine: 'muffet';
  totalPages: number;
  results: MuffetResult[];
  /** Total time taken for the crawl in seconds */
  durationSec: number;
  error?: string;
  errorType?: 'timeout' | 'process_error' | 'parse_error' | 'validation_error';
}

export interface MuffetCrawlerOptions {
  /** URL to crawl */
  url: string;
  /** Number of concurrent requests (default: 5) */
  concurrency?: number;
  /** Timeout per page in seconds (default: 15) */
  pageTimeout?: number;
  /** Max process timeout in milliseconds (default: 120_000) */
  processTimeoutMs?: number;
  /** Max stdout buffer size in bytes (default: 50MB) */
  maxBuffer?: number;
  /**
   * If true (default), only links matching the URL's hostname are checked.
   * External links (e.g. facebook.com, instagram.com) are excluded via a
   * regex passed to muffet's -i / --include flag.
   * Set false to check ALL links including external ones.
   */
  internalOnly?: boolean;
  /**
   * If true (default), exclude asset URLs (CSS, JS, fonts, images, etc.)
   * from the crawl results so only navigable page-routes are reported.
   *
   * Works in two layers:
   *   1. Passes a regex via muffet's -e (exclude) flag so muffet skips
   *      checking asset URLs entirely (though muffet still fetches them).
   *   2. Post-processes the parsed results to filter out any remaining
   *      asset-looking URLs that slipped through.
   *
   * Set false to include all URLs including assets (useful for
   * "technical audit" mode where broken CSS/JS matters).
   */
  excludeAssets?: boolean;
}

// ─── URL sanitization ────────────────────────────────────────────────

/**
 * Sanitize a URL by stripping command-injection characters.
 * Even though we use execFile (which doesn't invoke a shell),
 * this is an extra defense layer.
 */
function sanitizeUrl(raw: string): string {
  // Strip whitespace
  let url = raw.trim();

  // Reject if empty after trim
  if (!url) {
    throw new MuffetError('URL is empty', 'validation_error');
  }

  // Block URLs containing shell metacharacters
  const dangerous = /[;|&`$(){}[\]!#~<>\\'"]/;
  if (dangerous.test(url)) {
    throw new MuffetError(
      'URL contains unsafe characters',
      'validation_error'
    );
  }

  // Ensure it starts with http:// or https://
  if (!/^https?:\/\//i.test(url)) {
    throw new MuffetError(
      'URL must start with http:// or https://',
      'validation_error'
    );
  }

  return url;
}

// ─── Regex escaping ─────────────────────────────────────────────────

/**
 * Escape special regex characters in a string so it can be used as a
 * literal match inside a regular expression.
 *
 * Characters escaped: . \ + * ? [ ^ ] $ ( ) { } = ! < > | : - #
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the muffet --include regex pattern that only includes URLs
 * belonging to the given hostname.
 *
 * Uses the positive -i (include) flag since muffet uses Go's RE2
 * regex engine which does NOT support negative lookaheads.
 *
 * Example for "patchoulibeautylaser.ca":
 *   https?://(www\.)?patchoulibeautylaser\.ca
 *
 * Exported so routes / callers can compute the pattern without
 * needing to duplicate the logic.
 */
export function buildInternalOnlyIncludePattern(hostname: string): string {
  // Strip leading www. so we can add (www\.)? optionally
  // e.g. "www.example.com" → stripped "example.com" → pattern matches both
  //      "https://www.example.com" and "https://example.com"
  const stripped = hostname.replace(/^www\./i, '');
  const escaped = escapeRegex(stripped);
  return `https?://(www\\.)?${escaped}`;
}

/**
 * Build the muffet --exclude regex pattern that excludes:
 *   1. Static asset file extensions (CSS, JS, fonts, images, data files, sourcemaps)
 *   2. WordPress system paths (wp-json, wp-content, wp-includes, wp-admin)
 *   3. WordPress system files (xmlrpc.php)
 *   4. Static asset directories (_static)
 *   5. Feed / comment-feed URLs
 *
 * Uses RE2-compatible syntax (no negative lookahead, no backreferences).
 * Combined with alternation (`|`) so any one match excludes the URL.
 *
 * Exported so routes / callers can compute the pattern without
 * duplicating the logic.
 */
export function buildAssetExcludePattern(): string {
  const assetExt = '\\.(css|js|mjs|woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico|json|xml|map)(\\?.*)?$';
  const wpPaths = '/wp-json/|/wp-content/|/wp-includes/|/wp-admin/';
  const wpFiles = '/xmlrpc\\.php';
  const staticPaths = '/_static/';
  const feeds = '/feed/?$|/comments/feed/?$';
  return `${assetExt}|${wpPaths}|${wpFiles}|${staticPaths}|${feeds}`;
}

/**
 * Regex used by `isPageRoute()` / `filterPageRoutes()` for post-processing.
 * Checks if a URL path ends with a common asset extension.
 */
const ASSET_EXTENSIONS = /\.(css|js|mjs|woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico|json|xml|map|pdf|zip)(\?.*)?$/i;

/**
 * Array of regex patterns matching non-page system / internal URLs.
 * Used as a post-processing safety net.
 */
const NON_PAGE_PATTERNS = [
  /\/wp-json\//i,
  /\/wp-content\//i,
  /\/wp-includes\//i,
  /\/wp-admin\//i,
  /\/xmlrpc\.php/i,
  /\/_static\//i,
  /\/feed\/?$/i,
  /\/comments\/feed\/?$/i,
];

/**
 * Check if a URL is likely a navigable page route.
 *
 * Rejects:
 *   - Static assets (CSS, JS, images, fonts, data files, sourcemaps)
 *   - WordPress system paths (wp-json, wp-content, wp-includes, wp-admin)
 *   - WordPress system files (xmlrpc.php)
 *   - Static asset directories (_static)
 *   - Feed URLs (/feed, /comments/feed)
 *
 * This is used as a post-processing safety net after muffet
 * has already filtered assets via the -e flag.
 */
export function isPageRoute(url: string): boolean {
  // Remove query string and fragment for extension checking
  const path = url.split('?')[0]!.split('#')[0]!;
  // Check asset extensions
  if (ASSET_EXTENSIONS.test(path)) return false;
  // Check non-page system patterns
  for (const pattern of NON_PAGE_PATTERNS) {
    if (pattern.test(url)) return false;
  }
  return true;
}

/**
 * Strip the fragment (anchor) portion from a URL for deduplication.
 *
 * Example:
 *   "https://example.com/page#content"  →  "https://example.com/page"
 *   "https://example.com/page#respond"  →  "https://example.com/page"
 */
export function normalizeUrl(url: string): string {
  return url.split('#')[0]!;
}

/**
 * Deduplicate an array of MuffetResult objects by their normalized URL
 * (fragment/anchor stripped). The first occurrence of each URL is kept.
 *
 * This eliminates duplicate entries that differ only by URL fragment
 * (e.g. /page#content and /page#respond are collapsed to /page).
 */
export function deduplicateResults(results: MuffetResult[]): MuffetResult[] {
  const seen = new Map<string, MuffetResult>();
  for (const r of results) {
    const key = normalizeUrl(r.url);
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

/**
 * Filter an array of MuffetResult objects to keep only navigable page
 * routes, then deduplicate by normalized URL (fragment stripped).
 *
 * This is the post-processing function that catches any
 * edge cases the muffet-level -e regex may have missed.
 */
export function filterPageRoutes(
  results: MuffetResult[],
  predicate?: (result: MuffetResult) => boolean,
): MuffetResult[] {
  let filtered = results.filter((r) => {
    if (predicate && !predicate(r)) return false;
    return isPageRoute(r.url);
  });
  // Deduplicate by normalized URL (strip fragments like #content, #respond)
  filtered = deduplicateResults(filtered);
  return filtered;
}

// ─── Custom error ────────────────────────────────────────────────────

export class MuffetError extends Error {
  public type: MuffetCrawlResponse['errorType'];

  constructor(message: string, type: MuffetCrawlResponse['errorType']) {
    super(message);
    this.name = 'MuffetError';
    this.type = type;
  }
}

// ─── Muffet Crawler ──────────────────────────────────────────────────

export class MuffetCrawler {
  private static readonly DEFAULT_CONCURRENCY = 5;
  /** Per-page timeout in seconds (default: 60 = 1 min per page) */
  private static readonly DEFAULT_PAGE_TIMEOUT = 60;
  /** 5-minute safety limit for the entire crawl process */
  private static readonly DEFAULT_PROCESS_TIMEOUT_MS = 300_000;
  private static readonly DEFAULT_MAX_BUFFER = 50 * 1024 * 1024; // 50 MB

  /**
   * Run a muffet crawl against the given URL.
   *
   * Uses child_process.execFile() — NOT exec() — to avoid shell injection.
   * Muffet output is parsed as JSON-Lines (one JSON object per line).
   */
  async crawl(options: MuffetCrawlerOptions): Promise<MuffetCrawlResponse> {
    const startTime = performance.now();

    const {
      concurrency = MuffetCrawler.DEFAULT_CONCURRENCY,
      pageTimeout = MuffetCrawler.DEFAULT_PAGE_TIMEOUT,
      processTimeoutMs = MuffetCrawler.DEFAULT_PROCESS_TIMEOUT_MS,
      maxBuffer = MuffetCrawler.DEFAULT_MAX_BUFFER,
      internalOnly = true,
      excludeAssets = true,
    } = options;

    try {
      // 1. Sanitize the URL
      const url = sanitizeUrl(options.url);

      // 2. Extract hostname for internal-only filtering
      const hostname = new URL(url).hostname;
      const includePattern = internalOnly
        ? buildInternalOnlyIncludePattern(hostname)
        : undefined;

      // 2b. Build asset exclude pattern
      const excludePattern = excludeAssets
        ? buildAssetExcludePattern()
        : undefined;

      // 3. Build arguments — no shell, just an argv array
      //    IMPORTANT: Flags MUST use Unix-style --dash prefix (not /slash).
      //    Muffet is a Go binary running on Linux — it expects -c, -f, --timeout, etc.
      const args: string[] = [];

      args.push('-c', String(concurrency), '-f', 'json', '--timeout', String(pageTimeout));
      if (includePattern) args.push('--include', includePattern);
      if (excludePattern) args.push('--exclude', excludePattern);
      args.push(url);

      // ── DEBUG: log exact muffet command before execution ─────────
      console.log('');
      console.log('══════════════════════════════════════════════════════');
      console.log('[MUFFET] Executing:', MUFFET_BINARY_PATH, JSON.stringify(args));
      console.log('[MUFFET] includePattern:', includePattern ?? '(none)');
      console.log('[MUFFET] excludePattern:', excludePattern ?? '(none)');
      console.log('══════════════════════════════════════════════════════');
      console.log('');

      // 3. Execute muffet via execFile (safe — no shell)
      //    Uses MUFFET_BINARY_PATH (project-local ./bin/muffet) instead of relying on $PATH
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(
          MUFFET_BINARY_PATH,
          args,
          {
            timeout: processTimeoutMs,
            maxBuffer,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            if (err) {
              console.error('');
              console.error('══════════════════════════════════════════════════════');
              console.error('[MUFFET-ERROR] muffet process exited with error');
              console.error('[MUFFET-ERROR] EXACT COMMAND:', MUFFET_BINARY_PATH, args.join(' '));
              console.error('[MUFFET-ERROR] ERROR OBJECT:', err);
              console.error('[MUFFET-ERROR] STDERR:', stderr);
              console.error('[MUFFET-ERROR] STDOUT (first 500 chars):', stdout?.slice(0, 500));
              console.error('══════════════════════════════════════════════════════');
              console.error('');

              // If the process timed out
              if (err.killed || (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
                reject(new MuffetError(
                  'Muffet process timed out — website may be too large or unresponsive',
                  'timeout'
                ));
                return;
              }
              // Some errors still produce valid stdout (e.g., broken links found)
              // Only reject if there's genuinely no output
              if (!stdout) {
                reject(new MuffetError(
                  `Muffet process failed: ${err.message}`,
                  'process_error'
                ));
                return;
              }
            }
            resolve({ stdout, stderr });
          }
        );
      });

      // 4. Parse JSON-Lines output
      let results = this.parseMuffetOutput(stdout);

      // 5. Post-process: apply additional filtering (safety net)
      if (results.length > 0) {
        // 5a. Filter out external domains if internalOnly is true
        //     (safety net in case the -i include flag misses some)
        if (internalOnly) {
          results = results.filter((r) => {
            try {
              return new URL(r.url).hostname === hostname;
            } catch {
              return false;
            }
          });
        }
        // 5b. Filter out asset URLs, WP paths, feeds, etc.
        if (excludeAssets) {
          results = filterPageRoutes(results);
        }
      }

      // 6. Wrap into response shape (convert ms to seconds)
      return {
        success: true,
        engine: 'muffet',
        durationSec: Number(((performance.now() - startTime) / 1000).toFixed(2)),
        totalPages: results.length,
        results,
      };
    } catch (err) {
      if (err instanceof MuffetError) {
        return {
          success: false,
          engine: 'muffet',
          totalPages: 0,
          results: [],
          durationSec: Number(((performance.now() - startTime) / 1000).toFixed(2)),
          error: err.message,
          errorType: err.type,
        };
      }

      // Unknown error – wrap generically
      return {
        success: false,
        engine: 'muffet',
        totalPages: 0,
        results: [],
        durationSec: Number(((performance.now() - startTime) / 1000).toFixed(2)),
        error: err instanceof Error ? err.message : 'Unknown error occurred',
        errorType: 'process_error',
      };
    }
  }

  // ─── Static arg builder (shared by crawl + spawnStream) ──────────

  /**
   * Build the muffet CLI argument array based on platform.
   */
  static buildArgs(
    url: string,
    concurrency: number,
    pageTimeout: number,
    includePattern?: string,
    excludePattern?: string,
  ): string[] {
    const args: string[] = [];

    // Unix-style flags for Linux muffet binary
    args.push('-c', String(concurrency), '--verbose', '--timeout', String(pageTimeout));
    if (includePattern) args.push('--include', includePattern);
    if (excludePattern) args.push('--exclude', excludePattern);
    args.push(url);

    // ── DEBUG: log the built args ─────────────────────────────────
    console.log('[MUFFET-buildArgs]', MUFFET_BINARY_PATH, JSON.stringify(args));
    return args;
  }

  /**
   * Spawn muffet in streaming mode (human-readable + verbose).
   * Returns the ChildProcess so the caller can pipe stdout/stderr to SSE.
   *
   * Each line on stdout represents a URL being checked.
   * Process will self-terminate after `processTimeoutMs` if not finished.
   */
  static spawnStream(
    url: string,
    concurrency: number = MuffetCrawler.DEFAULT_CONCURRENCY,
    pageTimeout: number = MuffetCrawler.DEFAULT_PAGE_TIMEOUT,
    processTimeoutMs: number = MuffetCrawler.DEFAULT_PROCESS_TIMEOUT_MS,
    includePattern?: string,
    excludePattern?: string,
  ): ChildProcess {
    const args = MuffetCrawler.buildArgs(url, concurrency, pageTimeout, includePattern, excludePattern);
    // ── DEBUG: log the spawned command ─────────────────────────────
    console.log('[MUFFET-spawnStream] Spawning:', MUFFET_BINARY_PATH, args.join(' '));
    console.log('[MUFFET-spawnStream] includePattern:', includePattern ?? '(none)');
    console.log('[MUFFET-spawnStream] excludePattern:', excludePattern ?? '(none)');
    const child = spawn(MUFFET_BINARY_PATH, args, {
      timeout: processTimeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Log child process errors (e.g., muffet not found, permission denied)
    child.on('error', (err) => {
      console.error('');
      console.error('══════════════════════════════════════════════════════');
      console.error('[MUFFET-spawnStream-ERROR] Child process error');
      console.error('[MUFFET-spawnStream-ERROR] EXACT COMMAND:', MUFFET_BINARY_PATH, args.join(' '));
      console.error('[MUFFET-spawnStream-ERROR] ERROR:', err.message);
      console.error('[MUFFET-spawnStream-ERROR] STACK:', err.stack);
      console.error('══════════════════════════════════════════════════════');
      console.error('');
    });

    return child;
  }

  /**
   * Parse muffet JSON output into MuffetResult[].
   *
   * Muffet v2.x can output two JSON formats:
   *
   * **Format A – Simple array** (older muffet builds):
   *   [{"url":"https://...", "status":200, "time_ms":123}, ...]
   *
   * **Format B – Tree format** (muffet v2.11+ with `/json` flag):
   *   [{"url":"https://...", "links":[{"url":"https://...", "error":"..."}]}, ...]
   *
   * This method handles both formats transparently.
   */
  private parseMuffetOutput(stdout: string): MuffetResult[] {
    const results: MuffetResult[] = [];
    const trimmed = stdout.trim();

    if (!trimmed || trimmed === '[]' || trimmed === '{}') {
      return results;
    }

    // Helper: extract a MuffetResult from a single link object
    const extractLink = (link: Record<string, unknown>): MuffetResult | null => {
      if (!link || typeof link.url !== 'string') return null;
      return {
        url: link.url,
        status: typeof link.status === 'number'
          ? link.status
          : (link.error ? 0 : 200),
        timeMs: typeof link.time_ms === 'number'
          ? link.time_ms
          : typeof link.duration_ms === 'number'
            ? link.duration_ms
            : typeof link.time === 'number'
              ? link.time
              : null,
      };
    };

    // Try parsing as a JSON array first
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (!item || typeof item.url !== 'string') continue;

          // Format A: { url, status, ... }
          if (typeof item.status === 'number') {
            const r = extractLink(item);
            if (r) results.push(r);
            continue;
          }

          // Format B: { url, links: [{ url, status?, error? }] }
          if (Array.isArray(item.links)) {
            for (const link of item.links) {
              const r = extractLink(link);
              if (r) results.push(r);
            }
          }
        }
        return results;
      }
    } catch {
      // Not a JSON array — fall through to JSON-lines parsing
    }

    // Fallback: parse as JSON-Lines (one JSON object per line)
    const lines = trimmed.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed.url !== 'string') continue;

        // Format A
        if (typeof parsed.status === 'number') {
          const r = extractLink(parsed);
          if (r) results.push(r);
          continue;
        }

        // Format B
        if (Array.isArray(parsed.links)) {
          for (const link of parsed.links) {
            const r = extractLink(link);
            if (r) results.push(r);
          }
        }
      } catch {
        // Skip lines that aren't valid JSON
        continue;
      }
    }

    return results;
  }
}

export default MuffetCrawler;
