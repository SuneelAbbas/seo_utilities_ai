# 🔗 SEO Utilities API — Frontend Integration Guide

> **Base URL:** `https://fvncgcoa9vsibc5t-free-app.stackhost.org`
>
> **For:** Frontend developers integrating with the SEO Utilities API

---

## 📋 Quick Overview

| # | Feature | Method | Endpoint | Best For |
|---|---------|--------|----------|----------|
| 1 | **Website Link Checker** | `POST` | `/api/muffet/crawl` | Getting all links with status codes from a website |
| 2 | **Live Crawl Progress** | `GET` | `/api/muffet/stream` | Showing real-time progress in a UI |
| 3 | **Smart Crawl (Auto Mode)** | `POST` | `/api/orchestrator/crawl` | Best crawl method auto-selected for each site |
| 4 | **Smart Crawl Live Progress** | `GET` | `/api/orchestrator/stream` | Real-time progress with smart escalation |
| 5 | **AI Brand Visibility Check** | `POST` | `/api/citation/check` | Check if a brand appears in AI search results |
| 6 | **Server Health** | `GET` | `/api/health` | Check if server is alive (no auth needed) |

---

## 🔐 Authentication

**All endpoints** (except `/api/health`) require an API key sent as a header:

```http
x-api-key: your-secret-key-here
```

Ask the backend team for the API key value.

---

## 📦 1. Website Link Checker

Crawl a website and get back all the links it contains with their HTTP status codes (200 = OK, 404 = broken, 301 = redirect, etc.).

### Request

```
POST https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/muffet/crawl
```

**Headers:**
```http
Content-Type: application/json
x-api-key: your-secret-key-here
```

**Body (JSON):**
```json
{
  "url": "https://books.toscrape.com",
  "concurrency": 10,
  "internalOnly": true,
  "excludeAssets": true
}
```

| Field | Type | Required | Default | What it does |
|-------|------|----------|---------|-------------|
| `url` | `string` | ✅ Yes | — | The website URL to scan. Must start with `http://` or `https://`. |
| `concurrency` | `number` | ❌ No | `5` | How many pages to check at once. Higher = faster but more load on the target site. |
| `internalOnly` | `boolean` | ❌ No | `true` | `true` = only check links on the same domain (ignore Facebook, Twitter, etc.). `false` = check every link found. |
| `excludeAssets` | `boolean` | ❌ No | `true` | `true` = skip CSS files, JS files, images, fonts. `false` = include everything. |

### Success Response (200)

