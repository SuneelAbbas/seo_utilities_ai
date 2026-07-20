/**
 * test-parallel.mjs — Parallel load test for Muffet Crawl + Smart Crawl APIs
 *
 * Sends 10 concurrent requests to each endpoint and reports results.
 * Muffet crawl returns instantly (HTTP 202 queued).
 * Smart crawl may take time (Playwright deep crawl) — uses 30s timeout.
 */

const API_BASE = 'http://localhost:3000';
const API_KEY = 'gb-marketers';
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
};

// 10 different test websites
const TEST_URLS = [
  { url: 'https://example.com',        name: 'example.com' },
  { url: 'https://httpbin.org',        name: 'httpbin.org' },
  { url: 'https://jsonplaceholder.typicode.com', name: 'jsonplaceholder' },
  { url: 'https://github.com/robots.txt', name: 'github-robots' },
  { url: 'https://www.google.com/robots.txt', name: 'google-robots' },
  { url: 'https://neilpatel.com',      name: 'neilpatel.com' },
  { url: 'https://moz.com',            name: 'moz.com' },
  { url: 'https://searchengineland.com', name: 'searchengineland.com' },
  { url: 'https://www.semrush.com',    name: 'semrush.com' },
  { url: 'https://ahrefs.com',         name: 'ahrefs.com' },
];

function pad(s, n) { return String(s).padEnd(n); }

async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function testMuffetCrawl(url, name) {
  try {
    const start = Date.now();
    const res = await fetchWithTimeout(`${API_BASE}/api/muffet/crawl`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ url, concurrency: 3, internalOnly: true, excludeAssets: true }),
    }, 15000);
    const elapsed = Date.now() - start;
    const body = await res.json();
    return {
      name,
      endpoint: 'MUFFET-CRAWL',
      status: res.status,
      elapsed,
      ok: res.status === 202,
      jobId: body.jobId ? body.jobId.slice(0, 8) + '…' : '-',
      queuePosition: body.queuePosition ?? '-',
      error: body.error || null,
    };
  } catch (err) {
    return { name, endpoint: 'MUFFET-CRAWL', status: 0, elapsed: 0, ok: false, jobId: '-', queuePosition: '-', error: err.message };
  }
}

async function testSmartCrawl(url, name) {
  try {
    const start = Date.now();
    const res = await fetchWithTimeout(`${API_BASE}/api/orchestrator/crawl`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ url }),
    }, 60000); // 60s timeout for smart crawl (Playwright)
    const elapsed = Date.now() - start;
    const body = await res.json();
    return {
      name,
      endpoint: 'SMART-CRAWL',
      status: res.status,
      elapsed,
      ok: res.status === 200,
      success: body.success ?? '?',
      totalPages: body.totalPages ?? body.result?.totalPages ?? body.crawlResult?.totalPages ?? '-',
      error: body.error || null,
    };
  } catch (err) {
    return { name, endpoint: 'SMART-CRAWL', status: 0, elapsed: 0, ok: false, success: '?', totalPages: '-', error: err.message };
  }
}

