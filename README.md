# 🚀 SEO Utilities API

A **combined** API service that merges two standalone SEO tools into one:

1. **🔗 Muffet Crawler** — Fast website link-checking via [muffet](https://github.com/raviqqe/muffet) (Go-based). Crawl any website and get all linked URLs with HTTP status codes. Supports JSON (POST) and real-time SSE streaming (GET).

2. **🤖 AI Citation Tracker** — Checks how often and where a company appears in AI-generated search results (ChatGPT web_search). Uses OpenAI's `gpt-4o` with `web_search_preview` to simulate real user searches and detect brand visibility.

---

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [API Documentation](#api-documentation)
  - [Health Check](#health-check)
  - [Authentication](#authentication)
  - [Muffet Crawler](#muffet-crawler)
    - [POST /api/muffet/crawl](#post-apimuffetcrawl)
    - [GET /api/muffet/stream](#get-apimuffetstream)
  - [AI Citation Tracker](#ai-citation-tracker)
    - [POST /api/citation/check](#post-apicitationcheck)
- [Project Structure](#project-structure)
- [Deployment](#deployment)
- [Docker](#docker)

---

## ⚡ Quick Start

### Prerequisites

- **Node.js** >= 18
- **Go** >= 1.21 (to install muffet — or download a pre-built binary)
- **OpenAI API key** (for citation tracker)

### Install muffet

```bash
go install github.com/raviqqe/muffet@v2.11.5
```

Verify it works:

```bash
muffet --version
```

### Local Setup

```bash
# 1. Enter the project
cd seo-utilities-api

# 2. Install Node.js dependencies
npm install

# 3. Copy and configure environment
cp .env.example .env
# Edit .env: set CRAWLER_API_KEY, OPENAI_API_KEY, etc.

# 4. Build + start
npm run build
npm start
```

Or run in development mode with hot-reload:

```bash
npm run dev
```

---

## 🔧 Environment Variables

| Variable                    | Default                    | Required | Description                                              |
|-----------------------------|----------------------------|----------|----------------------------------------------------------|
| `PORT`                      | `3000`                     | No       | HTTP server port                                         |
| `ALLOWED_ORIGINS`           | `*`                        | No       | Comma-separated CORS origins                             |
| `CRAWLER_API_KEY`           | —                          | **Yes**  | Shared API key for all endpoints (`x-api-key` header)    |
| `MUFFET_DEFAULT_CONCURRENCY`| `10`                       | No       | Default concurrent requests for muffet                   |
| `OPENAI_API_KEY`            | —                          | **Yes*** | OpenAI API key (required for citation check)             |
| `ANTHROPIC_API_KEY`         | —                          | No       | Anthropic/Claude API key (for future `model: "claude"`)  |
| `GEMINI_API_KEY`            | —                          | No       | Google Gemini API key (for future `model: "gemini"`)     |

> *Only required if using the citation-check endpoint.

---

## 📚 API Documentation

### Health Check

```
GET /api/health
```

No authentication required.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-07-17T06:30:00.000Z"
}
```

---

### 🔐 Authentication

All API endpoints (except `/api/health`) require an `x-api-key` header with the value of `CRAWLER_API_KEY`.

```bash
curl -H "x-api-key: your-secret-key" http://localhost:3000/api/muffet/crawl
```

---

### 🔗 Muffet Crawler

Endpoints: `/api/muffet/*`

#### POST `/api/muffet/crawl`

Start a muffet crawl and wait for the complete JSON result.

**Request body:**

```json
{
  "url": "https://books.toscrape.com",
  "concurrency": 10,
  "internalOnly": true,
  "excludeAssets": true
}
```

| Field          | Type    | Default | Description                                          |
|----------------|---------|---------|------------------------------------------------------|
| `url`          | string  | —       | **(required)** Website URL to crawl                  |
| `concurrency`  | number  | `5`     | Number of parallel requests                          |
| `internalOnly` | boolean | `true`  | Only check URLs on the same hostname                 |
| `excludeAssets`| boolean | `true`  | Filter out CSS, JS, images, fonts, WP paths, feeds   |

**Response (200):**
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

**Error response (400/429/500):**
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

**Example with curl:**
```bash
curl -X POST http://localhost:3000/api/muffet/crawl \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{"url": "https://books.toscrape.com"}'
```

---

#### GET `/api/muffet/stream`

Receive crawl progress in real-time via Server-Sent Events (SSE).

**Query parameters:**

| Parameter       | Type    | Default | Description                                          |
|-----------------|---------|---------|------------------------------------------------------|
| `url`           | string  | —       | **(required)** Website URL to crawl                  |
| `internalOnly`  | boolean | `true`  | Only check URLs on the same hostname                 |
| `excludeAssets` | boolean | `true`  | Filter out CSS, JS, images, fonts, WP paths, feeds   |

**SSE event types:**

| Event      | Description                                  |
|------------|----------------------------------------------|
| `start`    | Crawl has started, includes the target URL   |
| `progress` | A URL is being checked, includes `urlsChecked` count |
| `result`   | A checked URL with its HTTP status code      |
| `complete` | Crawl finished, includes `totalPages`, `results[]`, `elapsedSec` |
| `error`    | An error occurred during crawling            |

**Example with curl:**
```bash
curl -N -H "x-api-key: your-secret-key" \
  "http://localhost:3000/api/muffet/stream?url=https://books.toscrape.com"
```

---

### 🤖 AI Citation Tracker

Endpoints: `/api/citation/*`

#### POST `/api/citation/check`

Check how often a company/brand appears in AI-generated search results.

**Request body:**

```json
{
  "companyName": "Roto-Rooter",
  "companyDomain": "rotorooter.com",
  "category": "Emergency Plumber",
  "location": "Atlanta",
  "model": "openai"
}
```

| Field           | Type    | Default   | Description                                        |
|-----------------|---------|-----------|----------------------------------------------------|
| `companyName`   | string  | —         | **(required)** Company/brand name to search for    |
| `category`      | string  | —         | **(required)** Business category (e.g. "Emergency Plumber") |
| `location`      | string  | —         | **(required)** City or area (e.g. "Atlanta")       |
| `companyDomain` | string  | —         | Company domain for additional fuzzy matching       |
| `model`         | string  | `"openai"`| AI model to use (`"openai"`, `"claude"`, `"gemini"`) |

**Response (200):**
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

**Grades:**

| Grade          | Condition                                                   |
|----------------|-------------------------------------------------------------|
| 🟢 Excellent   | ≥75% mention rate AND average position ≤ 3                  |
| 🟡 Good        | ≥50% mention rate                                           |
| 🟠 Weak        | ≥25% mention rate                                           |
| 🔴 Not Visible | <25% mention rate                                           |

**Example with curl:**
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

---

## 📁 Project Structure

```
seo-utilities-api/
├── .env                       # Environment variables (gitignored)
├── .env.example               # Environment variable template
├── .gitignore
├── Dockerfile                 # Multi-stage: Go (muffet) + Node.js
├── package.json               # Merged dependencies (no duplicates)
├── tsconfig.json
├── README.md
└── src/
    ├── server.ts              # Main entry — mounts both API routers
    ├── core/
    │   └── MuffetCrawler.ts   # Muffet process wrapper (from muffet-api-service)
    ├── middleware/
    │   ├── auth.ts            # Shared API key auth (from muffet-api-service)
    │   └── errorHandler.ts    # Central error handler (from ai-citation-tracker)
    ├── routes/
    │   ├── muffet.routes.ts   # Muffet crawl endpoints (from muffet-api-service)
    │   └── citation.routes.ts # Citation check endpoint (from ai-citation-tracker)
    ├── services/
    │   ├── aiProvider.ts      # AI provider abstraction + factory
    │   ├── parser.ts          # Response parsing & fuzzy matching
    │   ├── promptVariationGenerator.ts  # Query variation builder
    │   └── scoring.ts         # Citation scoring & grading
    └── providers/
        ├── openaiProvider.ts  # OpenAI web_search implementation
        ├── claudeProvider.ts  # Claude stub (not yet implemented)
        └── geminiProvider.ts  # Gemini stub (not yet implemented)
```

---

## 🚢 Deployment

### Docker (recommended)

```bash
# Build
docker build -t seo-utilities-api .

# Run
docker run -d \
  --name seo-utilities \
  -p 3000:3000 \
  -e CRAWLER_API_KEY=your-secret-key \
  -e OPENAI_API_KEY=sk-... \
  -e ALLOWED_ORIGINS=https://your-frontend.com \
  seo-utilities-api
```

**Image size:** ~150 MB (Node.js + Go binary, no Chromium/Playwright).

### Railway / Render / Fly.io

1. Push to a Git repository
2. Set the build command: `npm install && npm run build`
3. Set the start command: `npm start`
4. Add environment variables:
   - `CRAWLER_API_KEY`
   - `OPENAI_API_KEY`
   - `ALLOWED_ORIGINS`
5. Set the port to `3000`

### Manual (no Docker)

```bash
npm install && npm run build && npm start
```

---

## 🔄 Rate Limiting

The Muffet crawler uses an **adaptive rate limiter**:

| Load Condition | Limit          |
|----------------|----------------|
| Low load (<2 active crawls, <3 recent IPs) | 30 requests/hour/IP |
| High load (2+ active crawls OR 3+ recent IPs) | 5 requests/hour/IP |

This ensures the server remains responsive under load without hard-coding a low limit.

---

## 📝 License

MIT
