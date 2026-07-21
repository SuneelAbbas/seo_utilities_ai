/**
 * 100-User Burst Load Test
 * Tests: can 100 concurrent users all get queued without rejection?
 */
const BASE_URL = 'http://localhost:3000';
const API_KEY = 'gb-marketers';

const DOMAINS = [
  'https://example.com', 'https://httpbin.org', 'https://neocities.org',
  'https://news.ycombinator.com', 'https://bearblog.dev', 'https://txti.es',
  'https://telegra.ph', 'https://wttr.in', 'https://cheapbotsdonequick.com',
  'https://motherfuckingwebsite.com',
];

async function sendCrawl(url, index) {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/muffet/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ url, concurrency: 3, internalOnly: true, excludeAssets: true }),
    });
    const body = await res.json();
    return {
      index, site: new URL(url).hostname,
      status: res.status,
      ok: res.ok,
      timeMs: Date.now() - start,
      queued: body.status === 'queued',
      rejected: body.status === 'rejected',
      rateLimited: res.status === 429 || res.status === 503,
      jobId: body.jobId?.slice(0,8) ?? null,
      pos: body.queuePosition ?? null,
      error: body.error ?? null,
    };
  } catch (err) {
    return { index, site: new URL(url).hostname, status: 0, ok: false, timeMs: Date.now() - start, queued: false, rejected: false, rateLimited: false, jobId: null, pos: null, error: err.message };
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  🚀  100-USER BURST TEST');
console.log('  📋  100 concurrent requests to POST /api/muffet/crawl');
console.log(`  🔧  MUFFET_MAX_CONCURRENCY=5 | MUFFET_MAX_QUEUE_SIZE=200`);
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

const startTime = Date.now();
const allRequests = [];
for (let i = 0; i < 100; i++) {
  allRequests.push(sendCrawl(DOMAINS[i % DOMAINS.length], i + 1));
}

const results = await Promise.all(allRequests);
const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

// Summary
const queued = results.filter(r => r.queued).length;
const rejected = results.filter(r => r.rejected).length;
const rateLimited = results.filter(r => r.rateLimited).length;
const errors = results.filter(r => r.error).length;
const avgTime = (results.reduce((s, r) => s + r.timeMs, 0) / results.length).toFixed(0);
const maxPos = Math.max(...results.map(r => r.pos ?? 0));
const minPos = Math.min(...results.map(r => r.pos ?? 99));

console.log('  📊  RESULTS');
console.log('  ─────────────────────────────────────────────────────────────');
console.log(`  Total requests:       100`);
console.log(`  ✅ Queued (HTTP 202):  ${queued}`);
console.log(`  ❌ Rejected (503):     ${rejected}`);
console.log(`  ❌ Rate-limited (429): ${rateLimited}`);
console.log(`  ❌ Errors:             ${errors}`);
console.log(`  ⏱  Avg response:      ${avgTime}ms`);
console.log(`  📍  Queue positions:   ${minPos} → ${maxPos}`);
console.log('');
console.log('  📋  STATUS CODE BREAKDOWN:');
const codes = {};
for (const r of results) { codes[r.status] = (codes[r.status] || 0) + 1; }
for (const [code, count] of Object.entries(codes).sort((a, b) => a[0] - b[0])) {
  const icon = code === '202' ? '✅' : code === '503' ? '⛔' : code === '429' ? '🚫' : '❌';
  console.log(`     ${icon}  HTTP ${code}: ${count}`);
}
console.log('');
console.log('  📋  FIRST 10 RESULTS:');
results.slice(0, 10).forEach(r => {
  console.log(`     ${r.ok ? '✅' : '❌'}  #${String(r.index).padStart(3)} ${r.site.padEnd(25)} HTTP ${r.status}  ${r.timeMs}ms  pos:${r.pos}`);
});
console.log('');
console.log('  📋  LAST 10 RESULTS:');
results.slice(-10).forEach(r => {
  console.log(`     ${r.ok ? '✅' : '❌'}  #${String(r.index).padStart(3)} ${r.site.padEnd(25)} HTTP ${r.status}  ${r.timeMs}ms  pos:${r.pos}`);
});
console.log('');
console.log('  📋  ERRORS (if any):');
const errs = results.filter(r => r.error);
if (errs.length === 0) console.log('     ✅  No errors');
else errs.forEach(r => console.log(`     ❌  #${r.index} ${r.site}: ${r.error}`));

console.log('');
console.log('  ─────────────────────────────────────────────────────────────');
if (rateLimited === 0 && errors === 0) {
  console.log('  ✅  VERDICT: 100/100 QUEUED — System handled burst successfully');
} else {
  console.log(`  ⚠️  VERDICT: ${queued}/100 queued, ${rateLimited} rate-limited`);
}
console.log('═══════════════════════════════════════════════════════════════');
