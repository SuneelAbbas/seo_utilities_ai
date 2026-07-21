/**
 * DeepCrawlEngine — Playwright-based deep crawl engine.
 *
 * Two modes:
 *   1. STANDARD: Full JS rendering, standard timeout, used for Attempt 2
 *   2. BYPASS:   Persistent browser session + stealth evasions + extended timeout,
 *                used for Attempt 3 (last resort)
 *
 * Both modes handle:
 *   - SPA framework detection (React, Vue, Angular)
 *   - Security challenge detection (Cloudflare, SiteGround PoW)
 *   - Link discovery and recursive crawling
 *   - Progress reporting via callback
 */


// ─── Types ────────────────────────────────────────────────────────────

export interface DeepCrawlPage {
  url: string;
  finalUrl: string;
  statusCode: number;
  title: string;
  responseTimeMs: number;
  links: string[];
  contentLength: number;
}

export interface DeepCrawlResult {
  success: boolean;
  mode: 'standard' | 'bypass';
  totalPages: number;
  pages: DeepCrawlPage[];
  captchaDetected: boolean;
  captchaBypassed: boolean;
  durationMs: number;
  error: string | null;
}

export interface DeepCrawlProgress {
  stage: string;
  url: string;
  pagesFound: number;
  pagesCrawled: number;
  elapsedMs: number;
  mode: 'standard' | 'bypass';
}

export type ProgressCallback = (progress: DeepCrawlProgress) => void;

export interface DeepCrawlOptions {
  url: string;
  maxPages: number;
  maxDepth: number;
  requestTimeoutMs: number;
  mode: 'standard' | 'bypass';
  userAgent?: string;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

// ─── Constants ────────────────────────────────────────────────────────

/** Max pages to crawl concurrently (2 = balanced speed vs stability) */
const CONCURRENT_PAGES = 2;

const CHALLENGE_URL_PATTERNS = [
  'sgcaptcha', '_challenge', 'cf-browser-verification',
  'cloudflare', 'captcha', '.well-known/captcha',
];

const CHALLENGE_TITLE_PATTERNS = [
  'just a moment', 'attention required', 'security check',
  'robot challenge', 'checking your browser', 'access denied',
];

const SPA_PATTERNS = [
  /react/i, /vue/i, /angular/i, /svelte/i, /next\.?js/i,
  /nuxt/i, /gatsby/i, /__NUXT__/, /__NEXT_DATA__/,
  /<div id="app">/, /<div id="root">/,
];

const STEALTH_INIT_SCRIPT = `
(() => {
  // Hide webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  // Override chrome.runtime
  if (window.chrome) { window.chrome.runtime = undefined; }
  // Override permissions
  const originalQuery = navigator.permissions?.query;
  if (originalQuery) {
    navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: 'denied' })
        : originalQuery(p);
  }
  // Hide headless
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
})();
`;

// ─── DeepCrawlEngine ──────────────────────────────────────────────────

export class DeepCrawlEngine {
  private browser: any = null;
  private persistentContext: any = null;
  private visited = new Set<string>();
  private pages: DeepCrawlPage[] = [];
  private startTime = 0;

  /**
   * Run a deep crawl with the given options.
   */
  async crawl(options: DeepCrawlOptions): Promise<DeepCrawlResult> {
    const { url, maxPages, maxDepth, requestTimeoutMs, mode, onProgress, signal } = options;
    const startTime = performance.now();
    this.startTime = startTime;
    this.visited.clear();
    this.pages = [];

    const userAgent = options.userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

    let captchaDetected = false;
    let captchaBypassed = false;

    try {
      // Dynamic import of playwright (fails gracefully if not installed)
      const { chromium } = await this.loadPlaywright();

      // Launch browser
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-webgl',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
      });

      // Create context based on mode
      if (mode === 'bypass') {
        // Persistent context with stealth evasions
        this.persistentContext = await this.browser.newContext({
          userAgent,
          viewport: { width: 1920, height: 1080 },
          ignoreHTTPSErrors: false,
          locale: 'en-US',
          timezoneId: 'America/New_York',
          permissions: [],
          geolocation: { latitude: 40.7128, longitude: -74.006 },
        });
      } else {
        // Standard context
        this.persistentContext = await this.browser.newContext({
          userAgent,
          viewport: { width: 1920, height: 1080 },
        });
      }

