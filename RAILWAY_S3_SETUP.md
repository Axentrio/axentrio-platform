# 🚀 Railway + AWS S3 Setup - Summary

## ✅ What has been added?

### 1. Railway Configuration

| File | Purpose |
|------|---------|
| `railway.toml` | Railway deployment configuration |
| `railway.json` | Alternative JSON configuration |
| `deploy-railway.sh` | Interactive deployment script |

### 2. AWS S3 Configuration

| File | Purpose |
|------|---------|
| `api/src/config/s3.config.ts` | Central S3 configuration |
| `api/.env.railway.example` | Railway environment variables |

### 3. GitHub Actions

| File | Purpose |
|------|---------|
| `.github/workflows/deploy.yml` | Auto-deploy API to Railway |
| `.github/workflows/portal-deploy.yml` | Auto-deploy Portal to Vercel |

### 4. Documentation

| File | Purpose |
|------|---------|
| `docs/railway-s3-deployment.md` | Complete deployment guide |

---

## 🚀 Quick Start

### 1. Install Railway CLI

```bash
npm install -g @railway/cli
railway login
```

### 2. Configure AWS S3

```bash
# Create S3 bucket
aws s3api create-bucket \
  --bucket your-chatbot-files \
  --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1

# Configure CORS (see docs/railway-s3-deployment.md)
```

### 3. Run Deployment Script

```bash
cd /mnt/okcomputer/output/chatbot-platform
./deploy-railway.sh
```

### 4. Or Deploy Manually

```bash
# Link project
railway link

# Add databases
railway add --plugin postgresql
railway add --plugin redis

# Set environment variables
railway variables set \
  NODE_ENV=production \
  JWT_SECRET="$(openssl rand -base64 32)" \
  AWS_ACCESS_KEY_ID="your-key" \
  AWS_SECRET_ACCESS_KEY="your-secret" \
  AWS_S3_BUCKET="your-bucket"

# Deploy
railway up
```

---

## 🔧 Important Environment Variables

### Required for Railway

```env
# Server
NODE_ENV=production
API_URL=https://your-api.railway.app

# Database (auto-populated by Railway)
DATABASE_URL=postgresql://...

# Redis (auto-populated by Railway)
REDIS_URL=redis://...

# Security
JWT_SECRET=your-32-char-secret
JWT_REFRESH_SECRET=your-32-char-refresh
ENCRYPTION_KEY=your-32-char-key
WIDGET_API_KEY=your-widget-key

# AWS S3
AWS_ACCESS_KEY_ID=your-aws-key
AWS_SECRET_ACCESS_KEY=your-aws-secret
AWS_REGION=eu-west-1
AWS_S3_BUCKET=your-bucket-name

# Optional: CDN
CDN_URL=https://your-cloudfront.cloudfront.net

# CORS
CORS_ORIGIN=https://your-portal.railway.app
```

---

## 📁 S3 Bucket CORS Configuration

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
    "AllowedOrigins": [
      "https://your-api.railway.app",
      "https://your-portal.railway.app"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

---

## 💰 Cost Estimation

| Service | Estimated Cost/month |
|---------|---------------------|
| Railway (API + DB + Redis) | $20-35 |
| AWS S3 (10GB + requests) | $10 |
| **Total** | **~$30-45** |

---

## 🔄 Continuous Deployment

GitHub Actions is automatically triggered on push to `main`:

1. **Test** → Lint + Build + Test
2. **Deploy** → Auto-deploy to Railway

**Required GitHub Secrets:**
- `RAILWAY_TOKEN` - From `railway token`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

---

## 📚 Documentation

Detailed instructions:
- `docs/railway-s3-deployment.md` - Complete guide
- `api/.env.railway.example` - All environment variables

---

**Ready to deploy!** 🚀

Run `./deploy-railway.sh` to get started.
