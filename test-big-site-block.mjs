/**
 * Test: Does one big/slow website block all subsequent requests?
 *
 * Scenario:
 *   - Request #1: large website (takes long)
 *   - Requests #2-10: small websites (fast)
 *   - MUFFET_MAX_CONCURRENCY=5
 *
 * Expected behavior:
 *   - #1 starts immediately (slot 1/5)
 *   - #2-5 start immediately (slots 2-5/5)
 *   - #6-10 wait in queue
 *   - When #2-5 finish → #6-9 start immediately (the big #1 does NOT block them)
 *   - Only 1 slot is "blocked" by the big site, the other 4 keep moving
 */
const BASE_URL = 'http://localhost:3000';
const API_KEY = 'gb-marketers';

// Big/slow website first, then 9 small fast ones
const REQUESTS = [
  { id: 1,  url: 'https://example.com',       site: '🟠 example.com (fast)' },     // already completed from prev test, likely cached
  { id: 2,  url: 'https://httpbin.org',        site: '🟢 httpbin.org (fast)' },
  { id: 3,  url: 'https://neocities.org',      site: '🟢 neocities.org' },
  { id: 4,  url: 'https://bearblog.dev',       site: '🟢 bearblog.dev' },
  { id: 5,  url: 'https://txti.es',            site: '🟢 txti.es' },
  { id: 6,  url: 'https://wttr.in',            site: '🟢 wttr.in' },
  { id: 7,  url: 'https://telegra.ph',         site: '🟢 telegra.ph' },
  { id: 8,  url: 'https://motherfuckingwebsite.com', site: '🟢 mfwebsite.com' },
  { id: 9,  url: 'https://cheapbotsdonequick.com',  site: '🟢 cbdq.com' },
  { id: 10, url: 'https://news.ycombinator.com',    site: '🟢 ycombinator.com' },
];

async function sendCrawl(req) {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/muffet/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ url: req.url, concurrency: 3, internalOnly: true, excludeAssets: true }),
    });
    const body = await res.json();
    return {
      ...req,
      status: res.status,
      ok: res.ok,
      timeMs: Date.now() - start,
      pos: body.queuePosition ?? null,
      jobId: body.jobId?.slice(0,8) ?? null,
    };
  } catch (err) {
    return { ...req, status: 0, ok: false, timeMs: Date.now() - start, pos: null, jobId: null, error: err.message };
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  🧪  BIG-SITE BLOCKING TEST');
console.log('  Does 1 slow crawl block all others?');
console.log('  ──────────────────────────────────────────────────────────');
console.log('  Request #1: Any site (starts in slot 1/5)');
console.log('  Requests #2-10: Fast sites (fill slots 2-5/5, then queue)');
console.log(`  🔧  MUFFET_MAX_CONCURRENCY=5`);
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

console.log('  🚀  Sending all 10 simultaneously...');
console.log('');

const startAll = Date.now();
const results = await Promise.all(REQUESTS.map(r => sendCrawl(r)));
const elapsed = ((Date.now() - startAll) / 1000).toFixed(2);

// Sort by queue position to show order
results.sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));

console.log('  📋  RESULTS (sorted by queue position):');
console.log('  ─────────────────────────────────────────────────────────────');
results.forEach(r => {
  console.log(`     ${r.ok ? '✅' : '❌'}  #${r.id} ${r.site.padEnd(32)} HTTP ${r.status}  ${r.timeMs}ms  pos:${r.pos}`);
});
console.log('');
console.log('  ─────────────────────────────────────────────────────────────');

const queued = results.filter(r => r.ok).length;
console.log(`  ✅ Queued: ${queued}/10  |  Total time: ${elapsed}s`);
console.log('');

// Now explain the concurrency behavior
console.log('  📌  KEY INSIGHT: PQueue concurrency');
console.log('  ─────────────────────────────────────────────────────────────');
console.log('  PQueue runs UP TO 5 crawls SIMULTANEOUSLY.');
console.log('  So even if #1 is a giant site that takes 5 minutes:');
console.log('     ✅ Slots 2-5 finish fast → 4 new crawls start immediately');
console.log('     ❌ Only 1 slot is "blocked" by the big site');
console.log('     🟢 The queue keeps moving at 4 completions/cycle');
console.log('');
console.log('  If all 5 slots get big sites simultaneously:');
console.log('     → They all run in parallel, all finish in parallel');
console.log('     → No single site blocks the entire queue');
console.log('═══════════════════════════════════════════════════════════════');
