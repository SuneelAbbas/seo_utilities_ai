# Concurrent Request Handling Architecture

## System Overview

```
Client ──► API Gateway ──► Auth Layer ──► Rate Limiter ──► PQueue ──► Muffet Crawler
                                            (abuse)          (FIFO)
```

The system handles **multiple concurrent crawl requests** using a **two-layer concurrency model**:

1. **Abuse Prevention Layer** (`express-rate-limit`) — 100 req/min/IP — stops basic DoS
2. **Crawl Concurrency Layer** (`p-queue`) — FIFO queue with N parallel slots — manages actual crawl execution

---

## Layer 1: Request Pipeline

### 1.1 Express Middleware Stack

Defined in [`server.ts`](src/server.ts:56):
```typescript
app.use('/api/muffet', apiKeyAuth, abuseLimiter, muffetRouter);
```

**Order of execution per request:**

| Step | Middleware | File | Action |
|------|-----------|------|--------|
| 1 | CORS | `server.ts:46` | Validates origin header |
| 2 | JSON Body Parser | `server.ts:47` | Parses `application/json` (1MB limit) |
| 3 | `apiKeyAuth` | `src/middleware/auth.ts:12` | Validates `x-api-key` header |
| 4 | `abuseLimiter` | `server.ts:32` | 100 req/min/IP safety net |
| 5 | Route Handler | `muffet.routes.ts:506` | Queue + crawl logic |

### 1.2 API Key Authentication

File: [`src/middleware/auth.ts`](src/middleware/auth.ts)

- Reads `CRAWLER_API_KEY` from environment (`.env` file)
- Returns `401` if `x-api-key` header is missing
- Returns `403` if key doesn't match
- Returns `503` if server is misconfigured (no key set)

```typescript
// Behavior:
//   No header     → 401 { error: "Missing authentication..." }
//   Wrong key     → 403 { error: "Invalid API key." }
//   No env key    → 503 { error: "Server misconfiguration..." }
//   Valid key     → next()
```

### 1.3 Abuse Prevention Rate Limiter

File: [`server.ts:32-42`](src/server.ts:32)

```typescript
const abuseLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max: 100,               // 100 requests per IP per minute
});
```

**Purpose**: Prevents basic abuse / accidental rapid-fire requests.

**Important**: This is NOT the crawl concurrency controller. It only stops someone sending 1000 requests/second. Valid crawl requests are never rejected by this limiter under normal usage (100 req/min is generous).

---

## Layer 2: Crawl Queue System (PQueue)

### 2.1 Configuration

File: [`muffet.routes.ts:25-42`](src/routes/muffet.routes.ts:25)

| Variable | Env Key | Default | Range | Purpose |
|----------|---------|---------|-------|---------|
| `MUFFET_QUEUE_CONCURRENCY` | `MUFFET_MAX_CONCURRENCY` | 5 | 1–50 | Max parallel crawl processes |
| `MUFFET_MAX_QUEUE_SIZE` | `MUFFET_MAX_QUEUE_SIZE` | 200 | 10–1000 | Max queued requests before 503 |

### 2.2 PQueue Instance

File: [`muffet.routes.ts:48-51`](src/routes/muffet.routes.ts:48)

```typescript
const crawlQueue = new PQueue({
  concurrency: MUFFET_QUEUE_CONCURRENCY,  // e.g., 5
  autoStart: true,                          // Process immediately
});
```

**Behavior**: FIFO (First-In-First-Out). Up to N crawls run in parallel. Excess requests wait in queue.

### 2.3 Queue Stats

File: [`muffet.routes.ts:56-64`](src/routes/muffet.routes.ts:56)

```typescript
function getQueueStats() {
  return {
    queueLength: crawlQueue.size,      // How many waiting
    pendingCount: crawlQueue.pending,  // How many running
    activeProcessing,                  // Custom counter
    maxConcurrency: 5,
    maxQueueSize: 200,
  };
}
```

---

## Layer 3: Job Tracking System

### 3.1 JobInfo Interface

File: [`muffet.routes.ts:70-80`](src/routes/muffet.routes.ts:70)

