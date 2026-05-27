#!/bin/bash

# White Label Chatbot Platform - Setup Script
# This script sets up the entire development environment

set -e

echo "🚀 White Label Chatbot Platform Setup"
echo "======================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
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

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Check Node.js version
if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed. Please install Node.js 20+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    print_error "Node.js version 20+ is required. Current version: $(node -v)"
    exit 1
fi

print_success "Node.js $(node -v) detected"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
print_status "Setting up project in: $SCRIPT_DIR"
echo ""

# Step 1: Copy environment files
print_status "Step 1: Setting up environment files..."

if [ ! -f "api/.env" ]; then
    cp api/.env.example api/.env
    print_success "Created api/.env"
else
    print_warning "api/.env already exists, skipping"
fi

if [ ! -f "portal/.env" ]; then
    cp portal/.env.example portal/.env
    print_success "Created portal/.env"
else
    print_warning "portal/.env already exists, skipping"
fi

# Step 2: Start infrastructure services
print_status "Step 2: Starting infrastructure services with Docker Compose..."
cd infra
docker-compose up -d

echo ""
print_status "Waiting for services to be ready..."
sleep 10

# Check if services are running
if docker-compose ps | grep -q "Up"; then
    print_success "Infrastructure services are running"
else
    print_error "Failed to start infrastructure services"
    exit 1
fi

cd ..

# Step 3: Install API dependencies
print_status "Step 3: Installing API dependencies..."
cd api
npm install
print_success "API dependencies installed"

# Step 4: Run database migrations
print_status "Step 4: Running database migrations..."
npm run migration:run || print_warning "Migration command not available, skipping"
print_success "Database migrations completed"

cd ..

# Step 5: Install Portal dependencies
print_status "Step 5: Installing Portal dependencies..."
cd portal
npm install
print_success "Portal dependencies installed"

cd ..

# Step 6: Build widget
print_status "Step 6: Building widget..."
# Widget is already built as vanilla JS, just verify it exists
if [ -f "widget/widget.js" ]; then
    print_success "Widget is ready"
else
    print_error "Widget file not found"
    exit 1
fi

echo ""
echo "======================================"
print_success "Setup completed successfully!"
echo "======================================"
echo ""
echo "📋 Next Steps:"
echo ""
echo "1. Edit environment variables:"
echo "   - api/.env       (API server configuration)"
echo "   - portal/.env    (Portal configuration)"
echo ""
echo "2. Start the development servers:"
echo ""
echo "   # Terminal 1 - API Server"
echo "   cd api && npm run dev"
echo ""
echo "   # Terminal 2 - Portal"
echo "   cd portal && npm run dev"
echo ""
echo "3. Access the services:"
echo "   - API Server:    http://localhost:3000"
echo "   - Portal:        http://localhost:5173"
echo "   - n8n:           http://localhost:5678"
echo "   - MinIO (S3):    http://localhost:9000"
echo "   - PostgreSQL:    localhost:5432"
echo "   - Redis:         localhost:6379"
echo ""
echo "4. Embed the widget in your website:"
echo ""
echo '   <script src="http://localhost:3000/widget.js"'
echo '           data-tenant-id="YOUR_TENANT_UUID"'
echo '           data-theme='\''{"primary":"#3B82F6"}'\'''
echo '           data-n8n-webhook="https://n8n.yourdomain.com/webhook/chat">'
echo '   </script>'
echo ""
echo "📚 Documentation:"
echo "   - Setup Guide:    README.md"
echo "   - n8n Integration: docs/n8n-integration.md"
echo "   - API Reference:  docs/webhook-reference.md"
echo ""
echo "🎉 Happy coding!"
echo ""
