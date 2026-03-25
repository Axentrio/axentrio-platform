# 🚀 Quick Start Guide

Get your white-label chatbot platform running in 5 minutes!

## Prerequisites

- Node.js 20+
- Docker & Docker Compose
- Git

## One-Command Setup

```bash
# Clone the repository
git clone <repository-url>
cd chatbot-platform

# Run the setup script
./setup.sh
```

This will:
1. ✅ Copy environment files
2. ✅ Start PostgreSQL, Redis, n8n, MinIO (S3), ClamAV
3. ✅ Install API dependencies
4. ✅ Run database migrations
5. ✅ Install Portal dependencies
6. ✅ Verify widget build

## Manual Setup (Alternative)

### Step 1: Start Infrastructure

```bash
cd infra
docker-compose up -d
```

Services started:
- API Server: http://localhost:3000
- PostgreSQL: localhost:5432
- Redis: localhost:6379
- n8n: http://localhost:5678
- MinIO (S3): http://localhost:9000

### Step 2: Setup API

```bash
cd api
cp .env.example .env
npm install
npm run migration:run
npm run dev
```

### Step 3: Setup Portal

```bash
cd portal
cp .env.example .env
npm install
npm run dev
```

## Embed the Widget

Add this to your website's HTML:

```html
<script src="http://localhost:3000/widget.js"
        data-tenant-id="YOUR_TENANT_UUID"
        data-theme='{"primary":"#3B82F6","position":"bottom-right","title":"Support Chat"}'
        data-n8n-webhook="https://n8n.yourdomain.com/webhook/chat">
</script>
```

## Configure n8n

1. Open n8n at http://localhost:5678
2. Import a workflow from `docs/n8n-workflows/`
3. Configure the webhook node with your API URL
4. Activate the workflow

## First Chat Test

1. Open your website with the embedded widget
2. Send a message
3. Check n8n execution logs
4. View the conversation in the Portal at http://localhost:5173

## Common Commands

```bash
# View logs
docker-compose -f infra/docker-compose.yml logs -f

# Restart services
docker-compose -f infra/docker-compose.yml restart

# Reset database
docker-compose -f infra/docker-compose.yml down -v
docker-compose -f infra/docker-compose.yml up -d

# API tests
cd api && npm test

# Portal tests
cd portal && npm test
```

## Troubleshooting

### Port Conflicts

If ports are already in use, edit `infra/docker-compose.yml` to change port mappings:

```yaml
ports:
  - "3001:3000"  # Change 3000 to 3001
```

### Database Connection Issues

```bash
# Reset database
docker-compose -f infra/docker-compose.yml down -v
docker-compose -f infra/docker-compose.yml up -d postgres

# Wait for postgres to be ready
sleep 5

# Run migrations
cd api && npm run migration:run
```

### Widget Not Loading

Check browser console for:
- CORS errors → Update `CORS_ORIGIN` in `api/.env`
- 404 errors → Verify API server is running
- CSP errors → Check `CSP_DIRECTIVES` in `api/.env`

## Next Steps

- 📚 Read the full [README.md](README.md)
- 🔗 Configure [n8n integration](docs/n8n-integration.md)
- 🔒 Review [security checklist](docs/security-audit.md)
- 📊 Set up [monitoring](docs/monitoring.md)

## Support

- 📖 Documentation: `/docs`
- 🐛 Issues: GitHub Issues
- 💬 Discussions: GitHub Discussions
