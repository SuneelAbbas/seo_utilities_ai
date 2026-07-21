/**
 * SmartCrawlOrchestrator — Intelligent crawl escalation engine.
 *
 * GUARANTEES best-possible result for EVERY website by using a 3-attempt
 * escalation chain with pre-detection, smart caching, and timeout budgeting.
 *
 * ─── Escalation Chain ─────────────────────────────────────────────────
 *   Attempt 1: Muffet (fast Go-based link checker) — concurrency 10
 *   Attempt 2: Deep-Crawl standard (Playwright, JS rendering)
 *   Attempt 3: Deep-Crawl bypass (Playwright + stealth evasions + extended timeout)
 *
 * ─── Key Features ─────────────────────────────────────────────────────
 *   • Pre-detection of security protections (Cloudflare, SiteGround, etc.)
 *   • DETECTION-BASED ROUTING: pre-detection result directly picks best
 *     starting attempt (bypass for Cloudflare, standard for Sucuri, etc.)
 *   • 24h in-memory cache to skip failed attempts for known-protected domains
 *   • 8-minute total timeout budget with honest failure reporting
 *   • attemptsLog array for full transparency
 *   • SSE progress updates showing escalation in real-time
 */

import { MuffetCrawler, type MuffetCrawlResponse } from './MuffetCrawler.js';
import { DeepCrawlEngine, type DeepCrawlResult, type ProgressCallback } from './DeepCrawlEngine.js';
import { SecurityPreDetector, type DetectionResult } from './SecurityPreDetector.js';
import { protectionCache } from './ProtectionCache.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface AttemptLog {
  attemptNumber: number;
  strategy: 'muffet' | 'deep-crawl-standard' | 'deep-crawl-bypass';
  result: 'success' | 'fail' | 'skipped' | 'timeout';
  reason: string;
  totalPages: number;
  timeTakenMs: number;
}

export interface OrchestratorProgress {
  stage:
    | 'pre-detection'
    | 'cache-check'
    | 'attempt-1-muffet'
    | 'attempt-2-deep-crawl-standard'
    | 'attempt-3-deep-crawl-bypass'
    | 'completed'
    | 'failed';
  url: string;
  message: string;
  elapsedMs: number;
  /** Pre-detection result (populated after pre-detection stage) */
  detection?: DetectionResult | null;
  /** Attempts so far (populated incrementally) */
  attemptsLog: AttemptLog[];
  /** Final result when stage === 'completed' */
  finalResult?: OrchestratorResult | null;
}

export type ProgressHandler = (progress: OrchestratorProgress) => void;

export interface OrchestratorResult {
  success: boolean;
  url: string;
  /** The engine+mode that ultimately succeeded, or null if all failed */
  winningStrategy: 'muffet' | 'deep-crawl-standard' | 'deep-crawl-bypass' | null;
  /** Total time taken in milliseconds */
  totalTimeMs: number;
  /** Full transparency log of every attempt */
  attemptsLog: AttemptLog[];
  /** Pre-detection result */
  detection: DetectionResult | null;
  /** Muffet crawl response (if muffet was attempted) */
  muffetResult: MuffetCrawlResponse | null;
  /** Deep-Crawl result from standard mode (if attempted) */
  deepCrawlStandardResult: DeepCrawlResult | null;
  /** Deep-Crawl result from bypass mode (if attempted) */
  deepCrawlBypassResult: DeepCrawlResult | null;
  /** Honest failure message when all attempts exhausted */
  error: string | null;
}

