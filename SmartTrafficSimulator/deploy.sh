#!/bin/bash
# Script deploy nhanh lên Cloudflare Pages + Railway

set -e

echo "=== DEPLOY SMART TRAFFIC SIMULATOR ==="
echo ""

# Kiểm tra Railway CLI
if ! command -v railway &> /dev/null; then
    echo "⚠️  Railway CLI chưa cài. Cài bằng: npm install -g @railway/cli"
    exit 1
fi

# Kiểm tra Wrangler CLI
if ! command -v wrangler &> /dev/null; then
    echo "⚠️  Wrangler CLI chưa cài. Cài bằng: npm install -g wrangler"
    exit 1
fi

echo "✅ CLI tools OK"
echo ""

# Deploy backend lên Railway
echo "📦 Deploying backend to Railway..."
railway up

echo ""
echo "🔗 Getting backend URL..."
BACKEND_URL=$(railway domain 2>&1 | grep -oP 'https://[^\s]+' | head -1)

if [ -z "$BACKEND_URL" ]; then
    echo "⚠️  Không lấy được Railway URL. Vui lòng lấy thủ công từ Railway dashboard."
    echo "   Sau đó cập nhật frontend/.env.production"
    exit 1
fi

echo "✅ Backend deployed: $BACKEND_URL"
echo ""

# Cập nhật frontend env
WS_URL="wss://${BACKEND_URL#https://}/ws/traffic"
echo "📝 Updating frontend/.env.production with: $WS_URL"
echo "NEXT_PUBLIC_TRAFFIC_WS_URL=$WS_URL" > frontend/.env.production

# Build frontend
echo ""
echo "🔨 Building frontend..."
cd frontend
npm install
npm run build

# Deploy frontend lên Cloudflare Pages
echo ""
echo "☁️  Deploying frontend to Cloudflare Pages..."
npx wrangler pages deploy out --project-name=smart-traffic

echo ""
echo "✅ DEPLOY HOÀN TẤT!"
echo ""
echo "📌 Backend:  $BACKEND_URL"
echo "📌 Frontend: https://smart-traffic.pages.dev (hoặc URL Cloudflare cung cấp)"
echo ""
echo "🔧 Nhớ cập nhật CORS trong backend/app/main.py với domain frontend!"
