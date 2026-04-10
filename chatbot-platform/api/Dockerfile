# =============================================================================
# Dockerfile - Chatbot Platform API (Railway)
# =============================================================================
# Multi-stage build for optimized production image
# =============================================================================

# Stage 1: Dependencies
FROM node:20-alpine AS deps

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    libc6-compat \
    vips-dev \
    vips-heif \
    vips-magick

WORKDIR /app

COPY api/package*.json ./
RUN npm install node-addon-api node-gyp && \
    npm ci --include=dev

# Stage 2: Builder
FROM node:20-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY api/ .

RUN npm run build
RUN npm prune --production

# Stage 3: Production
FROM node:20-alpine

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

RUN apk add --no-cache \
    dumb-init \
    curl \
    ca-certificates \
    vips \
    vips-heif \
    vips-magick \
    ffmpeg

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN mkdir -p /app/logs /app/tmp /app/uploads && \
    chown -R nodejs:nodejs /app

COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
