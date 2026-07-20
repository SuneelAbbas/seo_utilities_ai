/**
 * test-parallel.mjs — Parallel load test for Muffet Crawl + Smart Crawl APIs
 *
 * Sends 10 concurrent requests to each endpoint and reports results.
 */

const API_BASE = 'http://localhost:3000';
const API_KEY = 'gb-marketers';
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
};

// 10 different test websites (small ones that won't take too long)
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

async function testMuffetCrawl(url, name) {
  try {
    const start = Date.now();
    const res = await fetch(`${API_BASE}/api/muffet/crawl`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ url, concurrency: 3, internalOnly: true, excludeAssets: true }),
    });
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
    const res = await fetch(`${API_BASE}/api/orchestrator/crawl`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ url }),
    });
    const elapsed = Date.now() - start;
    const body = await res.json();
    return {
      name,
      endpoint: 'SMART-CRAWL',
      status: res.status,
      elapsed,
      ok: res.status === 200,
      success: body.success ?? '?',
      totalPages: body.totalPages ?? body.result?.totalPages ?? '-',
      error: body.error || null,
    };
  } catch (err) {
    return { name, endpoint: 'SMART-CRAWL', status: 0, elapsed: 0, ok: false, success: '?', totalPages: '-', error: err.message };
  }
}

async function runTest(testFn, label, urls) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Starting ${urls.length} parallel requests...\n`);

  const results = await Promise.all(urls.map(({ url, name }) => testFn(url, name)));

  // Print results table
  console.log(`  ${pad('#', 3)} ${pad('Website', 30)} ${pad('Status', 8)} ${pad('Time', 8)} ${pad('Details', 30)}`);
  console.log(`  ${'-'.repeat(3)} ${'-'.repeat(30)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(30)}`);
  results.forEach((r, i) => {
    const statusStr = r.ok ? `✓ ${r.status}` : `✗ ${r.status}`;
    const timeStr = `${r.elapsed}ms`;
    let detail = '';
    if (r.endpoint === 'MUFFET-CRAWL') {
      detail = r.ok ? `jobId=${r.jobId} pos=${r.queuePosition}` : (r.error || '');
    } else {
      detail = r.ok ? `success=${r.success} pages=${r.totalPages}` : (r.error || '');
    }
    console.log(`  ${pad(i + 1, 3)} ${pad(r.name, 30)} ${pad(statusStr, 8)} ${pad(timeStr, 8)} ${pad(detail, 30)}`);
  });

  // Summary
  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const rateLimited = results.filter(r => r.status === 429).length;
  const avgTime = Math.round(results.reduce((s, r) => s + r.elapsed, 0) / total);

  console.log(`\n  ───────────────────────────────────────────────────────`);
  console.log(`  Total: ${total}  |  Passed: ${passed}  |  Failed: ${failed}  |  Rate-limited: ${rateLimited}  |  Avg time: ${avgTime}ms`);
  console.log(`  ${'═'.repeat(70)}\n`);

  return { total, passed, failed, rateLimited, avgTime };
}

async function main() {
  console.log(`\n  🚀  PARALLEL LOAD TEST — Muffet Crawl + Smart Crawl`);
  console.log(`  ${'─'.repeat(55)}`);
  console.log(`  Target: ${API_BASE}`);
  console.log(`  Concurrency: ${TEST_URLS.length} parallel requests`);

  // Test 1: Muffet Crawl (10 parallel)
  const muffetResult = await runTest(testMuffetCrawl, '📡 MUFFET CRAWL — POST /api/muffet/crawl (10 parallel)', TEST_URLS);

  // Small delay between tests
  await new Promise(r => setTimeout(r, 2000));

  // Test 2: Smart Crawl (10 parallel)
  const smartResult = await runTest(testSmartCrawl, '🧠 SMART CRAWL — POST /api/orchestrator/crawl (10 parallel)', TEST_URLS);

  // Final verdict
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  📊  FINAL VERDICT`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Muffet Crawl:  ${muffetResult.passed}/${muffetResult.total} passed` +
    (muffetResult.rateLimited > 0 ? `  (${muffetResult.rateLimited} rate-limited!)` : ''));
  console.log(`  Smart Crawl:   ${smartResult.passed}/${smartResult.total} passed` +
    (smartResult.rateLimited > 0 ? `  (${smartResult.rateLimited} rate-limited!)` : ''));

  const allOk = muffetResult.rateLimited === 0 && smartResult.rateLimited === 0;
  console.log(`\n  ${allOk ? '✅ ALL TESTS PASSED — 0 rate-limited, 0 rejected' : '❌ SOME TESTS FAILED — check results above'}`);
  console.log(`\n`);
}

main().catch(console.error);
