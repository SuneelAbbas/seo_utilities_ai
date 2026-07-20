/**
 * Concurrent load test for /api/muffet/crawl
 * Sends 10 concurrent requests and measures performance + identifies issues.
 */

const BASE_URL = 'http://localhost:3000';
const API_KEY = 'gb-marketers';
const TOTAL_REQUESTS = 10;

const payload = {
  url: 'https://accessedge-garage.com',
  concurrency: 5,
  internalOnly: true,
  excludeAssets: true,
};

const results = [];
const startTime = Date.now();

async function sendRequest(id) {
  const reqStart = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/muffet/crawl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const duration = Date.now() - reqStart;
    const body = await res.json();

    return {
      id,
      status: res.status,
      ok: res.ok,
      duration,
      durationSec: (duration / 1000).toFixed(2),
      success: body.success,
      totalPages: body.totalPages ?? 0,
      durationSec2: body.durationSec,
      error: body.error ?? null,
      errorType: body.errorType ?? null,
      rateLimited: res.status === 429,
      bodyPreview: JSON.stringify(body).slice(0, 300),
    };
  } catch (err) {
    return {
      id,
      status: 0,
      ok: false,
      duration: Date.now() - reqStart,
      durationSec: ((Date.now() - reqStart) / 1000).toFixed(2),
      success: false,
      error: err.message,
      errorType: 'network_error',
      rateLimited: false,
      bodyPreview: null,
    };
  }
}

