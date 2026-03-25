#!/bin/bash

# Railway Deployment Script for White Label Chatbot Platform
# This script helps deploy the API server to Railway

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

echo "🚀 Railway Deployment Script"
echo "============================"
echo ""

# Check prerequisites
if ! command -v railway &> /dev/null; then
    print_error "Railway CLI not found. Installing..."
    npm install -g @railway/cli
fi

if ! command -v aws &> /dev/null; then
    print_warning "AWS CLI not found. You'll need it to configure S3."
    echo "Install: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
fi

# Check if logged in to Railway
print_status "Checking Railway authentication..."
if ! railway whoami &> /dev/null; then
    print_error "Not logged in to Railway. Please login first:"
    echo "railway login"
    exit 1
fi

print_success "Authenticated with Railway"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Step 1: Link to Railway project
print_status "Step 1: Linking to Railway project..."
echo ""
echo "Options:"
echo "1. Link to existing project"
echo "2. Create new project"
echo ""
read -p "Select option (1/2): " project_option

if [ "$project_option" = "1" ]; then
    print_status "Linking to existing project..."
    railway link
elif [ "$project_option" = "2" ]; then
    print_status "Creating new Railway project..."
    railway init
else
    print_error "Invalid option"
    exit 1
fi

# Step 2: Add PostgreSQL
print_status "Step 2: Setting up PostgreSQL..."
echo ""
read -p "Add PostgreSQL plugin? (y/n): " add_postgres
if [ "$add_postgres" = "y" ]; then
    railway add --plugin postgresql
    print_success "PostgreSQL added"
fi

# Step 3: Add Redis
print_status "Step 3: Setting up Redis..."
echo ""
read -p "Add Redis plugin? (y/n): " add_redis
if [ "$add_redis" = "y" ]; then
    railway add --plugin redis
    print_success "Redis added"
fi

# Step 4: Configure environment variables
print_status "Step 4: Configuring environment variables..."
echo ""
echo "You'll need to set these environment variables in Railway dashboard:"
echo ""
echo "Required:"
echo "  - JWT_SECRET (generate: openssl rand -base64 32)"
echo "  - JWT_REFRESH_SECRET (generate: openssl rand -base64 32)"
echo "  - WIDGET_API_KEY (generate: openssl rand -base64 24)"
echo "  - AWS_ACCESS_KEY_ID"
echo "  - AWS_SECRET_ACCESS_KEY"
echo "  - AWS_REGION (e.g., eu-west-1)"
echo "  - AWS_S3_BUCKET"
echo "  - ENCRYPTION_KEY (32 characters)"
echo ""
echo "Optional:"
echo "  - CDN_URL (CloudFront URL)"
echo "  - CORS_ORIGIN (your portal URL)"
echo "  - PORTAL_URL"
echo ""

read -p "Open Railway dashboard to set variables? (y/n): " open_dashboard
if [ "$open_dashboard" = "y" ]; then
    railway open
fi

# Step 5: Build and deploy
print_status "Step 5: Building and deploying..."
echo ""
read -p "Deploy now? (y/n): " deploy_now
if [ "$deploy_now" = "y" ]; then
    print_status "Deploying to Railway..."
    railway up
    print_success "Deployment complete!"
    
    # Get deployed URL
    API_URL=$(railway variables get API_URL 2>/dev/null || echo "")
    if [ -n "$API_URL" ]; then
        echo ""
        print_success "API deployed to: $API_URL"
    fi
else
    print_warning "Deployment skipped. Run 'railway up' when ready."
fi

# Step 6: Setup S3 bucket
print_status "Step 6: AWS S3 Configuration..."
echo ""
echo "Make sure your S3 bucket is configured with CORS:"
echo ""
cat << 'EOF'
[
    {
        "AllowedHeaders": ["*"],
        "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
        "AllowedOrigins": ["https://your-portal.railway.app", "https://your-api.railway.app"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3000
    }
]
EOF
echo ""

# Summary
echo ""
echo "============================"
print_success "Setup complete!"
echo "============================"
echo ""
echo "Next steps:"
echo "1. Set all required environment variables in Railway dashboard"
echo "2. Configure S3 bucket CORS settings"
echo "3. Deploy the Portal separately (if needed)"
echo "4. Update widget embed code with production URLs"
echo ""
echo "Useful commands:"
echo "  railway logs          # View logs"
echo "  railway variables     # List environment variables"
echo "  railway up            # Redeploy"
echo "  railway open          # Open dashboard"
echo ""