```json
{
  "success": true,
  "engine": "muffet",
  "totalPages": 42,
  "durationSec": 3.21,
  "results": [
    {
      "url": "https://books.toscrape.com/",
      "status": 200,
      "timeMs": 120
    },
    {
      "url": "https://books.toscrape.com/catalogue/",
      "status": 200,
      "timeMs": 95
    },
    {
      "url": "https://books.toscrape.com/contact/",
      "status": 404,
      "timeMs": 30
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | `true` if the crawl ran (even if some links are broken) |
| `engine` | `string` | Always `"muffet"` |
| `totalPages` | `number` | How many page URLs were found |
| `durationSec` | `number` | Total time taken in seconds |
| `results[].url` | `string` | The URL that was checked |
| `results[].status` | `number` | HTTP status code: `200` = OK, `301` = moved, `404` = broken, `0` = error |
| `results[].timeMs` | `number\|null` | Response time in milliseconds, or `null` if unavailable |

### Error Response (4xx/5xx)

```json
{
  "success": false,
  "engine": "muffet",
  "totalPages": 0,
  "results": [],
  "durationSec": 0.12,
  "error": "URL must start with http:// or https://",
  "errorType": "validation_error"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `error` | `string` | Human-readable error message |
| `errorType` | `string` | One of: `"timeout"`, `"process_error"`, `"parse_error"`, `"validation_error"` |

### ✅ JavaScript Example (fetch)

```javascript
const response = await fetch('https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/muffet/crawl', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'your-secret-key-here'
  },
  body: JSON.stringify({
    url: 'https://books.toscrape.com',
    concurrency: 10,
    internalOnly: true,
    excludeAssets: true
  })
});

const data = await response.json();
console.log(`Found ${data.totalPages} pages in ${data.durationSec}s`);
data.results.forEach(r => {
  console.log(`${r.status} ${r.url}`);
});
```

---

## 📡 2. Live Crawl Progress (SSE)

Same as above, but you get real-time updates as the crawl happens using **Server-Sent Events**. Good for showing a progress bar or live feed.

### Request

```
GET https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/muffet/stream?url=https://books.toscrape.com&internalOnly=true&excludeAssets=true
```

**Headers:**
```http
x-api-key: your-secret-key-here
```

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | `string` | ✅ Yes | — | Website URL to crawl (must be URL-encoded) |
| `internalOnly` | `boolean` | ❌ No | `true` | Pass `false` to check external links too |
| `excludeAssets` | `boolean` | ❌ No | `true` | Pass `false` to include CSS/JS/images |

### Response — SSE Event Stream

The server sends a stream of events. Each event is a JSON line starting with `data:`:

```
data: {"type":"start","url":"https://books.toscrape.com","message":"Muffet crawl started","timestamp":1712345678000}

data: {"type":"progress","url":"https://books.toscrape.com/catalogue/","urlsChecked":5,"elapsedSec":1.23}

data: {"type":"result","url":"https://books.toscrape.com/catalogue/","status":200,"urlsChecked":5}

data: {"type":"complete","success":true,"exitCode":0,"totalPages":42,"results":[...],"urlsChecked":50,"elapsedSec":3.21,"message":"Crawl completed successfully"}
```

### Event Types

| Event | When it fires | What's in the data |
|-------|--------------|-------------------|
| **`start`** | Crawl begins | `url`, `message`, `timestamp` |
| **`progress`** | A new URL is being checked | `url` (current page), `urlsChecked` (count so far), `elapsedSec` |
| **`result`** | A link's status is known | `url` (the link), `status` (HTTP code), `urlsChecked` |
| **`complete`** | Crawl finished | `success`, `totalPages`, `results[]` (all results), `elapsedSec` |
| **`error`** | Something went wrong | `error` (message), `errorType` |

### ✅ JavaScript Example (EventSource)

```javascript
const eventSource = new EventSource(
  'https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/muffet/stream?url=https://books.toscrape.com',
  { headers: { 'x-api-key': 'your-secret-key-here' } }  // Note: Some browsers may not support custom headers with EventSource
);

// Alternative: Use fetch with streaming
const response = await fetch(
  'https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/muffet/stream?url=https://books.toscrape.com',
  { headers: { 'x-api-key': 'your-secret-key-here' } }
);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));
      
      switch (event.type) {
        case 'start':
          console.log('Crawl started for:', event.url);
          break;
        case 'progress':
          updateProgressBar(event.urlsChecked, event.elapsedSec);
          break;
        case 'result':
          console.log(`${event.status} → ${event.url}`);
          break;
        case 'complete':
          console.log('Done!', event.totalPages, 'pages found');
          break;
        case 'error':
          console.error('Error:', event.error);
          break;
      }
    }
  }
}
```

---

## 🧠 3. Smart Crawl (Auto Mode)

The orchestrator automatically tries the best method for each website:
1. First tries **muffet** (fast Go-based checker) — works for most sites
2. If that fails, tries **Deep Crawl** (Playwright browser) — for JavaScript-heavy sites
3. If still failing, tries **Deep Crawl with stealth mode** — for sites with anti-bot protection

Returns a detailed report showing which method succeeded.

### Request

```
POST https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/orchestrator/crawl
```

**Headers:**
```http
Content-Type: application/json
x-api-key: your-secret-key-here
```

**Body (JSON):**
```json
{
  "url": "https://example.com"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | ✅ Yes | Website URL to crawl |

### Success Response (200)

```json
{
  "success": true,
  "url": "https://example.com",
  "winningStrategy": "muffet",
  "totalTimeMs": 3210,
  "attemptsLog": [
    {
      "attemptNumber": 1,
      "strategy": "muffet",
      "result": "success",
      "reason": "Crawl completed with 42 pages",
      "totalPages": 42,
      "timeTakenMs": 3210
    }
  ],
  "detection": {
    "hasProtection": false,
    "protectedBy": [],
    "confidence": 0
  },
  "muffetResult": {
    "success": true,
    "engine": "muffet",
    "totalPages": 42,
    "durationSec": 3.21,
    "results": [
      { "url": "https://example.com/", "status": 200, "timeMs": 100 }
    ]
  },
  "deepCrawlStandardResult": null,
  "deepCrawlBypassResult": null,
  "error": null
}
```

### Key Fields in Response

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | `true` if any crawl method succeeded |
| `winningStrategy` | `string\|null` | Which method worked: `"muffet"`, `"deep-crawl-standard"`, `"deep-crawl-bypass"`, or `null` if all failed |
| `totalTimeMs` | `number` | Total time in milliseconds |
| `attemptsLog[]` | `array` | Log of what was tried and what happened |
| `muffetResult` | `object\|null` | Full muffet crawl results (see Section 1 for format) |
| `deepCrawlStandardResult` | `object\|null` | Deep crawl result (if attempted) |
| `deepCrawlBypassResult` | `object\|null` | Stealth deep crawl result (if attempted) |
| `error` | `string\|null` | Error message if all attempts failed |

### Error Response

```json
{
  "success": false,
  "error": "Orchestrator error: Description of what went wrong"
}
```

---

## 📡 4. Smart Crawl Live Progress (SSE)

Real-time progress for the smart orchestrator, using **named SSE events** for cleaner client-side parsing.

### Request

```
GET https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/orchestrator/stream?url=https://example.com
```

**Headers:**
```http
x-api-key: your-secret-key-here
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | `string` | ✅ Yes | Website URL to crawl |

### SSE Event Stream

```
:ok

event: progress
data: {"stage":"pre-detection","url":"https://example.com","message":"Checking for security protections...","elapsedMs":100,"attemptsLog":[]}

event: progress
data: {"stage":"attempt-1-muffet","url":"https://example.com","message":"Running muffet fast scan...","elapsedMs":500,"attemptsLog":[]}

event: complete
data: {"success":true,"winningStrategy":"muffet","totalTimeMs":3210,"attemptsLog":[...],"muffetResult":{...}}
```

### Event Types

| Event | Description |
|-------|-------------|
| **`:ok`** (comment) | Connection confirmed — sent immediately when you connect |
| **`progress`** | Crawl stage update — contains `stage` (which phase), `message`, `elapsedMs` |
| **`complete`** | Final result — contains full `OrchestratorResult` |
| **`error`** | Something went wrong |

**Possible `stage` values:**
| Stage | Meaning |
|-------|---------|
| `pre-detection` | Checking if the site has anti-bot protection (Cloudflare, etc.) |
| `cache-check` | Checking if we already know this site is protected |
| `attempt-1-muffet` | Running fast muffet scan |
| `attempt-2-deep-crawl-standard` | Running standard browser crawl |
| `attempt-3-deep-crawl-bypass` | Running stealth browser crawl |
| `completed` | All done! |
| `failed` | All methods failed |

### ✅ JavaScript Example

```javascript
const response = await fetch(
  'https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/orchestrator/stream?url=https://example.com',
  { headers: { 'x-api-key': 'your-secret-key-here' } }
);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let currentEvent = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      
      if (currentEvent === 'progress') {
        console.log(`[${data.stage}] ${data.message}`);
      } else if (currentEvent === 'complete') {
        console.log('Final result:', data);
      } else if (currentEvent === 'error') {
        console.error('Error:', data.error);
      }
    }
  }
}
```

---

## 🤖 5. AI Brand Visibility Check

Check how often a company or brand appears in AI search results. The system:
1. Generates 5 search queries based on the business category + location
2. Runs each query through an AI model's web search
3. Detects if the company is mentioned
4. Calculates a visibility score and grade

### Request

```
POST https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/citation/check
```

**Headers:**
```http
Content-Type: application/json
x-api-key: your-secret-key-here
```

**Body (JSON):**
```json
{
  "companyName": "Roto-Rooter",
  "companyDomain": "rotorooter.com",
  "category": "Emergency Plumber",
  "location": "Atlanta",
  "model": "openai"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `companyName` | `string` | ✅ Yes | — | The business name to search for |
| `category` | `string` | ✅ Yes | — | Business type (e.g. `"Emergency Plumber"`, `"Dentist"`, `"Pizza Restaurant"`) |
| `location` | `string` | ✅ Yes | — | City or area (e.g. `"Atlanta"`, `"Los Angeles"`) |
| `companyDomain` | `string` | ❌ No | `""` | Website domain for additional matching (e.g. `"rotorooter.com"`) |
| `model` | `string` | ❌ No | `"openai"` | AI model to use. Options: `"openai"` (working), `"claude"` (coming soon), `"gemini"` (coming soon) |

### Success Response (200)

```json
{
  "success": true,
  "request": {
    "companyName": "Roto-Rooter",
    "companyDomain": "rotorooter.com",
    "category": "Emergency Plumber",
    "location": "Atlanta",
    "model": "openai"
  },
  "score": {
    "mentionRate": 80,
    "averagePosition": 2.5,
    "grade": "Excellent",
    "totalQueries": 5,
    "mentions": 4
  },
  "details": [
    {
      "query": "Emergency Plumber in Atlanta",
      "mentioned": true,
      "position": 1,
      "context": "Here are some emergency plumbers in Atlanta: 1. Roto-Rooter..."
    },
    {
      "query": "best plumber Atlanta",
      "mentioned": false,
      "position": null,
      "context": null
    }
  ],
  "rawResponses": [
    {
      "query": "Emergency Plumber in Atlanta",
      "text": "Here are some emergency plumbers in Atlanta: 1. Roto-Rooter...",
      "citations": [
        { "url": "https://www.rotorooter.com/", "title": "Roto-Rooter" }
      ],
      "model": "openai"
    }
  ]
}
```

### Response Fields

#### `score` Object — Visibility Summary

| Field | Type | Description |
|-------|------|-------------|
| `mentionRate` | `number` | Percentage (0–100) of queries where the company appeared |
| `averagePosition` | `number\|null` | Average position in search listings (lower = better). `null` if never mentioned. |
| `grade` | `string` | Visibility grade: `"Excellent"` 🟢, `"Good"` 🟡, `"Weak"` 🟠, or `"Not Visible"` 🔴 |
| `totalQueries` | `number` | Total queries run (always 5) |
| `mentions` | `number` | Number of queries where the company was found |

#### Grade Meaning

| Grade | What it means |
|-------|--------------|
| **Excellent** 🟢 | ≥75% mention rate AND average position ≤ 3 |
| **Good** 🟡 | ≥50% mention rate |
| **Weak** 🟠 | ≥25% mention rate |
| **Not Visible** 🔴 | <25% mention rate — the brand rarely appears |

#### `details[]` — Per-Query Results

| Field | Type | Description |
|-------|------|-------------|
| `query` | `string` | The search query that was used |
| `mentioned` | `boolean` | Was the company found in the response? |
| `position` | `number\|null` | Position in the listing if applicable |
| `context` | `string\|null` | Surrounding text showing where the match was found |

### ✅ JavaScript Example

```javascript
const response = await fetch('https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/citation/check', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'your-secret-key-here'
  },
  body: JSON.stringify({
    companyName: 'Roto-Rooter',
    category: 'Emergency Plumber',
    location: 'Atlanta'
  })
});

