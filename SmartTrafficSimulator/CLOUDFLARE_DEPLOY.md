# Hướng dẫn Deploy lên Cloudflare + Railway

## Tổng quan

Do backend Python (FastAPI + SQLite + asyncio loop) không thể chạy trên Cloudflare Workers, ta sẽ deploy:
- **Frontend**: Cloudflare Pages (static export)
- **Backend**: Railway.app (miễn phí, hỗ trợ Docker)

## Bước 1: Chuẩn bị Backend cho Railway

### 1.1. Tạo file `railway.toml` (cấu hình Railway)

Tạo file này ở thư mục gốc project:

```toml
[build]
builder = "dockerfile"
dockerfilePath = "backend/Dockerfile"

[deploy]
startCommand = "uvicorn app.main:app --host 0.0.0.0 --port $PORT"
healthcheckPath = "/health"
healthcheckTimeout = 100
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 10
```

### 1.2. Cập nhật CORS trong backend

File `backend/app/main.py` cần cho phép domain Cloudflare Pages. Sau khi deploy frontend, thêm domain vào:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "https://your-project.pages.dev",  # Thêm domain Cloudflare của bạn
    ],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)
```

## Bước 2: Deploy Backend lên Railway

### 2.1. Tạo tài khoản Railway

1. Vào https://railway.app
2. Đăng ký bằng GitHub
3. Free plan có $5/tháng credit (đủ cho 1 backend nhỏ)

### 2.2. Deploy từ GitHub

**Cách 1: Deploy từ GitHub (Khuyến nghị)**

1. Push code lên GitHub repository
2. Trong Railway dashboard: **New Project** → **Deploy from GitHub repo**
3. Chọn repository `AYGI-VAIC/SmartTrafficSimulator`
4. Railway tự detect Dockerfile và build
5. Lấy URL backend (dạng: `https://your-backend.railway.app`)

**Cách 2: Deploy từ CLI**

```bash
# Cài Railway CLI
npm install -g @railway/cli

# Login
railway login

# Tạo project mới
cd D:\SMTF\AYGI-VAIC\SmartTrafficSimulator
railway init

# Deploy
railway up

# Lấy domain public
railway domain
```

### 2.3. Cấu hình biến môi trường (nếu cần)

Trong Railway dashboard → Variables, có thể thêm:
- `PORT` (Railway tự set)
- Các biến khác nếu cần

## Bước 3: Chuẩn bị Frontend cho Cloudflare Pages

### 3.1. Cấu hình Next.js cho static export

File `frontend/next.config.js` đã được tạo với nội dung:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: 'out',
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
};

module.exports = nextConfig;
```

### 3.2. Cập nhật WebSocket URL

Tạo file `frontend/.env.production`:

```bash
NEXT_PUBLIC_TRAFFIC_WS_URL=wss://your-backend.railway.app/ws/traffic
```

**Quan trọng**: Thay `your-backend.railway.app` bằng domain Railway thực tế của bạn!

### 3.3. Build frontend local để test

```bash
cd D:\SMTF\AYGI-VAIC\SmartTrafficSimulator\frontend
npm install
npm run build
```

Thư mục `out/` sẽ chứa static files.

## Bước 4: Deploy Frontend lên Cloudflare Pages

### 4.1. Từ Cloudflare Dashboard (Dễ nhất)

1. Đăng nhập https://dash.cloudflare.com
2. Vào **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. Chọn GitHub repository
4. Cấu hình build:

```
Framework preset: Next.js (Static HTML Export)
Build command: cd frontend && npm install && npm run build
Build output directory: frontend/out
```

5. **Environment variables**:
```
NEXT_PUBLIC_TRAFFIC_WS_URL = wss://your-backend.railway.app/ws/traffic
```

6. Click **Save and Deploy**

### 4.2. Từ Wrangler CLI (Nếu muốn)

```bash
# Cài Wrangler CLI
npm install -g wrangler

# Login Cloudflare
wrangler login

# Build frontend
cd D:\SMTF\AYGI-VAIC\SmartTrafficSimulator\frontend
npm run build

# Deploy
npx wrangler pages deploy out --project-name=smart-traffic
```

## Bước 5: Cập nhật CORS Backend (Quan trọng!)

Sau khi frontend deploy xong, bạn có URL kiểu: `https://smart-traffic.pages.dev`

Cập nhật `backend/app/main.py`:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "https://smart-traffic.pages.dev",  # Thêm domain Cloudflare Pages
    ],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)
```

Commit và push lại → Railway tự redeploy.

## Bước 6: Test Production

1. Mở `https://smart-traffic.pages.dev`
2. Kiểm tra:
   - 3D scene load được không
   - WebSocket kết nối (xem ConnectionState ở dashboard)
   - Đèn giao thông đổi màu
   - Violation logs

## Các lệnh tóm tắt (Copy-paste)

```bash
# === BUILD FRONTEND ===
cd D:\SMTF\AYGI-VAIC\SmartTrafficSimulator\frontend
npm install
npm run build

# === TEST LOCAL ===
# Terminal 1 - Backend
cd D:\SMTF\AYGI-VAIC\SmartTrafficSimulator\backend
docker build -t traffic-backend .
docker run -p 8000:8000 traffic-backend

# Terminal 2 - Frontend
cd D:\SMTF\AYGI-VAIC\SmartTrafficSimulator\frontend
npm run dev

# === DEPLOY ===
# Railway CLI (backend)
cd D:\SMTF\AYGI-VAIC\SmartTrafficSimulator
railway init
railway up

# Wrangler CLI (frontend)
cd frontend
npx wrangler pages deploy out --project-name=smart-traffic
```

## Lưu ý quan trọng

### WebSocket URL phải dùng `wss://` (không phải `ws://`)
Railway cung cấp HTTPS, Cloudflare Pages cũng dùng HTTPS → WebSocket phải là `wss://`

### Railway Free Tier Limits
- $5 credit/tháng (≈ 500 giờ runtime)
- Backend tự sleep sau 5 phút không dùng → request đầu tiên sẽ chậm ~10s (cold start)

### Cloudflare Pages Limits
- Miễn phí không giới hạn bandwidth
- Build: 500 builds/tháng (đủ dùng)

## Troubleshooting

### Frontend không kết nối được backend
- Check CORS: Domain frontend có trong `allow_origins` chưa?
- Check WebSocket URL: Phải là `wss://` không phải `ws://`
- Check Railway logs: `railway logs`

### Backend crash
- Check logs trong Railway dashboard → Deployments → View logs
- Kiểm tra healthcheck: `curl https://your-backend.railway.app/health`

### Build frontend lỗi
```bash
# Clear cache
cd frontend
rm -rf .next out node_modules
npm install
npm run build
```

## Chi phí ước tính

- **Cloudflare Pages**: $0 (miễn phí)
- **Railway**: $0 nếu dùng < $5/tháng (≈ 20 ngày 24/7)
- **Tổng**: Miễn phí cho demo/testing

---

**Tóm lại**: Frontend → Cloudflare Pages (static), Backend → Railway (Docker). Cả hai đều có free tier đủ dùng!
