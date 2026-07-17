# 📚 SEO Utilities API — Complete API Documentation

> **Base URL:** `http://localhost:3000` (configurable via `PORT` env var)
>
> **Project:** `D:\React\seo-utilities-api`
>
> **Deployment:** StackHost free tier — see [StackHost Deployment](#stackhost-deployment)

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Rate Limiting](#rate-limiting)
4. [Health Check](#health-check)
5. [Muffet Crawler APIs](#muffet-crawler-apis)
   - [POST /api/muffet/crawl](#post-apimuffetcrawl)
   - [GET /api/muffet/stream](#get-apimuffetstream)
6. [Smart Crawl Orchestrator API](#smart-crawl-orchestrator-api)
   - [POST /api/orchestrator/crawl](#post-apiorchestratorcrawl)
   - [GET /api/orchestrator/stream](#get-apiorchestratorstream)
   - [GET /api/orchestrator/stats](#get-apiorchestratorstats)
7. [AI Citation Tracker API](#ai-citation-tracker-api)
   - [POST /api/citation/check](#post-apicitationcheck)
8. [Error Handling](#error-handling)
9. [Internal Architecture](#internal-architecture)
10. [External Binary: muffet](#external-binary-muffet)
    - [Binary Installation](#binary-installation)
    - [Build Chain](#build-chain)
    - [Flag Syntax](#flag-syntax)
11. [StackHost Deployment](#stackhost-deployment)
12. [Appendix: Types & Interfaces](#appendix-types--interfaces)
13. [Environment Variables](#environment-variables)
14. [Project Structure](#project-structure)

---

## Overview

This API combines **three SEO utilities** into a single Express.js server:

| Feature | Description | Route Prefix |
|---------|-------------|--------------|
| 🔗 **Muffet Crawler** | Fast website link-checking using the Go-based [`muffet`](https://github.com/raviqqe/muffet) CLI tool. Crawls a website and returns all linked URLs with HTTP status codes. Supports both JSON (POST) and real-time SSE streaming (GET). | `/api/muffet` |
| 🧠 **Smart Crawl Orchestrator** | Higher-level crawl orchestrator that coordinates multi-page crawling with real-time SSE progress and client-disconnect cancellation via `AbortController`. | `/api/orchestrator` |
| 🤖 **AI Citation Tracker** | AI-powered brand visibility analysis. Generates search query variations from a category + location, runs them through an AI model's web search capability, parses responses to detect company mentions, and produces a visibility score/grade. | `/api/citation` |

**Tech Stack:**
- **Runtime:** Node.js ≥ 18 (TypeScript, ESM)
- **Framework:** Express 5.x
- **External CLI:** [`muffet`](https://github.com/raviqqe/muffet) v2.11.5 (Go binary, installed to project-local `./bin/muffet`)
- **AI Providers:** OpenAI (implemented), Anthropic Claude (stub), Google Gemini (stub)

---

## Authentication

**All API endpoints** (except `/api/health`) require authentication via the `x-api-key` header.

The expected key value is read from the [`CRAWLER_API_KEY`](D:\React\seo-utilities-api\.env.example:13) environment variable.

### How it works

[`src/middleware/auth.ts`](D:\React\seo-utilities-api\src\middleware\auth.ts) — [`apiKeyAuth()`](D:\React\seo-utilities-api\src\middleware\auth.ts:12)

1. The server checks if `CRAWLER_API_KEY` is set and not the placeholder `change-me-to-a-random-secret`.
2. If misconfigured → **503 Service Unavailable** with misconfiguration error.
3. Client must send `x-api-key` header matching the configured key.
4. If header missing → **401 Unauthorized**.
5. If key mismatch → **403 Forbidden**.

### Example

```bash
curl -H "x-api-key: your-secret-key" http://localhost:3000/api/muffet/crawl
```

---

## Rate Limiting

The Muffet crawl endpoints and Orchestrator endpoints have an **adaptive rate limiter** implemented via [`express-rate-limit`](D:\React\seo-utilities-api\src\server.ts:75).

### Load Detection Logic

[`isServerBusy()`](D:\React\seo-utilities-api\src\server.ts:49) determines server load based on:

| Condition | Load |
|-----------|------|
| **2+** concurrent crawl requests active | 🟠 High |
| **3+** unique IPs hit the crawl endpoint in the last **60 seconds** | 🟠 High |
| Otherwise | 🟢 Low |

### Dynamic Limits

| Load | Limit (per IP per hour) |
|------|------------------------|
| 🟢 Low | **30** requests/hour |
| 🟠 High | **5** requests/hour |

> The Citation API (`/api/citation/*`) does **not** have rate limiting.

---

## Health Check

```
GET /api/health
```

No authentication required. Returns server status and current timestamp.

### Response `200 OK`

```json
{
  "status": "ok",
  "timestamp": "2025-07-17T06:30:00.000Z"
}
```

### Source

[`src/server.ts:106`](D:\React\seo-utilities-api\src\server.ts:106)

---

## Muffet Crawler APIs

### POST `/api/muffet/crawl`

Start a muffet crawl and wait for the complete JSON result. The response is returned only after the full crawl finishes.

#### Request Body

```json
{
  "url": "https://books.toscrape.com",
  "concurrency": 10,
  "internalOnly": true,
  "excludeAssets": true
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | `string` | ✅ Yes | — | Website URL to crawl (must start with `http://` or `https://`) |
| `concurrency` | `number` | ❌ No | `5` | Number of parallel requests (higher = faster, but more load on target) |
| `internalOnly` | `boolean` | ❌ No | `true` | If `true`, only checks URLs on the same hostname (excludes external links) |
| `excludeAssets` | `boolean` | ❌ No | `true` | If `true`, filters out CSS, JS, images, fonts, WP paths, feeds from results |

#### Response `200 OK`

```json
{
  "success": true,
  "engine": "muffet",
  "totalPages": 42,
  "durationSec": 3.21,
  "results": [
    { "url": "https://books.toscrape.com/", "status": 200, "timeMs": 120 },
    { "url": "https://books.toscrape.com/catalogue/", "status": 200, "timeMs": 95 }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | `true` if crawl produced results |
| `engine` | `string` | Always `"muffet"` |
| `totalPages` | `number` | Number of page URLs found |
| `durationSec` | `number` | Total crawl duration in seconds |
| `results[]` | `array` | Array of crawled URLs with status codes |

**`results[]` item:**

| Field | Type | Description |
|-------|------|-------------|
| `url` | `string` | The crawled URL |
| `status` | `number` | HTTP status code (200, 301, 404, 0 if error, etc.) |
| `timeMs` | `number\|null` | Response time in milliseconds (may be `null`) |

#### Error Response `4xx/5xx`

```json
{
  "success": false,
  "engine": "muffet",
  "totalPages": 0,
  "results": [],
  "durationSec": 0.12,
  "error": "Description of what went wrong",
  "errorType": "validation_error"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `error` | `string` | Human-readable error description |
| `errorType` | `string` | One of: `"timeout"`, `"process_error"`, `"parse_error"`, `"validation_error"` |

#### cURL Example

```bash
curl -X POST http://localhost:3000/api/muffet/crawl \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{"url": "https://books.toscrape.com"}'
```

#### Source

[`src/routes/muffet.routes.ts:330`](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:330)

#### Internal Flow

1. **[URL Validation](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:55)** — Validates URL format via `isValidUrl()`.
2. **[Semaphore Acquisition](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:29)** — Acquires a concurrency slot (max **2** concurrent muffet processes). If at capacity, the request is queued.
3. **[Crawl Execution](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:355)** — Calls [`MuffetCrawler.crawl()`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:282) which:
   - Sanitizes the URL ([`sanitizeUrl()`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:73)) — blocks shell metacharacters.
   - Builds include/exclude regex patterns for muffet's `--include` / `--exclude` flags.
   - Executes muffet via [`execFile()`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:331) (safe — no shell invocation) with JSON output format.
   - Parses muffet's JSON output ([`parseMuffetOutput()`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:509)) — handles both array and tree JSON formats.
   - Post-filters results (internal hostname check + asset exclusion as safety net).
4. **[Semaphore Release](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:364)** — Releases the slot, waking any queued request.
5. **[Response](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:367)** — Returns the parsed `MuffetCrawlResponse`.

---

### GET `/api/muffet/stream`

Receive crawl progress in real-time via **Server-Sent Events (SSE)**. The response is a continuous stream of events rather than a single JSON payload.

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | `string` | ✅ Yes | — | Website URL to crawl (must be URL-encoded) |
| `internalOnly` | `boolean` | ❌ No | `true` | If `false`, checks ALL links including external |
| `excludeAssets` | `boolean` | ❌ No | `true` | If `false`, includes asset URLs in results |

#### SSE Event Format

Each event is a `data:` line followed by a JSON payload and double newline:

```
data: {"type":"start","url":"https://books.toscrape.com","message":"Muffet crawl started","timestamp":1712345678000}

data: {"type":"progress","url":"https://books.toscrape.com/catalogue/","urlsChecked":5,"elapsedSec":1.23}

data: {"type":"result","url":"https://books.toscrape.com/catalogue/","status":200,"urlsChecked":5}

data: {"type":"complete","success":true,"exitCode":0,"totalPages":42,"results":[...],"urlsChecked":50,"elapsedSec":3.21,"message":"Crawl completed successfully"}
```

#### Event Types

| Event | Description | Payload Fields |
|-------|-------------|----------------|
| **`start`** | Crawl has started | `url`, `message`, `timestamp` |
| **`progress`** | A URL is being checked (fires for each URL visited) | `url` (current URL), `urlsChecked` (count), `elapsedSec` |
| **`result`** | A link has been checked with its HTTP status | `url`, `status`, `urlsChecked` |
| **`complete`** | Crawl finished successfully (or with errors) | `success`, `exitCode`, `totalPages`, `results[]`, `urlsChecked`, `elapsedSec`, `message` |
| **`error`** | A fatal error occurred | `error` (message), `errorType` |

#### cURL Example

```bash
curl -N -H "x-api-key: your-secret-key" \
  "http://localhost:3000/api/muffet/stream?url=https://books.toscrape.com"
```

> The `-N` flag disables curl's output buffering, which is necessary for SSE.

#### Source

[`src/routes/muffet.routes.ts:94`](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:94)

#### Internal Flow

1. **[URL Validation](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:101)** — Validates URL format.
2. **[Semaphore Acquisition](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:112)** — Acquires concurrency slot (max 2).
3. **[SSE Headers](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:115)** — Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, etc. Disables socket timeout.
4. **[Spawn muffet](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:175)** — Calls [`MuffetCrawler.spawnStream()`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:462) which uses [`spawn()`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:475) with verbose human-readable output (not JSON).
5. **[Parse stdout line-by-line](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:182)** — Each chunk is split into lines:
   - Non-tab lines → URL being checked → emits `progress` event.
   - Tab-indented lines (`\t200\thttps://...`) → result entry → emits `result` event.
6. **[On process close](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:228)** — Post-processes results (internal-only + asset filtering), emits `complete` event, ends response.
7. **[Cleanup](D:\React\seo-utilities-api\src\routes\muffet.routes.ts:128)** — If client disconnects, kills the muffet child process and releases the semaphore slot.

---

### POST vs GET — Which to use?

| Criteria | `POST /api/muffet/crawl` | `GET /api/muffet/stream` |
|----------|-------------------------|--------------------------|
| Response style | Single JSON response | Real-time SSE stream |
| Use case | Simple integration, server-side calls | Progress bars, live dashboards |
| Output format | JSON (muffet `-f json` flag) | Verbose human-readable (parsed) |
| Client complexity | Low | Medium (SSE parser needed) |

---

## Smart Crawl Orchestrator API

The Orchestrator provides a higher-level crawl API built on top of [`SmartCrawlOrchestrator`](D:\React\seo-utilities-api\src\core\SmartCrawlOrchestrator.ts). Unlike the raw muffet endpoints, the orchestrator:

- Supports **client-disconnect cancellation** via `AbortController` — if the client closes the connection, the crawl is aborted immediately.
- Sends **named SSE events** (`event: progress`, `event: complete`, `event: error`) for cleaner client-side parsing.
- Includes a **cache stats** endpoint for monitoring the internal [`ProtectionCache`](D:\React\seo-utilities-api\src\core\ProtectionCache.ts).

All orchestrator endpoints are mounted at `/api/orchestrator` and share the same auth (`x-api-key`), rate limiting, and load tracking as the muffet endpoints.

### POST `/api/orchestrator/crawl`

Trigger a smart crawl and wait for the complete JSON result. The orchestrator uses `AbortController` internally so the crawl can be cancelled, but the POST endpoint waits for the full result before responding.

#### Request Body

```json
{
  "url": "https://example.com"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | `string` | ✅ Yes | — | Website URL to crawl (must start with `http://` or `https://`) |

#### Response `200 OK`

```json
{
  "success": true,
  "results": [...],
  "totalUrls": 42,
  "durationMs": 3210
}
```

> The exact response shape depends on the [`SmartCrawlOrchestrator`](D:\React\seo-utilities-api\src\core\SmartCrawlOrchestrator.ts) implementation. See the source for the full `OrchestratorResult` type.

#### Error Response `4xx/5xx`

```json
{
  "success": false,
  "error": "Orchestrator error: Description of what went wrong"
}
```

#### cURL Example

```bash
curl -X POST http://localhost:3000/api/orchestrator/crawl \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{"url": "https://example.com"}'
```

#### Source

[`src/routes/orchestrator.routes.ts:24`](D:\React\seo-utilities-api\src\routes\orchestrator.routes.ts:24)

---

### GET `/api/orchestrator/stream`

Receive orchestrator crawl progress in real-time via **Server-Sent Events (SSE)** with named events. Unlike the muffet SSE endpoint, this uses `event:` fields for cleaner client-side event handling.

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | `string` | ✅ Yes | — | Website URL to crawl (must be URL-encoded) |

#### SSE Event Format

Each event uses named SSE event fields:

```
:ok

event: progress
data: {"url":"https://example.com/page1","urlsChecked":5,"elapsedMs":1230}

event: complete
data: {"success":true,"results":[...],"totalUrls":42,"durationMs":3210}

event: error
data: {"success":false,"error":"Description of what went wrong"}
```

#### Event Types

| Event | Description | Payload Fields |
|-------|-------------|----------------|
| **`:ok`** (comment) | Connection confirmed | No data — comment line sent immediately on connect |
| **`progress`** | Crawl progress update | `url` (current URL), `urlsChecked` (count), `elapsedMs` |
| **`complete`** | Crawl finished successfully | `success`, `results[]`, `totalUrls`, `durationMs` |
| **`error`** | A fatal error occurred | `success`, `error` (message) |

#### Client Disconnect Handling

When the client disconnects (closes the connection), the server:
1. Calls `abortController.abort()` to cancel the crawl immediately.
2. Cleans up the active controller from the internal `Map`.

This prevents orphaned crawl processes from consuming resources.

#### cURL Example

```bash
curl -N -H "x-api-key: your-secret-key" \
  "http://localhost:3000/api/orchestrator/stream?url=https://example.com"
```

#### Source

[`src/routes/orchestrator.routes.ts:82`](D:\React\seo-utilities-api\src\routes\orchestrator.routes.ts:82)

---

### GET `/api/orchestrator/stats`

Retrieve cache statistics from the internal [`ProtectionCache`](D:\React\seo-utilities-api\src\core\ProtectionCache.ts). Useful for monitoring cache hit rates and memory usage.

#### Response `200 OK`

```json
{
  "success": true,
  "cache": {
    "size": 150,
    "hits": 1200,
    "misses": 300,
    "hitRate": 0.8
  }
}
```

> The exact cache stats shape depends on the [`ProtectionCache.getStats()`](D:\React\seo-utilities-api\src\core\ProtectionCache.ts) implementation.

#### cURL Example

```bash
curl -H "x-api-key: your-secret-key" \
  "http://localhost:3000/api/orchestrator/stats"
```

#### Source

[`src/routes/orchestrator.routes.ts:170`](D:\React\seo-utilities-api\src\routes\orchestrator.routes.ts:170)

---

## AI Citation Tracker API

### POST `/api/citation/check`

Check how often a company/brand appears in AI-generated search results. The system:

1. Generates **5 search query variations** from a category + location pair.
2. Runs each query through the selected **AI model's web search** capability.
3. **Parses** each response to detect company mentions using fuzzy matching.
4. **Scores** the results and assigns a visibility grade.

#### Request Body

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
| `companyName` | `string` | ✅ Yes | — | Company/brand name to search for |
| `category` | `string` | ✅ Yes | — | Business category (e.g. `"Emergency Plumber"`, `"Dentist"`, `"Pizza Restaurant"`) |
| `location` | `string` | ✅ Yes | — | City or area (e.g. `"Atlanta"`, `"Los Angeles"`) |
| `companyDomain` | `string` | ❌ No | `""` | Company domain for additional fuzzy matching (e.g. `"rotorooter.com"`) |
| `model` | `string` | ❌ No | `"openai"` | AI model provider. Supported values: `"openai"`, `"claude"`, `"gemini"` |

> **Note:** Only `"openai"` is fully implemented. `"claude"` and `"gemini"` return **501 Not Implemented**.

#### Response `200 OK`

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
    }
  ],
  "rawResponses": [
    {
      "query": "Emergency Plumber in Atlanta",
      "text": "Here are some emergency plumbers...",
      "citations": [
        { "url": "https://www.rotorooter.com/", "title": "Roto-Rooter" }
      ],
      "model": "openai"
    }
  ]
}
```

##### `score` Object

| Field | Type | Description |
|-------|------|-------------|
| `mentionRate` | `number` | Percentage of queries where the company appeared (0–100) |
| `averagePosition` | `number\|null` | Average list position across mentions (lower = better). `null` if never mentioned. |
| `grade` | `string` | Visibility grade (see table below) |
| `totalQueries` | `number` | Total number of query variations run (always 5) |
| `mentions` | `number` | Count of queries where company was found |

##### `details[]` Item

| Field | Type | Description |
|-------|------|-------------|
| `query` | `string` | The search query used |
| `mentioned` | `boolean` | Whether the company was detected in the response |
| `position` | `number\|null` | List position if the company appeared in a numbered/bulleted list |
| `context` | `string\|null` | Surrounding text (~400 chars before and after the match) |

##### `rawResponses[]` Item

| Field | Type | Description |
|-------|------|-------------|
| `query` | `string` | The search query |
| `text` | `string` | Full raw AI response text |
| `citations[]` | `array` | Source URLs returned by the AI (OpenAI web_search citations) |
| `model` | `string` | Model name used |

#### Visibility Grades

| Grade | Color | Condition |
|-------|-------|-----------|
| **Excellent** | 🟢 | ≥75% mention rate AND average position ≤ 3 |
| **Good** | 🟡 | ≥50% mention rate |
| **Weak** | 🟠 | ≥25% mention rate |
| **Not Visible** | 🔴 | <25% mention rate |

#### cURL Example

```bash
curl -X POST http://localhost:3000/api/citation/check \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{
    "companyName": "Roto-Rooter",
    "category": "Emergency Plumber",
    "location": "Atlanta"
  }'
```

#### Source

[`src/routes/citation.routes.ts:47`](D:\React\seo-utilities-api\src\routes\citation.routes.ts:47)

#### Internal Flow (Step-by-Step)

##### Step 1: Validation

[`src/routes/citation.routes.ts:26`](D:\React\seo-utilities-api\src\routes\citation.routes.ts:26) — [`validateBody()`](D:\React\seo-utilities-api\src\routes\citation.routes.ts:26) checks that `companyName`, `category`, and `location` are present and are strings. If validation fails → **400 Bad Request**.

##### Step 2: Provider Resolution

[`src/services/aiProvider.ts:75`](D:\React\seo-utilities-api\src\services\aiProvider.ts:75) — [`createProvider()`](D:\React\seo-utilities-api\src\services\aiProvider.ts:75) factory function selects the AI provider instance:

| Model String | Provider Class | Source |
|--------------|---------------|--------|
| `"openai"` | [`OpenAIProvider`](D:\React\seo-utilities-api\src\providers\openaiProvider.ts:12) | ✅ Implemented — uses `gpt-4o` with `web_search_preview` tool |
| `"claude"` | [`ClaudeProvider`](D:\React\seo-utilities-api\src\providers\claudeProvider.ts:19) | 🔧 Stub — returns **501** |
| `"gemini"` | [`GeminiProvider`](D:\React\seo-utilities-api\src\providers\geminiProvider.ts:18) | 🔧 Stub — returns **501** |

All providers extend the abstract [`AIProvider`](D:\React\seo-utilities-api\src\services\aiProvider.ts:34) base class which requires implementing [`runWebSearch(query)`](D:\React\seo-utilities-api\src\services\aiProvider.ts:44).

##### Step 3: Query Variation Generation

[`src/services/promptVariationGenerator.ts:16`](D:\React\seo-utilities-api\src\services\promptVariationGenerator.ts:16) — [`generateQueryVariations()`](D:\React\seo-utilities-api\src\services\promptVariationGenerator.ts:16)

Given `category = "Emergency Plumber"` and `location = "Atlanta"`, generates up to 5 variations:

| # | Query Pattern | Example |
|---|---------------|---------|
| 1 | `{category} in {location}` | `"Emergency Plumber in Atlanta"` |
| 2 | `Best {category} in {location}` | `"Best Emergency Plumber in Atlanta"` |
| 3 | `Top-rated {category} near {location}` | `"Top-rated Emergency Plumber near Atlanta"` |
| 4 | `{category} {location} reviews` | `"Emergency Plumber Atlanta reviews"` |
| 5 | `Affordable {category} {location}` | `"Affordable Emergency Plumber Atlanta"` |
| 6 | `{location} {category} services` | `"Atlanta Emergency Plumber services"` |
| 7 | `Who offers {category} in {location}?` | `"Who offers emergency plumber in Atlanta?"` |

> Uses a `Set` to deduplicate, then limits to **5** queries.

##### Step 4: AI Web Search Execution

**OpenAI Provider** — [`src/providers/openaiProvider.ts:35`](D:\React\seo-utilities-api\src\providers\openaiProvider.ts:35) — [`runWebSearch()`](D:\React\seo-utilities-api\src\providers\openaiProvider.ts:35)

- Uses the **OpenAI Responses API** with `model: "gpt-4o"`.
- Enables the [`web_search_preview`](D:\React\seo-utilities-api\src\providers\openaiProvider.ts:42) tool with `user_location: { country: "US" }`.
- Temperature set to **0.3** for more consistent/less creative results.
- Extracts `output_text` and `url_citation` annotations from the response.
- Returns a [`WebSearchResult`](D:\React\seo-utilities-api\src\services\aiProvider.ts:17) object.

> Each query is run sequentially with a **500ms delay** between calls to avoid rate-limiting.

##### Step 5: Response Parsing

[`src/services/parser.ts:137`](D:\React\seo-utilities-api\src\services\parser.ts:137) — [`parseResponse()`](D:\React\seo-utilities-api\src\services\parser.ts:137)

For each AI response, the parser:

1. **Normalizes** the text ([`normalize()`](D:\React\seo-utilities-api\src\services\parser.ts:30)) — lowercases, strips punctuation, collapses whitespace.
2. **Exact match** — checks if normalized company name appears in normalized text.
3. **Fuzzy match** ([`fuzzyMatch()`](D:\React\seo-utilities-api\src\services\parser.ts:42)) — if exact match fails:
   - Checks if the domain slug (e.g. `"rotorooter"`) appears in text.
   - Splits company name into significant words (skipping common words like "the", "and", "a").
   - Requires ≥60% of significant words to match.
4. **Position detection** ([`detectListPosition()`](D:\React\seo-utilities-api\src\services\parser.ts:73)) — looks for numbered lists (`1.`, `2.`) or bullet lists (`•`, `-`, `*`) near the match.
5. **Context extraction** ([`extractContext()`](D:\React\seo-utilities-api\src\services\parser.ts:105)) — extracts ~400 characters around the match, cleaned at sentence boundaries.

Returns a [`ParsedResult`](D:\React\seo-utilities-api\src\services\parser.ts:17) for each query.

##### Step 6: Scoring

[`src/services/scoring.ts:27`](D:\React\seo-utilities-api\src\services\scoring.ts:27) — [`calculateScore()`](D:\React\seo-utilities-api\src\services\scoring.ts:27)

Aggregates all parsed results:

- **Mention Rate** = (mentioned queries / total queries) × 100
- **Average Position** = mean of all non-null positions from mentions
- **Grade** determined by thresholds (see [grade table](#visibility-grades) above)

Returns a [`ScoreResult`](D:\React\seo-utilities-api\src\services\scoring.ts:14) object.

---

## Error Handling

### Global Error Middleware

[`src/middleware/errorHandler.ts:9`](D:\React\seo-utilities-api\src\middleware\errorHandler.ts:9) — [`errorHandler()`](D:\React\seo-utilities-api\src\middleware\errorHandler.ts:9)

Catches all unhandled errors and returns a consistent JSON shape:

```json
{
  "success": false,
  "error": {
    "message": "Description of the error",
    "stack": "..."  // only included in non-production environments
  }
}
```

### Error Types by Endpoint

| HTTP Status | Meaning | Common Causes |
|-------------|---------|---------------|
| **400** | Bad Request | Missing/invalid fields, invalid URL format, invalid model name |
| **401** | Unauthorized | Missing `x-api-key` header |
| **403** | Forbidden | Invalid API key |
| **429** | Too Many Requests | Rate limit exceeded (Muffet & Orchestrator endpoints only) |
| **500** | Internal Server Error | Process crashes, parsing failures, unexpected errors |
| **501** | Not Implemented | Claude/Gemini provider (stub) |
| **503** | Service Unavailable | `CRAWLER_API_KEY` not configured |

### Custom Error Classes

| Class | Source | Used For |
|-------|--------|----------|
| [`ProviderError`](D:\React\seo-utilities-api\src\services\aiProvider.ts:56) | `aiProvider.ts` | AI provider failures (invalid keys, unsupported models) |
| [`MuffetError`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:256) | `MuffetCrawler.ts` | Muffet process errors (timeout, injection, parse failure) |

---

## Internal Architecture

### Server Setup

[`src/server.ts`](D:\React\seo-utilities-api\src\server.ts)

```
app.use(cors(corsOptions))
app.use(express.json({ limit: '1mb' }))

GET  /api/health              → health check (no auth)

POST /api/muffet/crawl        → apiKeyAuth → trackActiveRequests → crawlLimiter → muffetRouter
GET  /api/muffet/stream       → apiKeyAuth → trackActiveRequests → crawlLimiter → muffetRouter

POST /api/orchestrator/crawl  → apiKeyAuth → trackActiveRequests → crawlLimiter → orchestratorRouter
GET  /api/orchestrator/stream → apiKeyAuth → trackActiveRequests → crawlLimiter → orchestratorRouter
GET  /api/orchestrator/stats  → apiKeyAuth → trackActiveRequests → crawlLimiter → orchestratorRouter

POST /api/citation/check      → apiKeyAuth → citationRouter

app.use(errorHandler)         ← global error handler (last)
```

### Middleware Chain

| Middleware | Source | Purpose |
|-----------|--------|---------|
| `cors()` | Express | CORS with configurable origins from `ALLOWED_ORIGINS` env var |
| `express.json()` | Express | JSON body parser (1MB limit) |
| [`apiKeyAuth`](D:\React\seo-utilities-api\src\middleware\auth.ts:12) | `auth.ts` | Validates `x-api-key` header against `CRAWLER_API_KEY` |
| [`trackActiveRequests`](D:\React\seo-utilities-api\src\server.ts:63) | `server.ts` | Increments/decrements active crawl counter for load-sensing |
| [`crawlLimiter`](D:\React\seo-utilities-api\src\server.ts:76) | `server.ts` | Adaptive rate limiter (5 or 30 req/hr based on load) |
| [`errorHandler`](D:\React\seo-utilities-api\src\middleware\errorHandler.ts:9) | `errorHandler.ts` | Global catch-all error → JSON response |

### Concurrency Control (Muffet)

The muffet endpoints implement a **semaphore pattern** to limit concurrent muffet processes:

- Max **2** concurrent muffet processes.
- If at capacity, requests are **queued** (FIFO).
- When a process finishes, the next queued request is woken (slot is transferred directly without incrementing the counter).

### Muffet Output Parsing

The `MuffetCrawler` class handles **two JSON formats** from muffet v2.x:

**Format A — Simple Array (older muffet):**
```json
[{"url":"https://...", "status":200, "time_ms":123}, ...]
```

**Format B — Tree Format (muffet v2.11+):**
```json
[{"url":"https://...", "links":[{"url":"https://...", "error":"..."}]}, ...]
```

[`parseMuffetOutput()`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:509) detects and handles both formats transparently, with a JSON-Lines fallback.

### Asset Exclusion System

A **two-layer** approach filters out non-page URLs:

1. **Muffet-level:** Regex passed via `--exclude` flag so muffet skips checking asset URLs entirely.
2. **Post-processing:** [`filterPageRoutes()`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:241) runs on parsed results as a safety net, removing:
   - Static assets: CSS, JS, images, fonts, data files, sourcemaps
   - WordPress paths: `wp-json`, `wp-content`, `wp-includes`, `wp-admin`
   - WordPress system files: `xmlrpc.php`
   - Feed URLs: `/feed`, `/comments/feed`
   - Duplicate URLs with different fragments (deduplication via [`deduplicateResults()`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:223))

---

## External Binary: muffet

The project depends on the [`muffet`](https://github.com/raviqqe/muffet) Go binary (v2.11.5) for link-checking. Because this is a compiled Go binary (not an npm package), it must be downloaded and installed separately.

### Binary Installation

The binary is installed at **build time** by the [`install-muffet.mjs`](D:\React\seo-utilities-api\install-muffet.mjs) script. Here's how it works:

1. **Download** — Uses `fetch()` (native Node.js) to download `muffet_linux_amd64.tar.gz` from the GitHub release. `fetch()` natively follows HTTP redirects (unlike `https.get()`), which is critical because GitHub release URLs redirect multiple times to CloudFront CDN.

2. **Checksum Verification** — Computes SHA256 of the downloaded archive and compares it against both:
   - A hardcoded expected hash: `64d4db266f308ea7136fe8060a5061bc8a4eea3be5e36350f94a4fcea45309d2`
   - The remote `checksums.txt` from the GitHub release (as a secondary source of truth)
   
   If the checksums don't match, the installation fails with a clear error message.

3. **Extraction** — Uses Node.js `zlib.createGunzip()` + the `tar` npm package to extract the archive. Streams are piped through [`pipeline()`](https://nodejs.org/api/stream.html#streampipeline) from `stream/promises` for proper backpressure handling.

4. **Install** — Copies the binary to **`./bin/muffet`** (project-local, not `/usr/local/bin/`). This path is writable by non-root users, which is essential on StackHost's sandboxed build containers where `/usr/local/bin/` is write-protected.

5. **Verify** — Runs `muffet --version` to confirm the binary executes correctly and reports the expected version.

6. **Cleanup** — Removes temporary files (downloaded tarball, extracted directory).

#### Why project-local `./bin/muffet`?

StackHost's sandboxed build environment runs as a **non-root user** and write-protects `/usr/local/bin/`. Installing to a project-local `bin/` directory:

- ✅ Works on StackHost (and any CI/CD environment)
- ✅ Avoids permission issues (`EACCES`)
- ✅ Keeps the binary scoped to the project (no global `$PATH` pollution)
- ✅ The `bin/` directory is listed in [`.gitignore`](D:\React\seo-utilities-api\.gitignore:3) so it's not committed to the repository

### Build Chain

The full build chain is defined in [`package.json`](D:\React\seo-utilities-api\package.json:8) and [`stackhost.yaml`](D:\React\seo-utilities-api\stackhost.yaml:6):

```
npm install                  → Install npm dependencies (tar, typescript, express, etc.)
npm run install:muffet       → Run install-muffet.mjs (download + verify + install ./bin/muffet)
npm run build                → tsc -p tsconfig.json (compile TypeScript → dist/)
npm run start                → node dist/server.js
```

### Flag Syntax

Muffet is a **Go binary** and expects Unix-style flags with `-` (short) or `--` (long) prefix. The codebase previously used Windows-style `/` prefixes (e.g., `/c 10`, `/json`) which caused muffet to fail with "invalid number of arguments".

The current flag syntax is correct:

| Purpose | Short Flag | Long Flag |
|---------|-----------|-----------|
| Concurrency | `-c 10` | — |
| JSON output | `-f json` | — |
| Verbose output | — | `--verbose` |
| Page timeout | — | `--timeout 60` |
| Include pattern | — | `--include regex` |
| Exclude pattern | — | `--exclude regex` |

These flags are built in two places:

- [`crawl()` method](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:314) — for JSON output (`POST /api/muffet/crawl`): `-c`, `-f json`, `--timeout`, `--include`, `--exclude`
- [`buildArgs()` static method](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts:445) — for verbose output (`GET /api/muffet/stream`): `-c`, `--verbose`, `--timeout`, `--include`, `--exclude`

Both methods log the exact command via `console.log('[MUFFET]', binaryPath, JSON.stringify(args))` for debugging.

---

## StackHost Deployment

The project is configured for deployment on **StackHost's free tier** via [`stackhost.yaml`](D:\React\seo-utilities-api\stackhost.yaml).

### Configuration

```yaml
runtime:
  image: node:22

commands:
  package: ""
  build:
    - "npm install"
    - "npm run install:muffet"
    - "npm run build"
  start: "npm run start"

repository:
  branch: main
  auto_deploy: true
```

### Key Constraints

StackHost's free-tier sandbox has two important constraints that shaped this project's architecture:

| Constraint | Mitigation |
|-----------|------------|
| 🚫 **Disallowed system commands** (`tar`, `curl`, `chmod`, `mv`) | [`install-muffet.mjs`](D:\React\seo-utilities-api\install-muffet.mjs) uses only Node.js built-in modules (`fetch`, `zlib`, `crypto`, `fs`) plus the `tar` npm package. No shell commands needed. |
| 🚫 **`/usr/local/bin/` write-protected** (non-root user) | Binary installed to project-local `./bin/muffet` which is writable by any user. |

### Required Environment Variables

Set these in the StackHost dashboard or `.env` file:

| Variable | Required | Description |
|----------|----------|-------------|
| `CRAWLER_API_KEY` | ✅ Yes | API key for `x-api-key` authentication |
| `OPENAI_API_KEY` | ✅ Yes* | OpenAI API key (for citation check) |

> *Required only if using the citation-check endpoint with the OpenAI provider.

---

## Appendix: Types & Interfaces

### Muffet Types ([`src/core/MuffetCrawler.ts`](D:\React\seo-utilities-api\src\core\MuffetCrawler.ts))

```typescript
interface MuffetResult {
  url: string;
  status: number;
  timeMs?: number | null;
}

interface MuffetCrawlResponse {
  success: boolean;
  engine: 'muffet';
  totalPages: number;
  results: MuffetResult[];
  durationSec: number;
  error?: string;
  errorType?: 'timeout' | 'process_error' | 'parse_error' | 'validation_error';
}

interface MuffetCrawlerOptions {
  url: string;
  concurrency?: number;
  pageTimeout?: number;
  processTimeoutMs?: number;
  maxBuffer?: number;
  internalOnly?: boolean;
  excludeAssets?: boolean;
}
```

### Citation Types

```typescript
// src/services/aiProvider.ts
interface WebSearchResult {
  query: string;
  raw: string;
  citations: Array<{ url: string; title: string }>;
  model: string;
}

// src/services/parser.ts
interface ParsedResult {
  query: string;
  mentioned: boolean;
  position: number | null;
  context: string | null;
  matchSnippet: string | null;
}

// src/services/scoring.ts
interface ScoreResult {
  mentionRate: number;
  averagePosition: number | null;
  grade: string;
  totalQueries: number;
  mentions: number;
}
```

### Orchestrator Types ([`src/core/SmartCrawlOrchestrator.ts`](D:\React\seo-utilities-api\src\core\SmartCrawlOrchestrator.ts))

```typescript
interface OrchestratorProgress {
  url: string;
  urlsChecked: number;
  elapsedMs: number;
}
```

---

## Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | HTTP server port |
| `ALLOWED_ORIGINS` | `*` | No | Comma-separated CORS origins |
| `CRAWLER_API_KEY` | — | **Yes** | API key for `x-api-key` authentication |
| `MUFFET_DEFAULT_CONCURRENCY` | `10` | No | Default concurrency for muffet |
| `OPENAI_API_KEY` | — | **Yes*** | OpenAI API key (for citation check) |
| `ANTHROPIC_API_KEY` | — | No | Claude API key (future) |
| `GEMINI_API_KEY` | — | No | Gemini API key (future) |

> *Required only if using the citation-check endpoint with the OpenAI provider.

---

## Project Structure

```
D:\React\seo-utilities-api\
├── .env                        # Environment variables (gitignored)
├── .env.example                # Environment variable template
├── .gitignore                  # Ignores node_modules/, dist/, bin/, .env
├── stackhost.yaml              # StackHost deployment configuration
├── install-muffet.mjs          # Node.js script: download + verify + install muffet binary
├── Dockerfile                  # Multi-stage: Go (muffet) + Node.js
├── package.json                # Dependencies & scripts (ESM)
├── tsconfig.json               # TypeScript configuration
├── README.md                   # Quick-start README
├── API_DOCUMENTATION.md        # ← This file
├── bin/                        # Project-local muffet binary (gitignored — built at deploy time)
│   └── muffet                  # Downloaded Go binary (v2.11.5 linux_amd64)
├── dist/                       # Compiled JS output (gitignored)
└── src/
    ├── server.ts               # Express app setup, middleware, routing
    ├── core/
    │   ├── MuffetCrawler.ts    # Muffet process wrapper + output parser
    │   ├── SmartCrawlOrchestrator.ts  # High-level crawl orchestrator with AbortController
    │   └── ProtectionCache.ts  # Cache for protection data
    ├── middleware/
    │   ├── auth.ts             # API key authentication
    │   └── errorHandler.ts     # Global error handler
    ├── routes/
    │   ├── muffet.routes.ts    # POST /crawl, GET /stream
    │   ├── orchestrator.routes.ts  # POST /crawl, GET /stream (SSE), GET /stats
    │   └── citation.routes.ts  # POST /check
    ├── services/
    │   ├── aiProvider.ts       # Abstract AI provider + factory
    │   ├── parser.ts           # AI response parser (fuzzy matching)
    │   ├── promptVariationGenerator.ts  # Search query generator
    │   └── scoring.ts          # Citation scoring & grading
    └── providers/
        ├── openaiProvider.ts   # OpenAI (gpt-4o + web_search_preview)
        ├── claudeProvider.ts   # Claude stub
        └── geminiProvider.ts   # Gemini stub
```