async function main() {
  console.log('══════════════════════════════════════════════════════');
  console.log(`  🧪 MUFFET CRAWL — CONCURRENT LOAD TEST`);
  console.log(`  Target:    ${BASE_URL}/api/muffet/crawl`);
  console.log(`  URL:       ${payload.url}`);
  console.log(`  Requests:  ${TOTAL_REQUESTS} (instant, concurrent)`);
  console.log(`  Payload:   ${JSON.stringify(payload)}`);
  console.log('══════════════════════════════════════════════════════\n');

  // Send ALL requests simultaneously
  const promises = [];
  for (let i = 1; i <= TOTAL_REQUESTS; i++) {
    promises.push(sendRequest(i));
  }

  const res = await Promise.allSettled(promises);

  for (const r of res) {
    if (r.status === 'fulfilled') {
      results.push(r.value);
    } else {
      results.push({ id: '?', status: 0, error: r.reason?.message ?? 'Unknown' });
    }
  }

  // Sort by ID
  results.sort((a, b) => a.id - b.id);

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

  // ─── SUMMARY ────────────────────────────────────────────────
  const total = results.length;
  const succeeded = results.filter(r => r.ok && r.success).length;
  const failed = results.filter(r => !r.ok || !r.success).length;
  const rateLimited = results.filter(r => r.rateLimited).length;
  const networkErrors = results.filter(r => r.errorType === 'network_error').length;

  const durations = results.map(r => r.duration).filter(d => d > 0);
  const avgDuration = durations.length > 0
    ? (durations.reduce((a, b) => a + b, 0) / durations.length / 1000).toFixed(2)
    : 'N/A';
  const minDuration = durations.length > 0
    ? (Math.min(...durations) / 1000).toFixed(2)
    : 'N/A';
  const maxDuration = durations.length > 0
    ? (Math.max(...durations) / 1000).toFixed(2)
    : 'N/A';

  const totalPagesCrawled = results.reduce((sum, r) => sum + (r.totalPages || 0), 0);

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  📊 PERFORMANCE SUMMARY');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Total time:            ${totalDuration}s`);
  console.log(`  Total requests:        ${total}`);
  console.log(`  Succeeded:             ${succeeded}`);
  console.log(`  Failed:                ${failed}`);
  console.log(`  Rate limited (429):    ${rateLimited}`);
  console.log(`  Network errors:        ${networkErrors}`);
  console.log(`  Avg response time:     ${avgDuration}s`);
  console.log(`  Min response time:     ${minDuration}s`);
  console.log(`  Max response time:     ${maxDuration}s`);
  console.log(`  Total pages crawled:   ${totalPagesCrawled}`);
  console.log('══════════════════════════════════════════════════════\n');

  // ─── DETAILED RESULTS ───────────────────────────────────────
  console.log('📋 DETAILED RESULTS:');
  console.log('──────────────────────────────────────────────────────');
  for (const r of results) {
    const icon = r.ok && r.success ? '✅' : r.rateLimited ? '⏳' : '❌';
    const timeLabel = r.durationSec;
    const pagesLabel = r.totalPages != null ? `${r.totalPages} pages` : '-';
    const errorLabel = r.error ? ` | ${r.error.slice(0, 80)}` : '';
    console.log(`  ${icon}  #${String(r.id).padStart(2)}  HTTP ${r.status}  ${timeLabel}s  ${pagesLabel}${errorLabel}`);
  }
  console.log('──────────────────────────────────────────────────────\n');

  // ─── ISSUE ANALYSIS ─────────────────────────────────────────
  console.log('🔍 ISSUE ANALYSIS:');
  console.log('──────────────────────────────────────────────────────');

  const issues = [];

  // Check rate limiting
  if (rateLimited > 0) {
    issues.push({
      severity: '⚠️  WARNING',
      issue: 'Rate Limiting (429)',
      detail: `${rateLimited}/${total} requests were rate-limited. The server allows only 5 crawls/hour/IP when busy, or 30 when idle.`,
    });
  }

  // Check concurrent process limit
  if (succeeded > 0 && succeeded < total - rateLimited) {
    issues.push({
      severity: '⚠️  WARNING',
      issue: 'Concurrent Process Limit',
      detail: 'Only 2 muffet processes can run concurrently (semaphore). Additional requests are queued.',
    });
  }

  // Check failures
  const nonRateLimitFailures = results.filter(r => !r.ok && !r.rateLimited);
  if (nonRateLimitFailures.length > 0) {
    issues.push({
      severity: '🔴  ISSUE',
      issue: 'Request Failures',
      detail: `${nonRateLimitFailures.length} requests failed with non-rate-limit errors.`,
    });
  }

  // Analyze error types
  const errorTypes = {};
  for (const r of results) {
    if (r.errorType) {
      errorTypes[r.errorType] = (errorTypes[r.errorType] || 0) + 1;
    }
  }
  if (Object.keys(errorTypes).length > 0) {
    issues.push({
      severity: '📊  STATS',
      issue: 'Error Breakdown',
      detail: JSON.stringify(errorTypes),
    });
  }

  // Performance issues
  const slowRequests = results.filter(r => r.duration > 300000); // >5 min
  if (slowRequests.length > 0) {
    issues.push({
      severity: '🔴  ISSUE',
      issue: 'Slow Requests (>5 min)',
      detail: `${slowRequests.length} requests took more than 5 minutes. The process timeout is 300s (5 min).`,
    });
  }

  const mediumRequests = results.filter(r => r.duration > 60000 && r.duration <= 300000);
  if (mediumRequests.length > 0) {
    issues.push({
      severity: '⚡  PERFORMANCE',
      issue: 'Long Requests (1-5 min)',
      detail: `${mediumRequests.length} requests took between 1-5 minutes.`,
    });
  }

  if (issues.length === 0) {
    console.log('  ✅  No issues detected');
  } else {
    for (const issue of issues) {
      console.log(`  ${issue.severity}: ${issue.issue}`);
      console.log(`     ${issue.detail}`);
      console.log('');
    }
  }

  // ─── RECOMMENDATIONS ────────────────────────────────────────
  console.log('💡 RECOMMENDATIONS:');
  console.log('──────────────────────────────────────────────────────');
  if (rateLimited > 0) {
    console.log('  • Increase rate limit max or disable rate limiting for testing');
    console.log('  • Current limits: 5 req/hr (busy) / 30 req/hr (idle)');
  }
  console.log('  • Max 2 concurrent muffet processes (semaphore in muffet.routes.ts:22)');
  console.log('  • Requests beyond 2 are queued — good for stability, bad for throughput');
  console.log('  • Consider if you need higher concurrency for production');
  console.log('');
}

main().catch(console.error);
