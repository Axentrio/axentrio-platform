# 🚀 Railway + AWS S3 Deployment Guide

Complete guide for deploying the White Label Chatbot Platform on Railway with AWS S3 for file storage.

---

## 📋 Prerequisites

- [Railway account](https://railway.app/) (free tier available)
- [AWS account](https://aws.amazon.com/) (free tier available)
- [Railway CLI](https://docs.railway.app/develop/cli) installed
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) installed (optional but recommended)

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         RAILWAY                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   API       │  │  PostgreSQL │  │       Redis         │ │
│  │   Server    │  │   (Plugin)  │  │      (Plugin)       │ │
│  │  (Node.js)  │  │             │  │                     │ │
│  └──────┬──────┘  └─────────────┘  └─────────────────────┘ │
│         │                                                   │
│         │  Pre-signed URLs                                  │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                   AWS S3 BUCKET                       │  │
│  │  • File uploads (direct from client)                 │  │
│  │  • Virus scanning (ClamAV or Cloudmersive)           │  │
│  │  • Thumbnail generation                              │  │
│  │  • GDPR auto-delete (30 days)                        │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Deploy

### Option 1: One-Click Deploy (Recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/your-template-id)

### Option 2: Manual Deploy

```bash
# 1. Clone repository
git clone <your-repo-url>
cd chatbot-platform

# 2. Run deployment script
./deploy-railway.sh
```

---

## 🔧 Step-by-Step Deployment

### Step 1: Create Railway Project

```bash
# Login to Railway
railway login

# Initialize project
railway init
```

### Step 2: Add PostgreSQL Database

```bash
railway add --plugin postgresql
```

Or via Railway Dashboard:
1. Go to your project
2. Click "New" → "Database" → "Add PostgreSQL"
3. Wait for provisioning (takes ~1 minute)

### Step 3: Add Redis

```bash
railway add --plugin redis
```

Or via Railway Dashboard:
1. Click "New" → "Database" → "Add Redis"
2. Wait for provisioning

### Step 4: Configure AWS S3

#### 4.1 Create S3 Bucket

```bash
# Set your bucket name
BUCKET_NAME=your-chatbot-files-$(date +%s)

# Create bucket (change region as needed)
aws s3api create-bucket \
  --bucket $BUCKET_NAME \
  --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1

# Enable versioning (optional but recommended)
aws s3api put-bucket-versioning \
  --bucket $BUCKET_NAME \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket $BUCKET_NAME \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'
```

#### 4.2 Configure CORS

Create `s3-cors.json`:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedOrigins": [
      "https://your-api.railway.app",
      "https://your-portal.railway.app"
    ],
    "ExposeHeaders": [
      "ETag",
      "x-amz-meta-tenant-id",
      "x-amz-meta-user-id",
      "x-amz-meta-session-id"
    ],
    "MaxAgeSeconds": 3000
  }
]
```

Apply CORS:

```bash
aws s3api put-bucket-cors \
  --bucket $BUCKET_NAME \
  --cors-configuration file://s3-cors.json
```

#### 4.3 Create IAM User

```bash
# Create user
aws iam create-user --user-name chatbot-platform-s3

# Create policy file
cat > s3-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetObjectVersion",
        "s3:DeleteObjectVersion"
      ],
      "Resource": [
        "arn:aws:s3:::YOUR_BUCKET_NAME",
        "arn:aws:s3:::YOUR_BUCKET_NAME/*"
      ]
    }
  ]
}
EOF

# Create and attach policy
aws iam put-user-policy \
  --user-name chatbot-platform-s3 \
  --policy-name ChatbotS3Access \
  --policy-document file://s3-policy.json

# Create access keys
aws iam create-access-key --user-name chatbot-platform-s3
```

**Save the Access Key ID and Secret Access Key!**

### Step 5: Set Environment Variables

```bash
# Generate secure secrets
JWT_SECRET=$(openssl rand -base64 32)
JWT_REFRESH_SECRET=$(openssl rand -base64 32)
WIDGET_API_KEY=$(openssl rand -base64 24)
ENCRYPTION_KEY=$(openssl rand -base64 24 | cut -c1-32)

# Set variables in Railway
railway variables set \
  NODE_ENV=production \
  JWT_SECRET="$JWT_SECRET" \
  JWT_REFRESH_SECRET="$JWT_REFRESH_SECRET" \
  WIDGET_API_KEY="$WIDGET_API_KEY" \
  ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  AWS_ACCESS_KEY_ID="your-aws-access-key" \
  AWS_SECRET_ACCESS_KEY="your-aws-secret-key" \
  AWS_REGION="eu-west-1" \
  AWS_S3_BUCKET="$BUCKET_NAME" \
  MAX_FILE_SIZE="26214400" \
  S3_SIGNED_URL_EXPIRY="900" \
  N8N_WEBHOOK_TIMEOUT="5000" \
  N8N_RETRY_ATTEMPTS="3" \
  N8N_CIRCUIT_BREAKER_THRESHOLD="5" \
  LOG_LEVEL="info"
```

Or use the Railway Dashboard:

1. Go to your project
2. Click on the API service
3. Go to "Variables" tab
4. Add each variable

### Step 6: Deploy

```bash
# Deploy to Railway
railway up

# Check logs
railway logs

