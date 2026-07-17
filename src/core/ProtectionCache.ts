/**
 * ProtectionCache — In-memory cache for domain protection status.
 *
 * Agar kisi domain ke liye pehle confirm ho chuka hai ke "Muffet fail
 * hota hai, seedha bypass-mode chahiye", agli baar Attempt 1-2 SKIP
 * kar ke seedha deep-crawl-bypass se shuru karein.
 *
 * Cache-TTL: 24 hours (protection-status badal sakta hai).
 */

// ─── Types ────────────────────────────────────────────────────────────

export interface CachedProtection {
  /** Hostname of the domain (lowercase, no www) */
  hostname: string;
  /** The recommended strategy based on past attempts */
  recommendedStrategy: 'muffet' | 'deep-crawl-bypass' | 'unknown';
  /** ISO timestamp when this entry was created */
  cachedAt: string;
  /** ISO timestamp when this entry expires */
  expiresAt: string;
  /** How many times this cache entry has been hit */
  hitCount: number;
  /** Whether previous deep-crawl bypass was successful */
  bypassEverSucceeded: boolean;
}

// ─── Cache ────────────────────────────────────────────────────────────

class ProtectionCache {
  private static readonly TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  private readonly cache = new Map<string, CachedProtection>();
  private lastCleanup = Date.now();

  /**
   * Extract the normalized hostname from a URL.
   * Strips www. prefix for consistent caching.
   */
  private static getHostname(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  /**
   * Get the cached protection status for a URL's domain.
   * Returns null if not cached or expired.
   */
  get(url: string): CachedProtection | null {
    this.cleanupIfNeeded();

    const hostname = ProtectionCache.getHostname(url);
    const entry = this.cache.get(hostname);

    if (!entry) return null;

    // Check if expired
    if (Date.now() >= new Date(entry.expiresAt).getTime()) {
      this.cache.delete(hostname);
      return null;
    }

    // Update hit count
    entry.hitCount++;
    return entry;
  }

  /**
   * Store the protection status for a URL's domain.
   */
  set(
    url: string,
    recommendedStrategy: CachedProtection['recommendedStrategy'],
    bypassEverSucceeded: boolean,
  ): void {
    const hostname = ProtectionCache.getHostname(url);
    const now = new Date();

    const entry: CachedProtection = {
      hostname,
      recommendedStrategy,
      cachedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ProtectionCache.TTL_MS).toISOString(),
      hitCount: 0,
      bypassEverSucceeded,
    };

    this.cache.set(hostname, entry);
  }

  /**
   * Update the cached strategy for a domain after a successful crawl.
   */
  updateAfterAttempt(
    url: string,
    attemptStrategy: string,
    success: boolean,
  ): void {
    const hostname = ProtectionCache.getHostname(url);
    const existing = this.cache.get(hostname);

    if (success && attemptStrategy === 'muffet') {
      // Muffet succeeded — next time try muffet first (fast path)
      this.set(url, 'muffet', false);
    } else if (success && attemptStrategy === 'deep-crawl-bypass') {
      // Bypass succeeded — next time skip straight to bypass
      this.set(url, 'deep-crawl-bypass', true);
    } else if (!success && attemptStrategy === 'muffet') {
      // Muffet failed — keep existing or set to unknown
      if (existing) {
        existing.recommendedStrategy = 'deep-crawl-bypass';
      } else {
        this.set(url, 'deep-crawl-bypass', false);
      }
    }
    // If deep-crawl (non-bypass) failed, don't cache that —
    // let the orchestrator decide based on fresh detection
  }

  /**
   * Run periodic cleanup of expired entries.
   */
  private cleanupIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastCleanup < ProtectionCache.CLEANUP_INTERVAL_MS) return;

    this.lastCleanup = now;
    for (const [hostname, entry] of this.cache) {
      if (now >= new Date(entry.expiresAt).getTime()) {
        this.cache.delete(hostname);
      }
    }
  }

  /**
   * Get cache stats for debugging.
   */
  getStats(): { size: number; entries: Array<{ hostname: string; recommendedStrategy: string; hitCount: number }> } {
    const entries = Array.from(this.cache.values()).map(e => ({
      hostname: e.hostname,
      recommendedStrategy: e.recommendedStrategy,
      hitCount: e.hitCount,
    }));
    return { size: this.cache.size, entries };
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }
}

// ─── Singleton Export ─────────────────────────────────────────────────

export const protectionCache = new ProtectionCache();
export default ProtectionCache;