      // Crawl starting from the root URL
      const queue: Array<{ url: string; depth: number; parentUrl: string | null }> = [
        { url, depth: 0, parentUrl: null },
      ];

      while (queue.length > 0 && this.pages.length < maxPages) {
        // Check for abort
        if (signal?.aborted) {
          return this.makeResult(mode, startTime, false, 'cancelled');
        }

        // Check timeout budget
        const elapsed = performance.now() - startTime;
        const remaining = requestTimeoutMs - elapsed;
        if (remaining <= 0) {
          return this.makeResult(mode, startTime, false, 'timeout');
        }

        // Process up to CONCURRENT_PAGES pages in parallel
        const batchSize = Math.min(CONCURRENT_PAGES, queue.length, maxPages - this.pages.length);
        const batch = queue.splice(0, batchSize);

        const batchResults = await Promise.all(
          batch.map(async (item) => {
            if (this.visited.has(item.url)) return null;
            if (item.depth > maxDepth) return null;

            this.visited.add(item.url);

            // Report progress
            onProgress?.({
              stage: 'crawling',
              url: item.url,
              pagesFound: this.visited.size,
              pagesCrawled: this.pages.length,
              elapsedMs: Math.round(performance.now() - startTime),
              mode,
            });

            // Crawl this page
            const pageResult = await this.crawlPage(item.url, item.depth, mode === 'bypass', Math.min(remaining / batchSize, requestTimeoutMs));
            return { item, pageResult };
          }),
        );

        for (const result of batchResults) {
          if (!result || !result.pageResult) continue;

          const { item, pageResult } = result;

          // Check if it was a captcha page
          if (pageResult.isChallenge) {
            captchaDetected = true;
            if (pageResult.challengeBypassed) {
              captchaBypassed = true;
            }
          }

          this.pages.push(pageResult.page);

          // Add discovered links to queue
          for (const link of pageResult.links) {
            if (!this.visited.has(link)) {
              queue.push({ url: link, depth: item.depth + 1, parentUrl: item.url });
            }
          }
        }

        // Quick sort by depth (BFS preferred)
        queue.sort((a, b) => a.depth - b.depth);
      }