```typescript
interface JobInfo {
  jobId: string;                    // UUID v4
  url: string;                      // Target URL
  status: 'queued' | 'processing' | 'completed' | 'failed';
  position: number;                 // Queue position
  createdAt: number;                // Timestamp
  emitter: EventEmitter;           // SSE events
  result: MuffetCrawlResponse | null;
}
```

### 3.2 Job Lifecycle

```
  ┌─────────┐     ┌────────────┐     ┌───────────┐
  │ QUEUED   │────►│ PROCESSING │────►│ COMPLETED │
  │          │     │            │     │  or       │
  │ position │     │ crawling.. │     │ FAILED    │
  └─────────┘     └────────────┘     └───────────┘
```

1. **QUEUED**: Job created, waiting in PQueue FIFO line
2. **PROCESSING**: PQueue picks it up, muffet binary executes
3. **COMPLETED**: Crawl succeeded, result stored in `job.result`
4. **FAILED**: Crawl errored, error info stored in `job.result`

### 3.3 Job Cleanup (Memory Management)

File: [`muffet.routes.ts:96-107`](src/routes/muffet.routes.ts:96)

```typescript
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;  // 10 minutes ago
  for (const [id, job] of jobs) {
    if (job.status !== 'queued' && job.createdAt < cutoff) {
      job.emitter.removeAllListeners();
      jobs.delete(id);
    }
  }
}, 60_000);  // Check every 60 seconds
```

- Jobs older than 10 minutes are auto-purged
- Prevents memory leaks from the `jobs` Map
- EventEmitters are cleaned up to allow garbage collection

---

## Flow: POST /api/muffet/crawl (Detailed)

File: [`muffet.routes.ts:506-650`](src/routes/muffet.routes.ts:506)

### Step-by-step:

```
Request: POST /api/muffet/crawl { url: "https://example.com", concurrency: 3 }
         Headers: x-api-key: gb-marketers
```

#### Step 1 — Validate URL (line 510-525)
- Check `url` field exists and is a string
- Validate URL format (must start with `http://` or `https://`)
- If invalid → `HTTP 400`

#### Step 2 — Check Queue Capacity (line 529-541)
```typescript
const currentQueued = crawlQueue.size;
if (currentQueued >= MUFFET_MAX_QUEUE_SIZE) {  // 200
  // → HTTP 503 Service Unavailable
}
```
- Safety valve prevents unbounded memory growth
- With 200 max queue × ~10s average crawl = ~2000s backlog max

#### Step 3 — Create Job Entry (line 543-561)
- Generate UUID v4 (`crypto.randomUUID()`)
- Create `EventEmitter` for SSE
- Calculate queue position
- Store in `jobs` Map

#### Step 4 — Queue in PQueue (line 569-614)
```typescript
const queueTask = crawlQueue.add(async (): Promise<MuffetCrawlResponse> => {
  // PQueue manages concurrency — waits if 5 already running
  job.status = 'processing';
  activeProcessing++;

  const crawler = new MuffetCrawler();
  const crawlResult = await crawler.crawl({ url, concurrency, ... });

  job.status = 'completed';
  job.result = crawlResult;
  return crawlResult;
});
```

- `crawlQueue.add()` returns a Promise
- The Promise resolves when the callback finishes
- PQueue ensures only `MUFFET_QUEUE_CONCURRENCY` (5) callbacks run at once

#### Step 5 — Wait for Result (line 616-623)
```typescript
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const result = await Promise.race([
  queueTask,                                    // Wait for crawl
  new Promise((_, reject) =>                    // Timeout fallback
    setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
  ),
]);
```

- Uses `Promise.race()` to implement a 5-minute timeout
- If crawl completes in time → result is returned
- If crawl exceeds 5 minutes → error thrown → `HTTP 500`

#### Step 6 — Return Response (line 626-635)
```typescript
const responseStatus = result.success ? 200 : 500;
res.status(responseStatus).json({
  success: result.success,
  jobId,
  url,
  result,          // Full MuffetCrawlResponse
  message: result.success
    ? `Crawl completed. ${result.totalPages} pages in ${result.durationSec}s.`
    : `Crawl failed: ${result.error}`,
});
```

