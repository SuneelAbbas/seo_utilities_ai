/**
 * test-result-retrieval.mjs
 *
 * End-to-end test for the result retrieval feature.
 * 1. Submit a crawl via POST /api/muffet/crawl
 * 2. Poll GET /api/muffet/result/:jobId until completed
 * 3. Display the full result data
 *
 * Usage: node test-result-retrieval.mjs [url]
 *   url defaults to https://example.com
 */

const BASE = 'http://localhost:3000';
const API_KEY = 'gb-marketers';
const TARGET = process.argv[2] || 'https://example.com';

async function submitCrawl(url) {
  const res = await fetch(`${BASE}/api/muffet/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ url, concurrency: 3 }),
  });
  const data = await res.json();
  console.log(`\n=== CRAWL SUBMISSION [${res.status}] ===`);
  console.log(JSON.stringify(data, null, 2));
  return data.jobId;
}

async function getResult(jobId) {
  const res = await fetch(`${BASE}/api/muffet/result/${jobId}`, {
    headers: { 'x-api-key': API_KEY },
  });
  const data = await res.json();
  return { statusCode: res.status, data };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log(`🚀 Submitting crawl for: ${TARGET}`);
  const jobId = await submitCrawl(TARGET);
  if (!jobId) {
    console.error('❌ No jobId returned!');
    process.exit(1);
  }

  // Poll every 3 seconds until done
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(3000);
    const { statusCode, data } = await getResult(jobId);

    if (statusCode === 202) {
      console.log(`⏳ Still ${data.status} (position: ${data.position})... polling again in 3s`);
      continue;
    }

    console.log(`\n=== CRAWL RESULT [HTTP ${statusCode}] ===`);
    console.log(JSON.stringify(data, null, 2));

    // Verify key fields
    if (data.result) {
      console.log(`\n✅ Total pages crawled: ${data.result.totalPages}`);
      console.log(`✅ Duration: ${data.result.durationSec}s`);
      console.log(`✅ Results array length: ${data.result.results?.length || 0}`);
      if (data.result.results && data.result.results.length > 0) {
        console.log(`✅ First result:`, data.result.results[0]);
        console.log(`✅ Last result:`, data.result.results[data.result.results.length - 1]);
      }
      console.log(`✅ Success: ${data.result.success}`);
    }
    return;
  }

  console.error('❌ Timed out waiting for crawl to complete');
}

main().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
