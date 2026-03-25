# =============================================================================
# Dockerfile - Chatbot Platform API
# =============================================================================
# Multi-stage build for optimized production image
# Build context: repo root (chatbot-platform/)
# =============================================================================

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:20-alpine AS deps

# Install build dependencies for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    libc6-compat

WORKDIR /app

# Copy package files from api/ subdirectory
COPY api/package.json ./
# Use prebuilt sharp for linux/musl (Alpine) — skip native compilation
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
ENV npm_config_platform=linuxmusl
ENV npm_config_arch=x64
RUN npm install --include=dev

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
# Copy source code from api/ subdirectory
COPY api/ .

# Build TypeScript
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# =============================================================================
# Stage 3: Production
# =============================================================================
FROM node:20-alpine AS production

# Security: Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Install runtime dependencies
RUN apk add --no-cache \
    dumb-init \
    curl \
    ca-certificates \
    vips \
    vips-heif \
    vips-magick \
    ffmpeg

WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Create necessary directories
RUN mkdir -p /app/logs /app/tmp /app/uploads && \
    chown -R nodejs:nodejs /app

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["node", "dist/server.js"]