- `HTTP 200` on success with full crawl data
- `HTTP 500` on failure with error details

---

## Response Format: POST /api/muffet/crawl

### Success (HTTP 200)

```json
{
  "success": true,
  "jobId": "66501298-2a41-4f19-8bca-95a05ee4f67c",
  "url": "https://example.com",
  "result": {
    "success": true,
    "engine": "muffet",
    "durationSec": 2.7,
    "totalPages": 0,
    "results": []
  },
  "message": "Crawl completed. 0 pages in 2.7s."
}
```

### Failure (HTTP 500)

```json
{
  "success": false,
  "jobId": "abc123...",
  "url": "https://broken-site.com",
  "result": {
    "success": false,
    "engine": "muffet",
    "totalPages": 0,
    "results": [],
    "durationSec": 0,
    "error": "Muffet process failed: failed to fetch root page: 503",
    "errorType": "process_error"
  },
  "message": "Crawl failed: Muffet process failed: ..."
}
```

### Queue Full (HTTP 503)

```json
{
  "status": "rejected",
  "error": "Server at capacity. Please try again in a few minutes.",
  "queueStats": {
    "queueLength": 200,
    "pendingCount": 5,
    "activeProcessing": 5,
    "maxConcurrency": 5,
    "maxQueueSize": 200
  }
}
```

---

## Additional Endpoints

### GET /api/muffet/queue/:jobId (SSE — Real-time Tracking)

File: [`muffet.routes.ts:190-490`](src/routes/muffet.routes.ts:190)

Server-Sent Events stream for real-time queue position updates:

```
Event: connected   → { type: "connected",   jobId, status, position, url }
Event: position    → { type: "position",    status, position, updatedAt }
Event: started     → { type: "started",     status: "processing" }
Event: completed   → { type: "completed",   status, result }
Event: error       → { type: "error",       message }
```

### GET /api/muffet/result/:jobId (Poll-based Result Retrieval)

File: [`muffet.routes.ts:672-712`](src/routes/muffet.routes.ts:672)

| HTTP Status | Scenario |
|-------------|----------|
| `200` | Crawl completed — full result in `result` field |
| `202` | Still queued or processing — current status + position |
| `404` | Job ID not found (purged after 10 min) |
| `500` | Crawl failed — error info in `result` field |

### GET /api/muffet/queue-status (Queue Monitoring)

File: [`muffet.routes.ts:656-661`](src/routes/muffet.routes.ts:656)

Returns current queue stats without any crawl:
```json
{
  "success": true,
  "queueLength": 3,
  "pendingCount": 5,
  "activeProcessing": 5,
  "maxConcurrency": 5,
  "maxQueueSize": 200
}
```

---

## Memory Model

### For StackHost 512MB RAM

```
┌──────────────────────────────────────────────┐
│  Node.js Process (--max-old-space-size=384M) │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  Express App + Middleware         ~20MB │  │
│  ├────────────────────────────────────────┤  │
│  │  Jobs Map (200 entries × ~1KB)    ~0.2MB│  │
│  ├────────────────────────────────────────┤  │
│  │  Muffet Process (5 concurrent)   ~150MB │  │
│  │  (30MB per muffet binary instance)      │  │
│  ├────────────────────────────────────────┤  │
│  │  Smart Crawl Engine               ~150MB│  │
│  │  (Playwright browser)                  │  │
│  ├────────────────────────────────────────┤  │
│  │  Buffer/Overhead                  ~64MB │  │
│  └────────────────────────────────────────┘  │
│  Total: ~384MB ✓                              │
└──────────────────────────────────────────────┘
```

### Key Memory Protections

1. **`maxQueueSize: 200`** — Prevents infinite queue growth
2. **`maxConcurrency: 5`** — Limits parallel muffet processes
3. **Job TTL (10 min)** — Auto-cleanup prevents Map bloat
4. **PM2 `--max-old-space-size=384`** — Heap limit prevents OOM
5. **PM2 `max_memory_restart: 400M`** — Auto-restart if memory exceeds

