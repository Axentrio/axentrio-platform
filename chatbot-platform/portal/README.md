# HandsOff Portal

A React/TypeScript dashboard for human agents to monitor and take over chatbot conversations.

## Features

- **Real-time Chat Monitoring**: Live chat streams with WebSocket integration
- **1-Click Takeover**: Agents can takeover chats within 3 clicks
- **Handoff Queue**: Manage pending handoff requests with priority-based sorting
- **Sound Notifications**: Audio alerts for new handoff requests
- **Typing Indicators**: See when users are typing in real-time
- **File Preview**: Inline file preview without download
- **Analytics Dashboard**: Response times, CSAT scores, bot vs human ratio
- **Tenant Management**: White-label configuration (colors, logo, webhook)
- **Team Management**: Agent management, shifts, SLA monitoring
- **Role-Based Access**: Admin, Supervisor, and Agent roles

## Tech Stack

- **React 18+** with TypeScript
- **Socket.io-client** for real-time communication
- **React Router v6** for routing
- **Tailwind CSS** for styling
- **Recharts** for analytics visualizations
- **React Query** for data fetching
- **Zustand** for state management
- **Vite** for build tooling

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Start development server
npm run dev
```

The app will be available at `http://localhost:3000`

### Demo Login

Use these credentials to test the application:

- **Email**: `demo@example.com`
- **Password**: `demo`

For 2FA testing:
- **Email**: `2fa@example.com`
- **Password**: any
- **2FA Code**: `123456`

## Project Structure

```
src/
├── auth/              # Authentication (Zustand store, ProtectedRoute)
├── components/        # Reusable UI components
│   ├── ChatStream.tsx
│   ├── ChatWindow.tsx
│   ├── FilePreview.tsx
│   ├── NotificationBell.tsx
│   ├── Sidebar.tsx
│   ├── StatusBadge.tsx
│   ├── TenantSelector.tsx
│   └── TypingIndicator.tsx
├── config/            # Configuration files
│   ├── api.config.ts
│   └── constants.ts
├── context/           # React context (if needed)
├── hooks/             # Custom React hooks
│   ├── useChat.ts
│   ├── useChats.ts
│   ├── useDebounce.ts
│   ├── useFilePreview.ts
│   ├── useHandoffs.ts
│   └── useTyping.ts
├── pages/             # Dashboard pages
│   ├── Login.tsx
│   ├── Dashboard.tsx
│   ├── LiveMonitor.tsx
│   ├── ChatTakeover.tsx
│   ├── Queue.tsx
│   ├── Analytics.tsx
│   ├── Tenants.tsx
│   ├── Team.tsx
│   └── Settings.tsx
├── services/          # API clients
│   ├── apiClient.ts
│   ├── chatService.ts
│   ├── handoffService.ts
│   ├── agentService.ts
│   ├── tenantService.ts
│   ├── analyticsService.ts
│   └── fileService.ts
├── types/             # TypeScript interfaces
│   └── index.ts
├── websocket/         # Socket.io integration
│   ├── SocketContext.tsx
│   └── notificationSound.ts
├── styles/            # Global styles
│   └── index.css
├── App.tsx            # Main application
└── index.tsx          # Entry point
```

## Key Features Implementation

### 3-Click Takeover

1. Click on chat in Live Monitor or Queue
2. Click "Takeover" button
3. Start chatting immediately

### Real-time Updates

WebSocket events handled:
- `chat:new` - New chat started
- `chat:update` - Chat status changed
- `chat:message:received` - New message
- `chat:typing:update` - Typing indicator
- `handoff:new` - New handoff request
- `handoff:update` - Handoff status changed

### Sound Notifications

- Handoff requests play distinct sound
- Configurable volume and mute settings
- Persisted in localStorage

## Role-Based Access

| Feature | Admin | Supervisor | Agent |
|---------|-------|------------|-------|
| Dashboard | ✅ | ✅ | ✅ |
| Live Monitor | ✅ | ✅ | ✅ |
| Queue | ✅ | ✅ | ✅ |
| Chat Takeover | ✅ | ✅ | ✅ |
| Analytics | ✅ | ✅ | ❌ |
| Tenants | ✅ | ❌ | ❌ |
| Team | ✅ | ✅ | ❌ |
| Settings | ✅ | ✅ | ✅ |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_API_URL` | Backend API URL | `http://localhost:5000/api` |
| `VITE_WS_URL` | WebSocket server URL | `http://localhost:5000` |

## Build for Production

```bash
npm run build
```

Output will be in the `dist/` directory.

## License

MIT
