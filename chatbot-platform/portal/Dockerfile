# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY portal/package*.json ./
RUN npm install
COPY portal/ .
ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WS_URL=${VITE_WS_URL}
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}
RUN echo "Building with VITE_API_URL=$VITE_API_URL VITE_WS_URL=$VITE_WS_URL CLERK_KEY=${VITE_CLERK_PUBLISHABLE_KEY:0:10}..."
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY portal/nginx.conf /etc/nginx/templates/default.conf.template
ENV PORT=80
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
