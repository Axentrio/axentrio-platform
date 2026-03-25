# 🤖 White Label Chatbot Platform

An enterprise-grade, white-label chatbot platform with real-time messaging, n8n integration, and human handoff capabilities.

## 📋 Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Components](#components)
- [API Documentation](#api-documentation)
- [n8n Integration](#n8n-integration)
- [Deployment](#deployment)
- [Security](#security)
- [License](#license)

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CLIENT WEBSITES                          │
│         (White-label embeddable chat widget)                │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              WEBSOCKET GATEWAY (Socket.io)                  │
│         Real-time bidirectional communication               │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              CORE API SERVER (Node.js/Express)              │
│         • Auth & Tenant isolation                           │
│         • Message routing & queueing                        │
│         • File upload handling (multer/AWS S3)             │
│         • Rate limiting & security                          │
└────────┬───────────────────────────────┬────────────────────┘
         │                               │
         ▼                               ▼
┌─────────────────┐            ┌─────────────────────────────┐
│   n8n WEBHOOK   │            │      HANDSOFF PORTAL        │
│   INTEGRATOR    │            │   (React/Vue Dashboard)     │
│                 │            │                             │
│ • Outbound:     │            │ • Live chat takeover        │
│   POST to       │            │ • Chat history & analytics  │
│   client n8n    │            │ • Human agent assignment    │
│                 │            │ • File moderation queue     │
│ • Inbound:      │            │ • Bot performance metrics   │
│   n8n → webhook │            │ • Multi-tenant management   │
│   back to user  │            │ • Role-based access (RBAC)  │
│                 │            │                             │
└─────────────────┘            └─────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- PostgreSQL 15+
- Redis 7+
- AWS S3 account (or MinIO for local development)

### 1. Clone and Setup

```bash
git clone <repository-url>
cd chatbot-platform

# Copy environment files
cp api/.env.example api/.env
cp portal/.env.example portal/.env

# Edit environment variables
nano api/.env
nano portal/.env
```

### 2. Start with Docker Compose

```bash
# Start all services
docker-compose -f infra/docker-compose.yml up -d

# Services started:
# - API Server: http://localhost:3000
# - PostgreSQL: localhost:5432
# - Redis: localhost:6379
# - n8n: http://localhost:5678
# - MinIO (S3): http://localhost:9000
# - ClamAV: localhost:3310
```

### 3. Run Database Migrations

```bash
cd api
npm install
npm run migration:run
```

### 4. Start Portal

```bash
cd portal
npm install
npm run dev

# Portal available at: http://localhost:5173
```

### 5. Embed Widget

```html
<script src="http://localhost:3000/widget.js"
        data-tenant-id="YOUR_TENANT_UUID"
        data-theme='{"primary":"#3B82F6","position":"bottom-right"}'
        data-n8n-webhook="https://n8n.yourdomain.com/webhook/chat">
</script>
```

## 📁 Project Structure

```
chatbot-platform/
├── 📁 api/                          # Core API Server
│   ├── src/
│   │   ├── config/                  # Database, Redis, Environment
│   │   ├── models/                  # TypeORM entities
│   │   ├── middleware/              # Auth, rate limiting, tenant isolation
│   │   ├── routes/                  # API routes
│   │   ├── websocket/               # Socket.io handler
│   │   ├── file-handling/           # Upload, virus scan, thumbnails
│   │   ├── security/                # CSP, XSS, encryption
│   │   ├── n8n/                     # n8n integration
│   │   └── utils/                   # Logger, helpers
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
│
├── 📁 widget/                       # Embeddable Chat Widget
│   └── widget.js                    # Vanilla JS, zero dependencies
│
├── 📁 portal/                       # HandsOff Dashboard (React)
│   ├── src/
│   │   ├── components/              # Reusable UI components
│   │   ├── pages/                   # Dashboard pages
│   │   ├── hooks/                   # Custom React hooks
│   │   ├── websocket/               # Socket.io client
│   │   ├── auth/                    # Authentication & RBAC
│   │   ├── services/                # API clients
│   │   └── types/                   # TypeScript interfaces
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
│
├── 📁 infra/                        # Infrastructure
│   ├── docker-compose.yml           # Full stack Docker setup
│   ├── Dockerfile                   # API server Dockerfile
│   ├── nginx.conf                   # Reverse proxy config
│   └── k8s/                         # Kubernetes manifests
│
├── 📁 docs/                         # Documentation
│   ├── n8n-integration.md           # n8n setup guide
│   ├── webhook-reference.md         # API endpoint docs
│   ├── message-format.md            # Message schemas
│   ├── troubleshooting.md           # Common issues
│   └── n8n-workflows/               # Example workflows
│       ├── basic-chatbot.json
│       ├── ai-chatbot.json
│       ├── handsoff-escalation.json
│       ├── file-handling.json
│       └── lead-capture.json
│
└── README.md                        # This file
```

## 🔧 Components

### 1. Embeddable Chat Widget (`/widget`)

**Features:**
- ✅ Zero-dependency vanilla JavaScript
- ✅ Shadow DOM encapsulation (CSS isolation)
- ✅ Mobile-first responsive design (320px to 4K)
- ✅ Drag & drop file upload with progress
- ✅ Camera capture (mobile)
- ✅ WebSocket real-time messaging
- ✅ CSP-compliant, XSS protected
- ✅ Loads in <500ms on 3G

**Usage:**
```html
<script src="https://cdn.yourplatform.com/widget.js"
        data-tenant-id="TENANT_UUID"
        data-theme='{"primary":"#3B82F6","position":"bottom-right","title":"Support Chat"}'
        data-n8n-webhook="https://n8n.client.com/webhook/chat">
</script>
```

### 2. WebSocket Gateway (`/api/src/websocket`)

**Features:**
- ✅ Socket.io with Redis Adapter (multi-server scaling)
- ✅ 10,000 concurrent connections per node
- ✅ Room-based messaging per `tenantId:sessionId`
- ✅ JWT authentication
- ✅ Event types:
  - `message:send` / `message:receive`
  - `file:upload` (chunked)
  - `typing:indicator`
  - `handsoff:request` / `handsoff:accept` / `handsoff:reject`

### 3. n8n Integration (`/api/src/n8n`)

**Features:**
- ✅ Outbound webhooks to n8n
- ✅ Inbound webhooks from n8n
- ✅ Circuit breaker pattern (5 failures → auto handoff)
- ✅ 5s timeout with fallback response
- ✅ 3x retry with exponential backoff
- ✅ 99.9% message delivery guarantee

**Outbound Message Format:**
```json
{
  "event": "message.received",
  "tenantId": "uuid",
  "sessionId": "uuid",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "type": "text",
    "content": "Hello!"
  },
  "user": {
    "anonymousId": "uuid",
    "browser": "Chrome 120",
    "geo": "NL"
  },
  "context": {
    "previousMessages": []
  }
}
```

**Inbound Message Format:**
```json
{
  "action": "message.send",
  "sessionId": "uuid",
  "payload": {
    "type": "text",
    "content": "Hi there!",
    "quickReplies": ["Option 1", "Option 2"]
  }
}
```

### 4. HandsOff Portal (`/portal`)

**Features:**
- ✅ React 18 + TypeScript
- ✅ Real-time chat monitoring
- ✅ 1-click chat takeover
- ✅ Sound notifications for handoff requests
- ✅ Typing indicators
- ✅ Inline file preview
- ✅ Role-based access control (Admin/Supervisor/Agent)
- ✅ Analytics dashboard

**Pages:**
- **Live Monitor** - Real-time chat streams
- **Queue** - Handoff request queue
- **Chat Takeover** - Human agent interface
- **Analytics** - Response times, CSAT, bot vs human ratio
- **Tenants** - White-label configuration
- **Team** - Agent management

### 5. File Handling (`/api/src/file-handling`)

**Features:**
- ✅ Pre-signed S3 URLs for direct upload
- ✅ ClamAV virus scanning
- ✅ Sharp thumbnail generation
- ✅ File type whitelist (jpg, png, gif, mp4, mov, pdf, docx)
- ✅ 25MB max file size
- ✅ GDPR auto-delete after 30 days

## 📚 API Documentation

### Authentication

**Widget Authentication (API Key):**
```http
POST /auth/widget
Content-Type: application/json

{
  "tenantId": "uuid",
  "apiKey": "tenant_api_key"
}
```

**Agent Authentication (JWT):**
```http
POST /auth/agent/login
Content-Type: application/json

{
  "email": "agent@example.com",
  "password": "password",
  "totpCode": "123456"  // Optional 2FA
}
```

### Chat Endpoints

**Get Chat History:**
```http
GET /chat/:sessionId/history
Authorization: Bearer <token>
```

**Send Message:**
```http
POST /chat/:sessionId/message
Authorization: Bearer <token>
Content-Type: application/json

{
  "type": "text",
  "content": "Hello!"
}
```

### Handoff Endpoints

**Request Handoff:**
```http
POST /handoff/request
Authorization: Bearer <token>
Content-Type: application/json

{
  "sessionId": "uuid",
  "reason": "Customer requested human"
}
```

**Accept Handoff:**
```http
POST /handoff/accept
Authorization: Bearer <token>
Content-Type: application/json

{
  "sessionId": "uuid"
}
```

## 🔗 n8n Integration

### Setup

1. **Configure n8n webhook URL in tenant settings:**
   ```http
   POST /tenants/:tenantId/config
   {
     "n8nWebhookUrl": "https://n8n.yourdomain.com/webhook/chat"
   }
   ```

2. **Import example workflows:**
   - Go to n8n → Workflows → Import
   - Upload JSON from `/docs/n8n-workflows/`

3. **Configure webhook node:**
   - Method: POST
   - Path: chat
   - Response: Respond immediately

### Example Workflows

| Workflow | Description |
|----------|-------------|
| `basic-chatbot.json` | Simple echo/respond with quick replies |
| `ai-chatbot.json` | OpenAI GPT-4 integration |
| `handsoff-escalation.json` | Sentiment analysis + human escalation |
| `file-handling.json` | Image analysis + document processing |
| `lead-capture.json` | Lead extraction + CRM integration |

See [docs/n8n-integration.md](docs/n8n-integration.md) for detailed setup instructions.

## 🚀 Deployment

### Docker Compose (Development)

```bash
docker-compose -f infra/docker-compose.yml up -d
```

### Kubernetes (Production)

```bash
# Apply manifests
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -f infra/k8s/configmap.yaml
kubectl apply -f infra/k8s/secrets.yaml
kubectl apply -f infra/k8s/postgres.yaml
kubectl apply -f infra/k8s/redis.yaml
kubectl apply -f infra/k8s/api-deployment.yaml
kubectl apply -f infra/k8s/ingress.yaml
kubectl apply -f infra/k8s/rbac.yaml
```

### Environment Variables

**API Server (`api/.env`):**
```env
# Server
NODE_ENV=production
PORT=3000
API_URL=https://api.yourdomain.com

# Database
DATABASE_URL=postgresql://user:pass@postgres:5432/chatbot

# Redis
REDIS_URL=redis://redis:6379

# JWT
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h

# AWS S3
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_S3_BUCKET=your-bucket
AWS_REGION=eu-west-1

# n8n
N8N_WEBHOOK_TIMEOUT=5000
N8N_RETRY_ATTEMPTS=3
N8N_CIRCUIT_BREAKER_THRESHOLD=5

# Security
ENCRYPTION_KEY=your-32-char-encryption-key
BCRYPT_ROUNDS=12
```

See `api/.env.example` for all options.

## 🔒 Security

### Implemented Security Measures

| Feature | Implementation |
|---------|---------------|
| **Authentication** | JWT + API Keys + Optional 2FA |
| **Authorization** | Role-based access control (RBAC) |
| **Encryption** | AES-256-GCM for data at rest |
| **File Upload** | Pre-signed URLs, ClamAV scanning, magic number validation |
| **XSS Protection** | DOMPurify sanitization, CSP headers |
| **Rate Limiting** | Per-tenant and per-IP limits |
| **Audit Logging** | Security event logging, GDPR-compliant |
| **GDPR** | Auto-delete after 30 days, data export/delete APIs |

### OWASP Top 10 Mitigations

- ✅ **Injection** - Parameterized queries, input validation
- ✅ **Broken Auth** - JWT with secure defaults, 2FA support
- ✅ **Sensitive Data** - Encryption at rest, secure key management
- ✅ **XML External Entities** - No XML parsers
- ✅ **Broken Access** - RBAC, tenant isolation
- ✅ **Security Misconfig** - Security headers, minimal error info
- ✅ **XSS** - DOMPurify, CSP, output encoding
- ✅ **Insecure Deserialization** - JSON only, schema validation
- ✅ **Components** - Dependency scanning, minimal base images
- ✅ **Logging** - Security audit logs, SIEM-ready format

See [docs/security-audit.md](docs/security-audit.md) for full security checklist.

## 📊 Monitoring

### Health Checks

```http
GET /health
```

### Metrics (Prometheus)

```http
GET /metrics
```

### Grafana Dashboards

Access at `http://localhost:3001` (Docker Compose)

## 🧪 Testing

```bash
# API tests
cd api
npm test

# Portal tests
cd portal
npm test

# Integration tests
cd api
npm run test:integration
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Socket.io](https://socket.io/) - Real-time communication
- [n8n](https://n8n.io/) - Workflow automation
- [Express.js](https://expressjs.com/) - Web framework
- [React](https://reactjs.org/) - UI library

---

**Built with ❤️ by the Chatbot Platform Team**

For support, contact: support@yourplatform.com