# Open in browser
railway open
```

---

## 🌐 Custom Domain (Optional)

### Add Custom Domain to Railway

1. Go to Railway Dashboard
2. Select your API service
3. Click "Settings" → "Domains"
4. Click "Custom Domain"
5. Enter your domain (e.g., `api.yourdomain.com`)
6. Follow DNS configuration instructions

### Update CORS

After setting up custom domain, update `CORS_ORIGIN`:

```bash
railway variables set CORS_ORIGIN="https://api.yourdomain.com,https://portal.yourdomain.com"
```

---

## 📁 S3 Bucket Structure

```
your-bucket/
├── uploads/
│   ├── {tenant-id}/
│   │   ├── {session-id}/
│   │   │   ├── {timestamp}-{filename}.jpg
│   │   │   ├── {timestamp}-{filename}.pdf
│   │   │   └── thumbnails/
│   │   │       ├── {timestamp}-{filename}-thumb.jpg
│   │   │       └── {timestamp}-{filename}-preview.jpg
│   │   └── ...
│   └── ...
├── quarantine/
│   └── (files flagged by virus scanner)
└── deleted/
    └── (files pending permanent deletion)
```

---

## 🔒 Security Configuration

### S3 Bucket Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::your-bucket",
        "arn:aws:s3:::your-bucket/*"
      ],
      "Condition": {
        "Bool": {
          "aws:SecureTransport": "false"
        }
      }
    },
    {
      "Sid": "DenyUnencryptedUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::your-bucket/*",
      "Condition": {
        "StringNotEquals": {
          "s3:x-amz-server-side-encryption": "AES256"
        }
      }
    }
  ]
}
```

Apply:

```bash
aws s3api put-bucket-policy \
  --bucket your-bucket \
  --policy file://bucket-policy.json
```

---

## 🧪 Testing Deployment

### Test API Health

```bash
# Get your Railway URL
RAILWAY_URL=$(railway variables get API_URL)

# Test health endpoint
curl https://$RAILWAY_URL/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "services": {
    "database": "connected",
    "redis": "connected",
    "s3": "connected"
  }
}
```

### Test File Upload

```bash
# Generate pre-signed URL
curl -X POST https://$RAILWAY_URL/api/v1/upload/presigned \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "test.jpg",
    "fileSize": 1024,
    "mimeType": "image/jpeg",
    "tenantId": "your-tenant-id",
    "userId": "user-id",
    "chatSessionId": "session-id"
  }'
```

---

## 📊 Monitoring

### Railway Dashboard

Monitor your deployment at:
- **Metrics**: CPU, memory, disk usage
- **Logs**: Real-time application logs
- **Deployments**: Deployment history

### Health Checks

Railway automatically monitors the `/health` endpoint.

### Custom Metrics (Optional)

Add to your application:

```typescript
// Expose metrics endpoint for monitoring
app.get('/metrics', (req, res) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    connections: activeConnections,
    queueSize: messageQueue.size(),
  });
});
```

---

## 💰 Cost Estimation

### Railway (Free Tier)

| Resource | Free Tier | Paid (Estimated) |
|----------|-----------|------------------|
| Execution | $5 credit/month | ~$10-20/month |
| PostgreSQL | 500 MB | ~$5-10/month |
| Redis | 100 MB | ~$5/month |
| **Total** | **Free** | **~$20-35/month** |

### AWS S3 (Estimated)

| Usage | Cost |
|-------|------|
| Storage (10 GB) | ~$0.23/month |
| Requests (1M) | ~$0.40/month |
| Data Transfer (100 GB) | ~$9.00/month |
| **Total** | **~$10/month** |

**Total Estimated Cost: $30-45/month** for moderate usage.

---

## 🔧 Troubleshooting

### Issue: S3 Upload Fails

**Symptoms**: Pre-signed URL returns 403 or upload fails

**Solutions**:
1. Check CORS configuration
2. Verify IAM permissions
3. Check bucket policy
4. Verify environment variables

```bash
# Test S3 access
aws s3 ls s3://your-bucket --profile your-profile
```

### Issue: Database Connection Fails

**Symptoms**: API fails to start, database errors in logs

**Solutions**:
1. Check `DATABASE_URL` is set
2. Verify PostgreSQL plugin is running
3. Check connection limits

```bash
# Check Railway variables
railway variables
```

### Issue: WebSocket Connection Fails

**Symptoms**: Real-time features not working

**Solutions**:
1. Check Redis connection
2. Verify `REDIS_URL` is set
3. Check firewall rules

### Issue: CORS Errors

**Symptoms**: Browser blocks requests

**Solutions**:
1. Update `CORS_ORIGIN` with correct domain
2. Check protocol (http vs https)
3. Verify no trailing slashes

---

## 🔄 Continuous Deployment

### GitHub Actions Workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Railway

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Install Railway CLI
        run: npm install -g @railway/cli
      
      - name: Deploy to Railway
        run: railway up --service api
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
```

Add `RAILWAY_TOKEN` to GitHub Secrets:
1. Get token: `railway token`
2. Go to GitHub → Settings → Secrets
3. Add `RAILWAY_TOKEN`

---

## 📚 Additional Resources

- [Railway Documentation](https://docs.railway.app/)
- [AWS S3 Documentation](https://docs.aws.amazon.com/s3/)
- [Socket.io with Redis](https://socket.io/docs/v4/redis-adapter/)
- [n8n Documentation](https://docs.n8n.io/)

---

## ✅ Deployment Checklist

- [ ] Railway project created
- [ ] PostgreSQL database added
- [ ] Redis added
- [ ] S3 bucket created
- [ ] S3 CORS configured
- [ ] IAM user created with access keys
- [ ] All environment variables set
- [ ] API deployed successfully
- [ ] Health check passes
- [ ] File upload tested
- [ ] WebSocket connection tested
- [ ] Custom domain configured (optional)
- [ ] Monitoring enabled
- [ ] GitHub Actions configured (optional)

---

**Need help?** Contact support or check the troubleshooting section above.