export interface OrchestratorOptions {
  url: string;
  /** Total timeout budget in milliseconds (default: 8 minutes) */
  totalTimeoutMs?: number;
  /** Muffet concurrency (default: 10) */
  muffetConcurrency?: number;
  /** Deep-Crawl max pages (default: 50) */
  deepCrawlMaxPages?: number;
  /** Deep-Crawl max depth (default: 3) */
  deepCrawlMaxDepth?: number;
  /** Progress callback for SSE streaming */
  onProgress?: ProgressHandler;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_TOTAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (was 8min)
const MUFFET_DEFAULT_CONCURRENCY = 15;          // Increased from 10 for faster parallel checks
const DEEP_CRAWL_MAX_PAGES = 25;                // Reduced from 50 — sufficient for analysis
const DEEP_CRAWL_MAX_DEPTH = 2;                 // Reduced from 3 — fewer hops, faster results
const DEEP_CRAWL_TIMEOUT_STANDARD_MS = 45_000; // 45s per page (was 90s)
const DEEP_CRAWL_TIMEOUT_BYPASS_MS = 90_000;   // 90s per page (was 180s)

// ─── Orchestrator ─────────────────────────────────────────────────────

export class SmartCrawlOrchestrator {
  private readonly muffetCrawler: MuffetCrawler;
  private readonly deepCrawlEngine: DeepCrawlEngine;
  private readonly preDetector: SecurityPreDetector;

  constructor() {
    this.muffetCrawler = new MuffetCrawler();
    this.deepCrawlEngine = new DeepCrawlEngine();
    this.preDetector = new SecurityPreDetector();
  }

