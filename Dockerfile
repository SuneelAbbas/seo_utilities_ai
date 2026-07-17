# ─── Stage 1: Install Go (for muffet) ──────────────────────────────────
FROM golang:1.23-alpine AS go-builder

ARG MUFFET_VERSION=v2.11.5

RUN apk add --no-cache git ca-certificates && \
    go install github.com/raviqqe/muffet@${MUFFET_VERSION}

# ─── Stage 2: Node.js runtime ─────────────────────────────────────────
FROM node:22-alpine

# Install ca-certificates for HTTPS requests
RUN apk add --no-cache ca-certificates

# Copy muffet binary from go-builder stage
COPY --from=go-builder /go/bin/muffet /usr/local/bin/muffet

# Create app user (non-root)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built source
COPY dist/ ./dist/

# Copy env example (for reference only; actual env vars passed at runtime)
COPY .env.example ./

# Switch to non-root user
USER appuser

# Expose the API port
EXPOSE 3000

# Start the server
CMD ["node", "dist/server.js"]
