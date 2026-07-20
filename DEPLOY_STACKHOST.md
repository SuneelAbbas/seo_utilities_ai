# 🚀 StackHost Deployment Guide — seo-utilities-api

## Prerequisites

- Node.js >= 18 on StackHost (confirmed)
- 512MB RAM plan (minimum)
- Git access to push the repository

---

## 1. Prepare Your Environment

### 1.1 Copy `.env.production` → `.env`

```bash
cp .env.production .env
```

### 1.2 Generate a Strong API Key

```bash
node -e "console.log(require('crypto').randomUUID())"
# Example output: 7f8c3b2a-1d4e-5f6a-8b9c-0d1e2f3a4b5c
```

Edit `.env` and replace `CRAWLER_API_KEY=gb-marketers` with your new key.

### 1.3 Set Allowed Origins

Edit `ALLOWED_ORIGINS` in `.env` to your frontend domain(s):

```
ALLOWED_ORIGINS=https://your-frontend.com,https://admin.your-frontend.com
```

### 1.4 (Optional) Tune Queue Settings

These are already set for 512MB RAM:

| Variable | Value | Meaning |
|----------|-------|---------|
| `MUFFET_MAX_CONCURRENCY` | 5 | Max simultaneous crawls |
| `MUFFET_MAX_QUEUE_SIZE` | 200 | Safety valve (HTTP 503 when full) |
| `MUFFET_DEFAULT_CONCURRENCY` | 10 | Links checked in parallel per crawl |

---

## 2. StackHost Setup

### 2.1 Create the Application

1. Login to **StackHost Panel**
2. Go to **Node.js** → **Create Application**
3. Set:
   - **Node version**: 18 or 20
   - **Application root**: `/home/username/apps/seo-utilities-api`
   - **Application URL**: `http://localhost:3000` (or your port)
   - **Startup file**: `ecosystem.config.cjs`
   - **Build command**: `npm run build`

### 2.2 Upload Code

Via Git:

```bash
git remote add stackhost user@stackhost:/home/username/apps/seo-utilities-api.git
git push stackhost main
```

Or via FTP/SFTP: Upload the entire project folder.

### 2.3 Run Build

StackHost will automatically run:

```bash
cd /home/username/apps/seo-utilities-api
npm install          # Also runs postinstall → install-muffet.mjs + Playwright
npm run build        # Compiles TypeScript → dist/
```

> **Note**: The `postinstall` script automatically downloads the **muffet** binary to `./bin/muffet` and installs **Playwright Chromium** browser. This happens once during deployment.

### 2.4 Environment Variables

In StackHost Panel → **Environment Variables**, add:

| Variable | Value | Notes |
|----------|-------|-------|
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | Or StackHost's assigned port |
| `CRAWLER_API_KEY` | *(your generated key)* | Must match frontend |
| `ALLOWED_ORIGINS` | *(your domain)* | |
| `MUFFET_MAX_CONCURRENCY` | `5` | |
| `MUFFET_MAX_QUEUE_SIZE` | `200` | |
| `MUFFET_DEFAULT_CONCURRENCY` | `10` | |

Alternatively, upload your `.env` file via FTP (it's in `.gitignore` so it won't be committed).

### 2.5 Start the Application

StackHost should auto-start via PM2 using:

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
```

---

## 3. Verify Deployment

### 3.1 Health Check

```bash
curl https://your-domain.com/api/health
```

Expected response:

```json
{ "status": "ok", "timestamp": "2026-07-20T..." }
```

### 3.2 Test Muffet Crawl

```bash
curl -X POST https://your-domain.com/api/muffet/crawl \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"url": "https://example.com", "concurrency": 5}'
```

Expected response — HTTP **202** with jobId:

```json
{
  "status": "queued",
  "jobId": "uuid-here",
  "queuePosition": 1,
  "message": "..."
}
```

### 3.3 Test Smart Crawl

```bash
curl -X POST https://your-domain.com/api/orchestrator/crawl \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"url": "https://example.com"}'
```

---

## 4. Monitoring

### 4.1 PM2 Commands (via SSH)

```bash
pm2 list                           # List all processes
pm2 logs seo-utilities-api         # Live logs
pm2 monit                          # Resource monitor (CPU/RAM)
pm2 status seo-utilities-api       # Process status
pm2 restart seo-utilities-api      # Restart
```

### 4.2 Queue Status (HTTP)

```bash
curl -H "x-api-key: YOUR_KEY" https://your-domain.com/api/muffet/queue-status
```

Returns:

```json
{
  "success": true,
  "queueLength": 3,
  "pendingCount": 0,
  "activeProcessing": 2,
  "maxConcurrency": 5,
  "maxQueueSize": 200
}
```

### 4.3 Memory Monitoring

If you see high memory usage in StackHost Panel:

1. Reduce `MUFFET_MAX_CONCURRENCY` → 3
2. Reduce `MUFFET_MAX_QUEUE_SIZE` → 100
3. Restart: `pm2 restart seo-utilities-api`

---

## 5. Troubleshooting

### 5.1 muffet Binary Not Found

```bash
cd /home/username/apps/seo-utilities-api
node install-muffet.mjs   # Re-downloads muffet
```

### 5.2 Playwright Chromium Missing

```bash
cd /home/username/apps/seo-utilities-api
npx playwright install chromium --with-deps
```

### 5.3 Port Already in Use

```bash
# Check what's using the port
lsof -i :3000
# Kill it
kill -9 <PID>
pm2 start ecosystem.config.cjs
```

### 5.4 Out of Memory

Check logs:

```bash
pm2 logs seo-utilities-api --lines 50
```

If you see `FATAL ERROR: Reached heap limit`, reduce concurrency in `.env`:

```
MUFFET_MAX_CONCURRENCY=3
MUFFET_MAX_QUEUE_SIZE=100
```

Then restart:

```bash
pm2 restart seo-utilities-api
```

---

## 6. File Reference

| File | Purpose |
|------|---------|
| `dist/server.js` | Compiled Express app (entry point) |
| `ecosystem.config.cjs` | PM2 process config |
| `.env` | **PRODUCTION SECRETS** — not in git |
| `.env.production` | Template — safe for git |
| `install-muffet.mjs` | Downloads muffet binary to `./bin/` |
| `bin/muffet` | muffet binary (Linux, installed by postinstall) |
| `logs/` | PM2 log files (auto-created) |
| `src/routes/muffet.routes.ts` | Queue system with PQueue + SSE |
| `src/routes/orchestrator.routes.ts` | Smart Crawl (Playwright) |