      return {
        success: this.pages.length > 0,
        mode,
        totalPages: this.pages.length,
        pages: this.pages,
        captchaDetected,
        captchaBypassed,
        durationMs: Math.round(performance.now() - startTime),
        error: this.pages.length === 0 ? 'No pages crawled' : null,
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        mode,
        totalPages: this.pages.length,
        pages: this.pages,
        captchaDetected,
        captchaBypassed,
        durationMs: Math.round(performance.now() - startTime),
        error: errorMessage,
      };
    } finally {
      await this.cleanup();
    }
  }

  // ── Private Methods ──────────────────────────────────────────────

  private async crawlPage(
    url: string,
    depth: number,
    stealthMode: boolean,
    timeoutMs: number,
  ): Promise<{
    page: DeepCrawlPage;
    links: string[];
    isChallenge: boolean;
    challengeBypassed: boolean;
  } | null> {
    const startTime = performance.now();

    try {
      const page = await this.persistentContext.newPage();

      // Apply stealth evasions if bypass mode
      if (stealthMode) {
        await page.addInitScript(STEALTH_INIT_SCRIPT);
      }

      // Collect console errors for debugging
      const consoleErrors: string[] = [];
      page.on('console', (msg: any) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      // Navigate
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      }).catch(() => null);

      if (!response) {
        await page.close().catch(() => {});
        return null;
      }

      // Brief pause for async redirects (reduced from 1000ms)
      await page.waitForTimeout(300);

      let currentUrl = page.url();
      let pageTitle = await page.title().catch(() => '');
      let isChallenge = this.detectChallenge(currentUrl, pageTitle);

      // Wait for network idle and re-check (reduced from 15s)
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      currentUrl = page.url();
      pageTitle = await page.title().catch(() => '');
      isChallenge = this.detectChallenge(currentUrl, pageTitle);

      let challengeBypassed = false;

      if (isChallenge && stealthMode) {
        // Try to wait for the challenge to complete
        challengeBypassed = await this.waitForChallengeBypass(page, url);
      }

      // Get content
      const content = await page.content();
      const statusCode = response.status();
      const responseTimeMs = Math.round(performance.now() - startTime);

      // Extract links
      const links = this.extractLinks(content, currentUrl);

      await page.close().catch(() => {});

      const finalUrl = page.url();

      return {
        page: {
          url,
          finalUrl,
          statusCode,
          title: pageTitle,
          responseTimeMs,
          links,
          contentLength: content.length,
        },
        links,
        isChallenge,
        challengeBypassed,
      };

    } catch (err) {
      // Timeout or error
      return null;
    }
  }

  /**
   * Wait for a security challenge page to redirect/complete.
   * Polls every 2s up to 20s (reduced from 30s).
   */
  private async waitForChallengeBypass(
    playwrightPage: any,
    originalUrl: string,
  ): Promise<boolean> {
    const maxWaitMs = 20_000;
    const pollInterval = 2000;
    let waited = 0;

    while (waited < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollInterval));
      waited += pollInterval;

      try {
        const currentUrl = playwrightPage.url();
        const pageTitle = await playwrightPage.title().catch(() => '');

        if (!this.detectChallenge(currentUrl, pageTitle)) {
          // Challenge solved! Wait for full load
          await playwrightPage.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
          return true;
        }
      } catch {
        // Page may be navigating
      }
    }

    return false;
  }

  /**
   * Detect if a URL/title combo indicates a security challenge page.
   */
  private detectChallenge(url: string, title: string): boolean {
    const lowerUrl = url.toLowerCase();
    const lowerTitle = title.toLowerCase();

    for (const pattern of CHALLENGE_URL_PATTERNS) {
      if (lowerUrl.includes(pattern)) return true;
    }

    for (const pattern of CHALLENGE_TITLE_PATTERNS) {
      if (lowerTitle.includes(pattern)) return true;
    }

    return false;
  }

  /**
   * Extract same-domain links from HTML content using regex.
   */
  private extractLinks(html: string, baseUrl: string): string[] {
    try {
      const links = new Set<string>();
      const baseHostname = new URL(baseUrl).hostname;

      // Match all <a href="..."> or <a href='...'> patterns
      const hrefRegex = /<a[^>]+href\s*=\s*["']([^"']+)["']/gi;
      let match: RegExpExecArray | null;

      while ((match = hrefRegex.exec(html)) !== null) {
        try {
          const href = match[1]!;
          if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

          const absolute = new URL(href, baseUrl).toString();
          const linkHostname = new URL(absolute).hostname;

          // Only same-domain links
          if (linkHostname === baseHostname || linkHostname.endsWith('.' + baseHostname)) {
            // Strip fragments
            const cleanUrl = absolute.split('#')[0]!;
            if (cleanUrl.startsWith('http')) {
              links.add(cleanUrl);
            }
          }
        } catch {
          // Skip malformed URLs
        }
      }

      return Array.from(links);
    } catch {
      return [];
    }
  }

  /**
   * Dynamically import playwright — fails gracefully if not installed.
   */
  private async loadPlaywright(): Promise<any> {
    try {
      return await import('playwright');
    } catch {
      throw new Error(
        'Playwright is not installed. Run: npm install playwright && npx playwright install chromium'
      );
    }
  }

  /**
   * Clean up browser resources.
   */
  private async cleanup(): Promise<void> {
    if (this.persistentContext) {
      try { await this.persistentContext.close(); } catch { /* ignore */ }
      this.persistentContext = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }

  private makeResult(
    mode: 'standard' | 'bypass',
    startTime: number,
    success: boolean,
    error: string | null,
  ): DeepCrawlResult {
    return {
      success,
      mode,
      totalPages: this.pages.length,
      pages: this.pages,
      captchaDetected: false,
      captchaBypassed: false,
      durationMs: Math.round(performance.now() - startTime),
      error,
    };
  }
}

export default DeepCrawlEngine;
