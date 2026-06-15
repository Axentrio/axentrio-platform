# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY portal/package*.json ./
RUN npm install
COPY portal/ .
# The portal imports shared wire types via the `@contracts/*` tsconfig alias →
# `../api/src/contracts/*`. The build context is the repo root, so copy those
# files in at the path the alias resolves to (/api/src/contracts relative to
# /app). Without this, `tsc` fails in the Docker build (TS2307) even though CI's
# full-repo checkout resolves it — which silently broke every portal deploy.
COPY api/src/contracts /api/src/contracts
ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_SENTRY_DSN
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WS_URL=${VITE_WS_URL}
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
RUN echo "Building with VITE_API_URL=$VITE_API_URL VITE_WS_URL=$VITE_WS_URL CLERK_KEY=${VITE_CLERK_PUBLISHABLE_KEY:0:10}..."
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY portal/nginx.conf /etc/nginx/templates/default.conf.template
ENV PORT=80
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