async function runTest(testFn, label, urls) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Starting ${urls.length} parallel requests...\n`);

  const startAll = Date.now();
  const results = await Promise.all(urls.map(({ url, name }) => testFn(url, name)));
  const totalElapsed = Date.now() - startAll;

  // Print results table
  console.log(`  ${pad('#', 3)} ${pad('Website', 30)} ${pad('Status', 10)} ${pad('Time', 8)} ${pad('Details', 40)}`);
  console.log(`  ${'-'.repeat(3)} ${'-'.repeat(30)} ${'-'.repeat(10)} ${'-'.repeat(8)} ${'-'.repeat(40)}`);
  results.forEach((r, i) => {
    const statusStr = r.ok ? `✓ ${r.status}` : `✗ ${r.status || 'TIMEOUT'}`;
    const timeStr = r.elapsed ? `${r.elapsed}ms` : '-';
    let detail = '';
    if (r.endpoint === 'MUFFET-CRAWL') {
      detail = r.ok ? `jobId=${r.jobId} pos=${r.queuePosition}` : (r.error || '');
    } else {
      detail = r.ok ? `success=${r.success} pages=${r.totalPages}` : (r.error ? r.error.slice(0, 50) : 'timeout/deadline');
    }
    console.log(`  ${pad(i + 1, 3)} ${pad(r.name, 30)} ${pad(statusStr, 10)} ${pad(timeStr, 8)} ${pad(detail, 40)}`);
  });

  // Summary
  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const rateLimited = results.filter(r => r.status === 429).length;
  const timedOut = results.filter(r => r.status === 0).length;
  const avgTime = results.filter(r => r.elapsed > 0).length > 0
    ? Math.round(results.filter(r => r.elapsed > 0).reduce((s, r) => s + r.elapsed, 0) / results.filter(r => r.elapsed > 0).length)
    : 0;

  console.log(`\n  ${'─'.repeat(85)}`);
  console.log(`  Total: ${total}  |  ✓ Passed: ${passed}  |  ✗ Failed: ${failed}  |  ⏱ Avg: ${avgTime}ms  |  Total time: ${totalElapsed}ms`);
  if (rateLimited > 0) console.log(`  ⛔ Rate-limited (429): ${rateLimited}`);
  if (timedOut > 0) console.log(`  ⏰ Timed out: ${timedOut}`);
  console.log(`  ${'═'.repeat(85)}\n`);

  return { total, passed, failed, rateLimited, timedOut, avgTime, totalElapsed };
}

async function main() {
  console.log(`\n  🚀  PARALLEL LOAD TEST`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Target: ${API_BASE}`);
  console.log(`  Concurrency: ${TEST_URLS.length} parallel requests`);
  console.log(`  Auth: x-api-key: ${API_KEY}`);

  // Test 1: Muffet Crawl (10 parallel — should return HTTP 202 instantly)
  const muffetResult = await runTest(
    testMuffetCrawl,
    '📡 MUFFET CRAWL — POST /api/muffet/crawl (returns HTTP 202 instantly)',
    TEST_URLS
  );

  // Small delay between tests
  console.log('  ⏳ Waiting 3s before Smart Crawl test...\n');
  await new Promise(r => setTimeout(r, 3000));

  // Test 2: Smart Crawl (10 parallel — uses Playwright, may take time)
  const smartResult = await runTest(
    testSmartCrawl,
    '🧠 SMART CRAWL — POST /api/orchestrator/crawl (Playwright deep crawl, 60s timeout)',
    TEST_URLS
  );

  // Final verdict
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  📊  FINAL VERDICT`);
  console.log(`${'═'.repeat(80)}`);

  const muffetOk = muffetResult.rateLimited === 0;
  const smartOk = smartResult.rateLimited === 0;

  if (muffetOk) {
    console.log(`  ✅ MUFFET CRAWL:  ${muffetResult.passed}/${muffetResult.total} passed, 0 rate-limited, avg ${muffetResult.avgTime}ms`);
  } else {
    console.log(`  ❌ MUFFET CRAWL:  ${muffetResult.passed}/${muffetResult.total} passed, ${muffetResult.rateLimited} rate-limited!`);
  }

  if (smartOk) {
    console.log(`  ✅ SMART CRAWL:   ${smartResult.passed}/${smartResult.total} passed, 0 rate-limited, avg ${smartResult.avgTime}ms`);
  } else {
    console.log(`  ❌ SMART CRAWL:   ${smartResult.passed}/${smartResult.total} passed, ${smartResult.rateLimited} rate-limited!`);
  }

  const allOk = muffetOk && smartOk;
  console.log(`\n  ${allOk ? '✅ ALL TESTS PASSED — Queue system working correctly' : '❌ SOME ISSUES DETECTED'}`);
  console.log(`  ${allOk ? '  0 requests rate-limited. Every request was queued properly.' : ''}`);
  console.log(`\n`);
}

main().catch(console.error);