  /**
   * Execute the smart crawl with full escalation chain.
   */
  async crawl(options: OrchestratorOptions): Promise<OrchestratorResult> {
    const {
      url,
      totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
      muffetConcurrency = MUFFET_DEFAULT_CONCURRENCY,
      deepCrawlMaxPages = DEEP_CRAWL_MAX_PAGES,
      deepCrawlMaxDepth = DEEP_CRAWL_MAX_DEPTH,
      onProgress,
      signal,
    } = options;

    const startTime = performance.now();
    const attemptsLog: AttemptLog[] = [];
    let detection: DetectionResult | null = null;

    // ── Helper: check timeout budget ──────────────────────────────────
    const getElapsed = (): number => Math.round(performance.now() - startTime);
    const isTimedOut = (): boolean => getElapsed() >= totalTimeoutMs;
    const remainingTime = (): number => Math.max(0, totalTimeoutMs - getElapsed());

    // ── Helper: emit progress ─────────────────────────────────────────
    const emitProgress = (
      stage: OrchestratorProgress['stage'],
      message: string,
      extra?: Partial<OrchestratorProgress>,
    ): void => {
      onProgress?.({
        stage,
        url,
        message,
        elapsedMs: getElapsed(),
        attemptsLog: [...attemptsLog],
        detection,
        ...extra,
      });
    };

    // ── Helper: add attempt to log ────────────────────────────────────
    const logAttempt = (
      attemptNumber: number,
      strategy: AttemptLog['strategy'],
      result: AttemptLog['result'],
      reason: string,
      totalPages: number,
      timeTakenMs: number,
    ): void => {
      attemptsLog.push({ attemptNumber, strategy, result, reason, totalPages, timeTakenMs });
    };

    try {
      // ══════════════════════════════════════════════════════════════════
      // STEP 1: Pre-Detection (lightweight probe)
      // ══════════════════════════════════════════════════════════════════
      emitProgress('pre-detection', 'Probing website for security protection...');
      detection = await this.preDetector.detect(url);
      emitProgress('pre-detection', `Detection complete: ${detection.protected ? `${detection.provider} (${detection.confidence})` : 'No protection detected'}`);

      // Check abort after detection
      if (signal?.aborted) {
        return this.buildFinalResult(url, startTime, false, attemptsLog, detection, null, null, null, 'Cancelled by user');
      }

      // ══════════════════════════════════════════════════════════════════
      // STEP 2: Cache Check — skip attempts if domain is known-protected
      // ══════════════════════════════════════════════════════════════════
      emitProgress('cache-check', 'Checking protection cache...');
      const cached = protectionCache.get(url);
      let skipToBypass = false;
      let detectionStrategy: 'muffet' | 'deep-crawl-standard' | 'deep-crawl-bypass' = 'muffet';

      if (cached) {
        if (cached.recommendedStrategy === 'deep-crawl-bypass') {
          skipToBypass = true;
          detectionStrategy = 'deep-crawl-bypass';
          emitProgress('cache-check', `Cache HIT for ${cached.hostname} — skipping to bypass mode (previous bypass ${cached.bypassEverSucceeded ? 'succeeded' : 'failed'})`);
        } else {
          detectionStrategy = cached.recommendedStrategy as 'muffet' | 'deep-crawl-standard' | 'deep-crawl-bypass';
          emitProgress('cache-check', `Cache HIT for ${cached.hostname} — recommended strategy: ${cached.recommendedStrategy}`);
        }
      } else {
        // ══════════════════════════════════════════════════════════════════
        // Detection-Based Routing: use pre-detection result to pick the
        // best starting attempt instead of always starting from Muffet.
        // ══════════════════════════════════════════════════════════════════
        detectionStrategy = this.pickStrategyFromDetection(detection);
        if (detectionStrategy === 'deep-crawl-bypass') {
          skipToBypass = true;
          emitProgress('cache-check', `Detection-based routing: ${detection?.provider || 'Unknown protection'} detected → starting from bypass mode`);
        } else if (detectionStrategy === 'deep-crawl-standard') {
          emitProgress('cache-check', `Detection-based routing: ${detection?.provider || 'Generic protection'} detected → starting from deep-crawl standard`);
        } else {
          emitProgress('cache-check', `Detection-based routing: no protection detected → starting from Muffet fast-crawl`);
        }
      }

      // Determine starting attempt based on cache + detection
      const startFromAttempt: 1 | 2 | 3 = skipToBypass ? 3 : (detectionStrategy === 'deep-crawl-standard' ? 2 : 1);

      // ══════════════════════════════════════════════════════════════════
      // STEP 3: Escalation Chain
      // ══════════════════════════════════════════════════════════════════

      let muffetResult: MuffetCrawlResponse | null = null;
      let deepCrawlStandardResult: DeepCrawlResult | null = null;
      let deepCrawlBypassResult: DeepCrawlResult | null = null;

      // ── Attempt 1: Muffet (skipped if cache/detection says bypass or standard) ──
      if (startFromAttempt <= 1) {
        const attemptStart = performance.now();
        emitProgress('attempt-1-muffet', 'Attempt 1/3: Muffet fast-crawl starting...');

        try {
          muffetResult = await this.muffetCrawler.crawl({
            url,
            concurrency: muffetConcurrency,
            processTimeoutMs: Math.min(remainingTime(), 120_000),
          });

          const timeTakenMs = Math.round(performance.now() - attemptStart);
          const totalPages = muffetResult.totalPages || 0;
          const errorCount = muffetResult.results?.filter(r => r.status >= 400).length || 0;
          const totalChecked = muffetResult.results?.length || 0;
          const errorRate = totalChecked > 0 ? (errorCount / totalChecked) * 100 : 0;

          // Muffet success criteria: totalPages > 1 AND errorRate < 50%
          const muffetSucceeded = muffetResult.success && totalPages > 1 && errorRate < 50;

          if (muffetSucceeded) {
            logAttempt(1, 'muffet', 'success', `Crawled ${totalPages} pages with ${errorRate.toFixed(1)}% error rate`, totalPages, timeTakenMs);
            emitProgress('completed', 'Muffet succeeded! No escalation needed.', {
              finalResult: this.buildFinalResult(url, startTime, true, attemptsLog, detection, muffetResult, null, null, null),
            });

            // Update cache: Muffet worked
            protectionCache.updateAfterAttempt(url, 'muffet', true);

            return this.buildFinalResult(url, startTime, true, attemptsLog, detection, muffetResult, null, null, null);
          } else {
            const reason = !muffetResult.success
              ? `Muffet process failed: ${muffetResult.error || 'Unknown error'}`
              : totalPages <= 1
                ? `Only ${totalPages} page(s) found — possible protection blocking`
                : `Error rate ${errorRate.toFixed(1)}% exceeds 50% threshold`;
            logAttempt(1, 'muffet', 'fail', reason, totalPages, timeTakenMs);
            emitProgress('attempt-1-muffet', `Muffet failed: ${reason}. Escalating to attempt 2...`);

            // Update cache: Muffet failed for this domain
            protectionCache.updateAfterAttempt(url, 'muffet', false);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logAttempt(1, 'muffet', 'fail', `Exception: ${errMsg}`, 0, Math.round(performance.now() - attemptStart));
          emitProgress('attempt-1-muffet', `Muffet threw error: ${errMsg}. Escalating...`);
          muffetResult = { success: false, engine: 'muffet', totalPages: 0, results: [], durationSec: 0, error: errMsg };
        }

        // Check timeout / abort after attempt 1
        if (signal?.aborted) {
          return this.buildFinalResult(url, startTime, false, attemptsLog, detection, muffetResult, null, null, 'Cancelled by user');
        }
        if (isTimedOut()) {
          logAttempt(2, 'deep-crawl-standard', 'skipped', 'Timeout budget exhausted after attempt 1', 0, 0);
          logAttempt(3, 'deep-crawl-bypass', 'skipped', 'Timeout budget exhausted after attempt 1', 0, 0);
          return this.buildFinalResult(url, startTime, false, attemptsLog, detection, muffetResult, null, null, 'Timeout: 8-minute budget exhausted after Muffet attempt');
        }
      } else {
        // Skipped by cache or detection-based routing
        const skipReason = skipToBypass
          ? `Cache recommends bypass — skipping Muffet`
          : `Detection recommends ${detectionStrategy} — skipping Muffet`;
        logAttempt(1, 'muffet', 'skipped', skipReason, 0, 0);
        emitProgress('attempt-1-muffet', skipReason);
      }

      // ── Attempt 2: Deep-Crawl Standard (skip if detection/cache says bypass) ──
      if (startFromAttempt <= 2) {
        const attemptStart = performance.now();
        emitProgress('attempt-2-deep-crawl-standard', 'Attempt 2/3: Deep-Crawl standard mode (JS rendering)...');

        try {
          deepCrawlStandardResult = await this.deepCrawlEngine.crawl({
            url,
            maxPages: deepCrawlMaxPages,
            maxDepth: deepCrawlMaxDepth,
            requestTimeoutMs: Math.min(remainingTime(), DEEP_CRAWL_TIMEOUT_STANDARD_MS),
            mode: 'standard',
            onProgress: (p) => {
              emitProgress('attempt-2-deep-crawl-standard', `Deep-Crawl standard: crawled ${p.pagesCrawled}/${deepCrawlMaxPages} pages, ${p.pagesFound} found`);
            },
            signal,
          });

          const timeTakenMs = Math.round(performance.now() - attemptStart);
          const totalPages = deepCrawlStandardResult.totalPages || 0;
          const isChallenge = deepCrawlStandardResult.captchaDetected;

          // Success: more than 1 page and no challenge detected
          const deepCrawlStandardSucceeded = deepCrawlStandardResult.success && totalPages > 1 && !isChallenge;

          if (deepCrawlStandardSucceeded) {
            logAttempt(2, 'deep-crawl-standard', 'success', `Crawled ${totalPages} pages via JS rendering`, totalPages, timeTakenMs);
            emitProgress('completed', 'Deep-Crawl standard succeeded! No escalation needed.', {
              finalResult: this.buildFinalResult(url, startTime, true, attemptsLog, detection, muffetResult, deepCrawlStandardResult, null, null),
            });
            return this.buildFinalResult(url, startTime, true, attemptsLog, detection, muffetResult, deepCrawlStandardResult, null, null);
          } else {
            const reason = !deepCrawlStandardResult.success
              ? `Deep-Crawl failed: ${deepCrawlStandardResult.error || 'Unknown error'}`
              : isChallenge
                ? `Security challenge detected — JS rendering blocked`
                : `Only ${totalPages} page(s) found`;
            logAttempt(2, 'deep-crawl-standard', 'fail', reason, totalPages, timeTakenMs);
            emitProgress('attempt-2-deep-crawl-standard', `Deep-Crawl standard failed: ${reason}. Escalating to attempt 3 (stealth bypass)...`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logAttempt(2, 'deep-crawl-standard', 'fail', `Exception: ${errMsg}`, 0, Math.round(performance.now() - attemptStart));
          emitProgress('attempt-2-deep-crawl-standard', `Deep-Crawl standard error: ${errMsg}. Escalating...`);
          deepCrawlStandardResult = { success: false, mode: 'standard', totalPages: 0, pages: [], captchaDetected: false, captchaBypassed: false, durationMs: 0, error: errMsg };
        }

        // Check timeout / abort after attempt 2
        if (signal?.aborted) {
          return this.buildFinalResult(url, startTime, false, attemptsLog, detection, muffetResult, deepCrawlStandardResult, null, 'Cancelled by user');
        }
        if (isTimedOut()) {
          logAttempt(3, 'deep-crawl-bypass', 'skipped', 'Timeout budget exhausted after attempt 2', 0, 0);
          return this.buildFinalResult(url, startTime, false, attemptsLog, detection, muffetResult, deepCrawlStandardResult, null, 'Timeout: 8-minute budget exhausted after Deep-Crawl standard attempt');
        }
      } else {
        const skipReason2 = skipToBypass
          ? `Cache/detection recommends bypass — skipping standard deep-crawl`
          : `Detection recommends deep-crawl-bypass — skipping standard deep-crawl`;
        logAttempt(2, 'deep-crawl-standard', 'skipped', skipReason2, 0, 0);
        emitProgress('attempt-2-deep-crawl-standard', skipReason2);
      }

      // ── Attempt 3: Deep-Crawl Bypass (LAST RESORT) ──────────────────
      const attemptStart = performance.now();
      emitProgress('attempt-3-deep-crawl-bypass', 'Attempt 3/3: Deep-Crawl bypass mode (stealth + extended timeout) — LAST RESORT...');

      try {
        deepCrawlBypassResult = await this.deepCrawlEngine.crawl({
          url,
          maxPages: deepCrawlMaxPages,
          maxDepth: deepCrawlMaxDepth,
          requestTimeoutMs: Math.min(remainingTime(), DEEP_CRAWL_TIMEOUT_BYPASS_MS),
          mode: 'bypass',
          onProgress: (p) => {
            emitProgress('attempt-3-deep-crawl-bypass', `Deep-Crawl bypass: ${p.stage === 'crawling' ? `crawling ${p.url}` : p.stage}, ${p.pagesCrawled}/${deepCrawlMaxPages} pages`);
          },
          signal,
        });

        const timeTakenMs = Math.round(performance.now() - attemptStart);
        const totalPages = deepCrawlBypassResult.totalPages || 0;
        const bypassSucceeded = deepCrawlBypassResult.success && totalPages > 0;
        const challengeBypassed = deepCrawlBypassResult.captchaBypassed;

        if (bypassSucceeded) {
          const reason = challengeBypassed
            ? `Bypassed security challenge, crawled ${totalPages} pages`
            : `Crawled ${totalPages} pages via stealth mode`;
          logAttempt(3, 'deep-crawl-bypass', 'success', reason, totalPages, timeTakenMs);
          emitProgress('completed', `Deep-Crawl bypass succeeded! ${reason}`, {
            finalResult: this.buildFinalResult(url, startTime, true, attemptsLog, detection, muffetResult, deepCrawlStandardResult, deepCrawlBypassResult, null),
          });

          // Update cache: bypass worked
          protectionCache.updateAfterAttempt(url, 'deep-crawl-bypass', true);

          return this.buildFinalResult(url, startTime, true, attemptsLog, detection, muffetResult, deepCrawlStandardResult, deepCrawlBypassResult, null);
        } else {
          const reason = deepCrawlBypassResult.error || `Only ${totalPages} page(s) found even with stealth mode`;
          logAttempt(3, 'deep-crawl-bypass', 'fail', reason, totalPages, timeTakenMs);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logAttempt(3, 'deep-crawl-bypass', 'fail', `Exception: ${errMsg}`, 0, Math.round(performance.now() - attemptStart));
        deepCrawlBypassResult = { success: false, mode: 'bypass', totalPages: 0, pages: [], captchaDetected: false, captchaBypassed: false, durationMs: 0, error: errMsg };
      }

      // ══════════════════════════════════════════════════════════════════
      // ALL ATTEMPTS EXHAUSTED — Honest failure
      // ══════════════════════════════════════════════════════════════════
      const allPages = [
        ...(muffetResult?.results || []).map(r => r.url),
        ...(deepCrawlStandardResult?.pages || []).map(p => p.url),
        ...(deepCrawlBypassResult?.pages || []).map(p => p.url),
      ];
      const uniquePages = new Set(allPages).size;

      let failureReason: string;
      if (uniquePages > 0) {
        failureReason = `All 3 attempts exhausted. Best effort found ${uniquePages} unique page(s), but no attempt met success criteria. ${detection?.protected ? `Site uses ${detection.provider} (${detection.confidence} confidence) which may be blocking crawlers.` : 'Site may have strict anti-bot measures or requires authentication.'}`;
      } else {
        failureReason = `All 3 attempts exhausted. Zero pages crawled. ${detection?.protected ? `Site uses ${detection.provider} (${detection.confidence} confidence) — anti-bot protection is preventing all crawl attempts.` : 'Site appears unreachable or returns empty responses to all crawl methods.'}`;
      }

      emitProgress('failed', failureReason, {
        finalResult: this.buildFinalResult(url, startTime, false, attemptsLog, detection, muffetResult, deepCrawlStandardResult, deepCrawlBypassResult, failureReason),
      });

      // Update cache: even bypass failed for this domain
      if (detection?.protected) {
        protectionCache.set(url, 'deep-crawl-bypass', false);
      }

      return this.buildFinalResult(url, startTime, false, attemptsLog, detection, muffetResult, deepCrawlStandardResult, deepCrawlBypassResult, failureReason);

    } catch (err) {
      // Top-level catch for unexpected orchestrator errors
      const errorMsg = err instanceof Error ? err.message : String(err);
      emitProgress('failed', `Orchestrator error: ${errorMsg}`, {
        finalResult: this.buildFinalResult(url, startTime, false, attemptsLog, detection, null, null, null, errorMsg),
      });
      return this.buildFinalResult(url, startTime, false, attemptsLog, detection, null, null, null, errorMsg);
    }
  }

  /**
   * Pick the best starting crawl strategy based on pre-detection results.
   *
   * Provider → Strategy mapping:
   *   Cloudflare, SiteGround, DataDome, PerimeterX → bypass (stealth required)
   *   Sucuri, Wordfence, Akamai                    → standard (JS rendering works)
   *   No protection / unknown                       → muffet (fastest)
   */
  private pickStrategyFromDetection(detection: DetectionResult | null): 'muffet' | 'deep-crawl-standard' | 'deep-crawl-bypass' {
    if (!detection || !detection.protected) {
      return 'muffet';
    }

    const provider = detection.provider || '';

    // These providers aggressively block all automated requests — stealth bypass is required
    const bypassProviders = ['Cloudflare', 'SiteGround', 'DataDome', 'PerimeterX / Human Security'];
    if (bypassProviders.some(p => provider.includes(p))) {
      return 'deep-crawl-bypass';
    }

    // These are WAF-style protections — standard JS rendering can handle them
    const standardProviders = ['Sucuri', 'Wordfence', 'Akamai (Bot Manager)'];
    if (standardProviders.some(p => provider.includes(p))) {
      return 'deep-crawl-standard';
    }

    // Unknown protection — safe default to bypass
    if (detection.confidence === 'high' || detection.confidence === 'medium') {
      return 'deep-crawl-bypass';
    }

    return 'deep-crawl-standard';
  }

  /**
   * Build the final OrchestratorResult from all collected data.
   */
  private buildFinalResult(
    url: string,
    startTime: number,
    success: boolean,
    attemptsLog: AttemptLog[],
    detection: DetectionResult | null,
    muffetResult: MuffetCrawlResponse | null,
    deepCrawlStandardResult: DeepCrawlResult | null,
    deepCrawlBypassResult: DeepCrawlResult | null,
    error: string | null,
  ): OrchestratorResult {
    // Determine winning strategy
    const winningAttempt = attemptsLog.find(a => a.result === 'success');
    const winningStrategy = winningAttempt
      ? winningAttempt.strategy
      : null;

    return {
      success,
      url,
      winningStrategy,
      totalTimeMs: Math.round(performance.now() - startTime),
      attemptsLog,
      detection,
      muffetResult,
      deepCrawlStandardResult,
      deepCrawlBypassResult,
      error,
    };
  }
}

export default SmartCrawlOrchestrator;
