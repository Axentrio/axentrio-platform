# HandsOff Platform - Deployment Guide

## Architecture Overview

All services run on Railway under the **Axentrio** account in the `handsoff-platform` project.

| Service | Type | Internal Address | Public Domain |
|---------|------|-----------------|---------------|
| chatbot-api | Node.js/Express | `chatbot-api.railway.internal` | `api.axentrio.com` |
| chatbot-portal | React/Vite + Nginx | `chatbot-portal.railway.internal` | `portal.axentrio.com` |
| n8n | Docker image (`n8nio/n8n:latest`) | `n8n.railway.internal:5678` | `automation.axentrio.com` |
| PostgreSQL | Railway managed | `postgres.railway.internal:5432` | (internal only) |
| Redis | Railway managed | `redis.railway.internal:6379` | (internal only) |

**DNS**: Cloudflare (free tier, proxy OFF for Railway CNAMEs)
**SSL**: Auto-provisioned by Railway (Let's Encrypt)
**Repo**: `Axentrio/kimi-chatbot-platform`

---

## Daily Development Flow

```bash
# Work on a feature branch
git checkout -b feature/my-feature
# ... make changes ...
git push origin feature/my-feature

# Merge to main when ready -- Railway auto-deploys
git checkout main
git merge feature/my-feature
git push origin main
```

Railway watches for changes in:
- `chatbot-platform/api/**` -- triggers API rebuild
- `chatbot-platform/portal/**` -- triggers Portal rebuild
- n8n is a Docker image, no auto-deploy from code

---

## Manual Deploy (if GitHub integration isn't connected)

Since `railway up` uses the root `railway.json` for config, deploying the API and portal requires different Dockerfile paths.

### API
```bash
cd chatbot-platform
railway service link chatbot-api
railway up --detach
```

### Portal
The portal uses a different Dockerfile, so you need to temporarily swap the config:
```bash
cd chatbot-platform

# Swap railway.json to portal config
cp railway.json railway.json.bak
python3 -c "
import json
d = json.load(open('railway.json'))
d['build']['dockerfilePath'] = 'portal/Dockerfile'
d['deploy'] = {'healthcheckPath': '/', 'healthcheckTimeout': 300, 'restartPolicyType': 'on_failure', 'restartPolicyMaxRetries': 3}
json.dump(d, open('railway.json','w'), indent=2)
"

railway service link chatbot-portal
railway up --detach

# Restore original
cp railway.json.bak railway.json && rm railway.json.bak
```

### n8n
n8n runs as a Docker image. To update:
```bash
railway service link n8n
railway redeploy -y
```

---

## Environment Variables

### chatbot-api

**Auto-provided by Railway:**
- `DATABASE_URL`, `REDIS_URL`, `PORT`, `RAILWAY_*`

**Security secrets (set in Railway dashboard):**
| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Min 32 chars, token signing |
| `JWT_REFRESH_SECRET` | Min 32 chars, refresh token signing |
| `ENCRYPTION_KEY` | Min 32 chars, field encryption |
| `WIDGET_API_KEY` | Widget authentication key |
| `CLERK_SECRET_KEY` | Clerk auth backend key |
| `CLERK_PUBLISHABLE_KEY` | Clerk auth frontend key |
| `CLERK_WEBHOOK_SECRET` | Clerk webhook verification |

**Third-party integrations:**
| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `AWS_ACCESS_KEY_ID` | Cloudflare R2 / S3 access key |
| `AWS_SECRET_ACCESS_KEY` | Cloudflare R2 / S3 secret |
| `AWS_REGION` | `auto` for Cloudflare R2 |
| `AWS_S3_BUCKET` | Bucket name |
| `S3_ENDPOINT` | Cloudflare R2 endpoint URL |
| `S3_FORCE_PATH_STYLE` | `true` for R2 |
| `RESEND_API_KEY` | Email sending |
| `EMAIL_FROM_ADDRESS` | From address for emails |
| `META_APP_ID` | Meta (WhatsApp/Instagram) app ID |
| `META_APP_SECRET` | Meta app secret |
| `META_VERIFY_TOKEN` | Meta webhook verify token |
| `META_OAUTH_REDIRECT_URI` | `https://api.axentrio.com/api/v1/channels/meta/oauth/callback` |
| `META_OAUTH_JWT_SECRET` | JWT for Meta OAuth flow |

**n8n integration:**
| Variable | Description |
|----------|-------------|
| `N8N_DEFAULT_WEBHOOK_URL` | `http://n8n.railway.internal:5678/webhook/chatbot-platform` |
| `N8N_INBOUND_SECRET` | Secret for n8n → API webhook auth |
| `RAG_INTERNAL_SECRET` | Secret for API → n8n RAG/booking auth |

**Circuit breaker (optional tuning):**
| Variable | Default | Description |
|----------|---------|-------------|
| `N8N_CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before circuit opens |
| `N8N_CIRCUIT_BREAKER_SUCCESS` | `3` | Successes to close circuit |
| `N8N_CIRCUIT_BREAKER_TIMEOUT` | `30000` | Recovery wait (ms) |

**Cross-service URLs:**
| Variable | Value |
|----------|-------|
| `API_URL` | `https://api.axentrio.com` |
| `CORS_ORIGIN` | `https://portal.axentrio.com` |
| `PORTAL_URL` | `https://portal.axentrio.com` |

**Other:**
| Variable | Description |
|----------|-------------|
| `DB_SSL_REJECT_UNAUTHORIZED` | `false` for Railway internal Postgres |
| `SENTRY_DSN` | Sentry error tracking DSN |
| `SENTRY_ENVIRONMENT` | `production` |
| `SUPER_ADMIN_EMAILS` | Comma-separated admin emails |

### chatbot-portal

| Variable | Value |
|----------|-------|
| `PORT` | `8080` |
| `VITE_API_URL` | `https://api.axentrio.com/api/v1` |
| `VITE_WS_URL` | `https://api.axentrio.com` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk frontend key |
| `SENTRY_DSN` | Sentry DSN |

**Note:** `VITE_*` variables are baked in at build time. Changing them requires a rebuild, not just a restart.

### n8n

| Variable | Value |
|----------|-------|
| `PORT` | `5678` |
| `N8N_HOST` | `0.0.0.0` |
| `N8N_PORT` | `5678` |
| `DB_TYPE` | `postgresdb` |
| `DB_POSTGRESDB_HOST` | `postgres.railway.internal` |
| `DB_POSTGRESDB_PORT` | `5432` |
| `DB_POSTGRESDB_DATABASE` | `railway` |
| `DB_POSTGRESDB_USER` | `postgres` |
| `DB_POSTGRESDB_PASSWORD` | (from Railway Postgres) |
| `N8N_BASIC_AUTH_ACTIVE` | `true` |
| `N8N_BASIC_AUTH_USER` | `admin` |
| `N8N_BASIC_AUTH_PASSWORD` | (set a secure password) |
| `N8N_ENCRYPTION_KEY` | Encryption key for credentials |
| `WEBHOOK_URL` | `https://automation.axentrio.com` |
| `API_URL` | `https://api.axentrio.com` |
| `QUEUE_BULL_REDIS_HOST` | `redis.railway.internal` |
| `QUEUE_BULL_REDIS_PORT` | `6379` |
| `QUEUE_BULL_REDIS_PASSWORD` | (from Railway Redis) |

---

## DNS Configuration (Cloudflare)

All records should have **Proxy OFF** (DNS only / grey cloud) so Railway can provision SSL.

| Type | Name | Value | Proxy |
|------|------|-------|-------|
| CNAME | `portal` | `tmvcfc4o.up.railway.app` | OFF |
| CNAME | `api` | `dz4az8gq.up.railway.app` | OFF |
| CNAME | `automation` | `slv9jc1e.up.railway.app` | OFF |
| CNAME | `chat` | (Netlify, if still needed) | OFF |
| CNAME | `www` | (Netlify, if still needed) | OFF |
| MX | `@` | `10 mx.mailprotect.be` | - |
| MX | `@` | `50 mx.backup.mailprotect.be` | - |
| CNAME | `autoconfig` | `autoconfig.mailprotect.be` | OFF |
| CNAME | `autodiscover` | `autodiscover.mailprotect.be` | OFF |
| CNAME | `mail` | `pop3.mailprotect.be` | OFF |

**Nameservers** (set at Combell, your domain registrar):
- Change from Netlify nameservers to Cloudflare nameservers (provided when you add the domain to Cloudflare)

---

## Database Migrations

Migrations run automatically on API startup (`migrationsRun: true` in TypeORM config).

To run migrations manually (e.g., against the public Postgres URL from your local machine):
```bash
cd chatbot-platform/api

DATABASE_URL="postgresql://postgres:<password>@mainline.proxy.rlwy.net:<port>/railway" \
npm run migration:run
```

To generate a new migration:
```bash
cd chatbot-platform/api
npm run migration:generate -- src/database/migrations/<MigrationName>
```

---

## Security Hardening (applied)

These are already in place as of commit `3a08c50`:

- **n8n admin endpoints auth-gated** -- `/circuit-status`, `/circuit-reset`, `/queue-status`, `/retry` require Bearer token
- **Rate limiting** on RAG search (60/min) and booking (30/min) endpoints
- **Redis required in production** -- server exits if Redis connection fails
- **Graceful shutdown** with 30s force-exit timeout
- **unhandledRejection** triggers shutdown (prevents corrupted state)
- **Health endpoint** does not expose environment name
- **Sentry** does not send PII (`sendDefaultPii: false`)
- **DB SSL** defaults to `rejectUnauthorized: true` (opt-out via `DB_SSL_REJECT_UNAUTHORIZED=false`)
- **Production secret validation** -- server refuses to start if JWT, encryption, Clerk, or widget keys use dev defaults
- **`.dockerignore`** files prevent `.env`, `node_modules`, `.git` from leaking into Docker builds
- **`.gitignore`** blocks `.env` files from being committed

---

## n8n Workflow Setup

The n8n instance is a fresh deployment. Workflows need to be re-created.

**Main workflow: "HandsOff Widget Bot"**
- Trigger: Webhook node receiving from `http://n8n.railway.internal:5678/webhook/chatbot-platform`
- Flow: Webhook → Extract Message → Call Claude API → Extract Response → Send to HandsOff API
- The "Send to HandsOff" node should POST to `https://api.axentrio.com/api/v1/webhooks/inbound`
- Auth: Set `Authorization: Bearer <N8N_INBOUND_SECRET>` header

**Credentials to configure in n8n:**
- Anthropic API key (for Claude)
- The `N8N_INBOUND_SECRET` and `RAG_INTERNAL_SECRET` for calling back to the API

---

## Monitoring & Troubleshooting

### View logs
```bash
# API logs
railway service link chatbot-api && railway logs --lines 50

# Portal logs
railway service link chatbot-portal && railway logs --lines 50

# n8n logs
railway service link n8n && railway logs --lines 50
```

### Check service status
```bash
railway service link chatbot-api && railway service status
railway service link chatbot-portal && railway service status
railway service link n8n && railway service status
```

### Health checks
```bash
curl https://api.axentrio.com/health
curl -o /dev/null -w "%{http_code}" https://portal.axentrio.com/
curl -o /dev/null -w "%{http_code}" https://automation.axentrio.com/
```

### Circuit breaker status (requires auth)
```bash
curl -H "Authorization: Bearer <N8N_INBOUND_SECRET>" \
  https://api.axentrio.com/api/v1/webhooks/circuit-status
```

### Reset circuit breaker (requires auth)
```bash
curl -X POST -H "Authorization: Bearer <N8N_INBOUND_SECRET>" \
  https://api.axentrio.com/api/v1/webhooks/circuit-reset
```

### Connect to Postgres (from local machine)
```bash
# Get public URL from Railway
railway service link Postgres && railway variables --kv | grep DATABASE_PUBLIC_URL
# Then connect
psql "<public_url>"
```

---

## Checklist: First-Time Setup on New Railway Account

- [ ] Accept GitHub repo transfer to Axentrio account
- [ ] Update local git remote: `git remote set-url origin git@github.com:Axentrio/kimi-chatbot-platform.git`
- [ ] In Railway dashboard, connect `chatbot-api` to GitHub repo (root: `chatbot-platform`, Dockerfile: `api/Dockerfile`, watch: `chatbot-platform/api/**`)
- [ ] In Railway dashboard, connect `chatbot-portal` to GitHub repo (root: `chatbot-platform`, Dockerfile: `portal/Dockerfile`, watch: `chatbot-platform/portal/**`)
- [ ] Create Cloudflare account, add `axentrio.com`, add CNAME records (proxy OFF)
- [ ] Change nameservers at Combell from Netlify to Cloudflare
- [ ] Wait for DNS propagation and SSL provisioning
- [ ] Verify all three custom domains work over HTTPS
- [ ] Remove stale domains (`chat.axentrio.com`, `n8n.axentrio.com`) from Railway dashboard
- [ ] Re-create n8n workflows (export from old instance, import to new)
- [ ] Update Clerk webhook URL to `https://api.axentrio.com/api/v1/webhooks/clerk`
- [ ] Update Meta OAuth callback in Meta Developer Console
- [ ] Shut down old Railway projects on `ianneo97` account (`ravishing-exploration`, `n8n-automation`)