---

## Concurrency Behavior Examples

### Example 1: Queue Empty, 1 Request
```
POST /crawl (url=A)
  → queue: [A]  
  → PQueue picks A immediately (concurrency=5, only 1 running)
  → A crawls, response returns with result
  → TTFB: ~2-10s (depends on site size)
```

### Example 2: 10 Requests, All at Once
```
POST /crawl (url=B) ─┐
POST /crawl (url=C) ─┤
POST /crawl (url=D) ─┤
POST /crawl (url=E) ─┤
POST /crawl (url=F) ─┤  (5 slots available, all start immediately)
POST /crawl (url=G) ─┤
POST /crawl (url=H) ─┤  (5 started, 5 queued)
POST /crawl (url=I) ─┤
POST /crawl (url=J) ─┤
POST /crawl (url=K) ─┘

Running: B, C, D, E, F  (5 slots filled)
Queue:   G, H, I, J, K   (waiting)

When B finishes → G starts (slot freed)
When C finishes → H starts
...and so on
```

### Example 3: One Slow Site, Many Fast Sites
```
POST /crawl (url=SLOW — 60s crawl)
POST /crawl (url=FAST1)
POST /crawl (url=FAST2)
POST /crawl (url=FAST3)
POST /crawl (url=FAST4)
POST /crawl (url=FAST5)

Running: SLOW, FAST1, FAST2, FAST3, FAST4  (5 slots)
Queue:   FAST5

After ~3s: FAST1-4 finish → FAST5 starts
After ~60s: SLOW finishes
```

**Key insight**: Only **1 of 5 slots** is blocked by the slow site. The other 4 slots process fast sites concurrently.

### Example 4: Queue Full (200+ Requests)
```
POST /crawl (request #201)
  → HTTP 503 "Server at capacity"
  → Client should retry after a few minutes
```

---

## Environment Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `ALLOWED_ORIGINS` | `*` | CORS allowed origins (comma-separated) |
| `CRAWLER_API_KEY` | — | Required API key for authentication |
| `MUFFET_DEFAULT_CONCURRENCY` | `10` | Muffet's internal crawl concurrency (per process) |
| `MUFFET_MAX_CONCURRENCY` | `5` | Max parallel muffet processes (PQueue) |
| `MUFFET_MAX_QUEUE_SIZE` | `200` | Max queued requests before 503 |

---

## Test Files

| File | Purpose |
|------|---------|
| [`test-concurrent.mjs`](test-concurrent.mjs) | Basic concurrent request test |
| [`test-multi-user.mjs`](test-multi-user.mjs) | 10 different domains concurrently |
| [`test-100-burst.mjs`](test-100-burst.mjs) | 100-user burst test |
| [`test-big-site-block.mjs`](test-big-site-block.mjs) | Tests slow site blocking behavior |
| [`test-parallel.mjs`](test-parallel.mjs) | Parallel execution test |
| [`test-result-retrieval.mjs`](test-result-retrieval.mjs) | End-to-end result retrieval test |

---

## Key Design Decisions

1. **PQueue over custom queue**: PQueue is battle-tested, supports concurrency limits, FIFO ordering, and returns Promises natively.

2. **Synchronous POST response**: The endpoint waits for the crawl to complete so clients get the result in a single request/response cycle. Five-minute timeout prevents hanging.

3. **SSE as optional add-on**: Clients that need real-time position updates can use `GET /api/muffet/queue/:jobId` for Server-Sent Events.

4. **Two-layer rate limiting**: The `express-rate-limit` (100 req/min) is purely an abuse safety net. Crawl concurrency is managed by PQueue, which queues rather than rejects valid requests.

5. **Job TTL with automatic cleanup**: Prevents memory leaks while giving clients 10 minutes to retrieve results via `GET /api/muffet/result/:jobId`.

6. **Environment-driven configuration**: All tuning parameters are in `.env` — no code changes needed to adjust concurrency, queue size, or timeouts.
