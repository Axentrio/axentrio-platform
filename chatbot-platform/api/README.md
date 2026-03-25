# Chatbot Platform API

Core API Server with WebSocket Gateway for the Chatbot Platform.

## Features

- **Express.js** RESTful API
- **Socket.io** with Redis Adapter for multi-server scaling
- **PostgreSQL** database with TypeORM
- **JWT Authentication** for agents and widget sessions
- **Rate Limiting** per IP and tenant
- **Real-time messaging** with room-based architecture
- **Human handoff** system

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      API Server (Port 3000)                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Express   │  │  Socket.io  │  │   Redis Adapter     │  │
│  │   Routes    │  │   Handler   │  │   (Pub/Sub)         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│           │              │                    │              │
│           └──────────────┴────────────────────┘              │
│                          │                                   │
│  ┌───────────────────────┴──────────────────────────────┐   │
│  │              Middleware Layer                         │   │
│  │  • JWT Auth  • Tenant Validation  • Rate Limiting    │   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   ┌─────────┐          ┌─────────┐          ┌─────────┐
   │PostgreSQL│          │  Redis  │          │  Client │
   │         │          │         │          │         │
   │• Tenants│          │• Adapter│          │• Widget │
   │• Sessions│         │• Rate   │          │• Agent  │
   │• Messages│         │  Limit  │          │  Portal │
   │• Agents │          │• Sessions│         │         │
   └─────────┘          └─────────┘          └─────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 6+

### Installation

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
npm run migration:run

# Start development server
npm run dev

# Build for production
npm run build
npm start
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `3000` |
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_USERNAME` | PostgreSQL username | `postgres` |
| `DB_PASSWORD` | PostgreSQL password | `postgres` |
| `DB_DATABASE` | PostgreSQL database | `chatbot_platform` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `JWT_SECRET` | JWT signing secret | Required |
| `JWT_EXPIRES_IN` | JWT expiration | `24h` |

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/widget` | Authenticate widget (API key) |
| POST | `/auth/agent` | Authenticate agent (email/password) |
| POST | `/auth/refresh` | Refresh JWT token |
| POST | `/auth/logout` | Logout agent |
| GET | `/auth/verify` | Verify token validity |

### Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/chat/:sessionId/history` | Get message history |
| POST | `/chat/:sessionId/message` | Send message (HTTP) |
| GET | `/chat/:sessionId/status` | Get session status |
| POST | `/chat/:sessionId/close` | Close session |
| GET | `/chat/sessions` | List sessions (agent) |

### Handoff

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/handoff/request` | Request human handoff |
| POST | `/handoff/accept` | Accept handoff (agent) |
| POST | `/handoff/reject` | Reject handoff (agent) |
| POST | `/handoff/return` | Return to bot (agent) |
| GET | `/handoff/pending` | List pending requests |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |

## WebSocket Events

### Client → Server

| Event | Data | Description |
|-------|------|-------------|
| `session:join` | `{ sessionId }` | Join a session room |
| `session:leave` | `{ sessionId }` | Leave a session room |
| `message:send` | `{ sessionId, content, type }` | Send a message |
| `message:read` | `{ messageId }` | Mark message as read |
| `typing:indicator` | `{ sessionId, isTyping }` | Send typing indicator |
| `handoff:request` | `{ sessionId, reason }` | Request handoff |
| `handoff:accept` | `{ sessionId }` | Accept handoff |
| `handoff:reject` | `{ sessionId }` | Reject handoff |
| `presence:update` | `{ status }` | Update presence |

### Server → Client

| Event | Data | Description |
|-------|------|-------------|
| `connection:ack` | `{ socketId, timestamp }` | Connection acknowledged |
| `session:joined` | `{ sessionId, roomName, status }` | Successfully joined |
| `message:receive` | Message object | New message received |
| `message:read` | `{ messageId, readAt }` | Message marked read |
| `typing:indicator` | `{ sessionId, isTyping, senderType }` | Typing status |
| `handoff:requested` | `{ sessionId, reason }` | Handoff requested |
| `handoff:accepted` | `{ sessionId, agent }` | Handoff accepted |
| `handoff:pending` | `{ sessionId, status }` | Handoff pending |
| `handoff:assigned` | `{ sessionId, agentId }` | Handoff assigned |
| `agent:online` | `{ agentId }` | Agent came online |
| `agent:offline` | `{ agentId }` | Agent went offline |
| `agent:status` | `{ agentId, status }` | Agent status changed |

## Room Format

- Session rooms: `${tenantId}:${sessionId}`
- Tenant agent pool: `agents:${tenantId}`
- Agent-specific: `agent:${agentId}`

## License

MIT