const data = await response.json();
console.log(`Grade: ${data.score.grade}`);
console.log(`Mention rate: ${data.score.mentionRate}%`);
console.log(`Found in ${data.score.mentions} out of ${data.score.totalQueries} searches`);
```

---

## ❤️ 6. Health Check

No authentication required. Quick way to confirm the server is running.

```
GET https://fvncgcoa9vsibc5t-free-app.stackhost.org/api/health
```

**Response (200):**
```json
{
  "status": "ok",
  "timestamp": "2025-07-17T06:30:00.000Z"
}
```

---

## ⚠️ Error Handling

All endpoints return errors in a consistent format:

```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

### Common HTTP Status Codes

| Code | Meaning | What to do |
|------|---------|------------|
| **200** | Success | Parse and use the response data |
| **400** | Bad Request | Check your request body/parameters — missing or invalid fields |
| **401** | Unauthorized | Missing `x-api-key` header |
| **403** | Forbidden | Invalid API key |
| **429** | Rate Limited | Too many requests. Wait and retry. |
| **500** | Server Error | Something went wrong on the server — retry later |

### Rate Limiting

- **Normal load:** 30 requests per hour per IP
- **Server is busy:** 5 requests per hour per IP
- The `POST /api/citation/check` endpoint does NOT have rate limiting

---

## 🚀 Quick Start Checklist

1. ✅ Get the API key from the backend team
2. ✅ Test with Health Check: `GET /api/health`
3. ✅ Test authentication: `POST /api/muffet/crawl` with a test URL
4. ✅ Parse the results and display link statuses in your UI
5. ✅ For real-time progress, use the SSE streaming endpoints

---

## 📊 Response Summary Table

| Endpoint | Returns | Best For |
|----------|---------|----------|
| `POST /api/muffet/crawl` | Full JSON with all results | Simple integration, backend calls |
| `GET /api/muffet/stream` | SSE event stream (live) | Progress bars, live dashboards |
| `POST /api/orchestrator/crawl` | Full JSON with attempt log | When you want auto-best-method |
| `GET /api/orchestrator/stream` | SSE with named events | Live progress with smart crawl |
| `POST /api/citation/check` | Full JSON with score + details | Brand visibility checking |
