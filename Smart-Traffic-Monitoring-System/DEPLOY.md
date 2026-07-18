# Deploy lên VPS (FPT Cloud) qua Docker

Mục tiêu: chạy 1 lần `docker compose up -d --build` trên VPS, có sẵn domain +
HTTPS, mọi người truy cập qua 1 link như web bình thường.

## Yêu cầu trước khi deploy

- VPS đã cài Docker + Docker Compose plugin (`docker compose version` chạy được).
- Domain đã tạo DNS **A record** trỏ về IP public của VPS (bắt buộc — Caddy cần
  domain phân giải đúng để tự cấp SSL qua Let's Encrypt).
- Firewall/Security Group của VPS mở cổng **80** và **443** (HTTP/HTTPS).
- Video test (`backend/app/video_test/*.mp4`) đã có trong repo hoặc tải lên
  VPS (dùng `gdown`, xem README gốc).

## Bước 1 — Clone code lên VPS

```bash
git clone <repo-url>
cd Smart-Traffic-Monitoring-System
```

## Bước 2 — Điền biến môi trường

Có 2 file `.env` cần điền, KHÔNG commit lên git:

1. `backend/app/.env` — secrets thật của app (copy từ `.env.example` cùng thư
   mục nếu có, hoặc tạo mới theo mẫu trong README gốc): `JWT_SECRET_KEY`,
   `GROQ_API_KEY`, `BOT_TOKEN`, `DATABASE_USERNAME/PASSWORD/NAME`...

2. `.env` ở **root** (cùng cấp `docker-compose.yml`) — copy từ `.env.example`:

   ```bash
   cp .env.example .env
   ```

   Sửa:
   ```
   DOMAIN=yourdomain.com
   PUBLIC_API_URL=https://yourdomain.com
   PUBLIC_API_WS_URL=wss://yourdomain.com
   PUBLIC_FRONTEND_URL=https://yourdomain.com
   DATABASE_USERNAME=... # phải khớp với backend/app/.env
   DATABASE_PASSWORD=...
   DATABASE_NAME=...
   ```

   `DOMAIN` dùng để Caddy biết cấp SSL cho domain nào. `PUBLIC_*` dùng để
   frontend build đúng URL gọi API, và backend redirect `/` đúng chỗ.

## Bước 3 — Chạy

```bash
docker compose up -d --build
```

Lần đầu Caddy sẽ tự xin chứng chỉ Let's Encrypt cho `DOMAIN` (cần DNS đã trỏ
đúng và port 80/443 mở, nếu không sẽ retry và log lỗi trong `docker compose
logs caddy`).

Frontend production runs nginx on internal port `80` (host mapping `5173:80`), not the Vite development server.

Sau khi chạy xong, truy cập `https://yourdomain.com` — Caddy tự route:
- `/api/*`, `/docs`, `/redoc`, `/openapi.json` → backend (FastAPI)
- còn lại → frontend (React build tĩnh)

## Kiểm tra

```bash
docker compose ps                 # cả 4 service (database, backend, frontend, caddy) đều Up
docker compose logs -f backend    # xem log FastAPI, đảm bảo kết nối DB thành công
docker compose logs -f caddy      # xem Caddy đã cấp SSL thành công
```

## Cập nhật code sau này

```bash
git pull
docker compose up -d --build
```

## Lưu ý bảo mật / vận hành

- `docker-compose.yml` publish trực tiếp port `5433` (Postgres), `8000`
  (backend), `5173` (frontend) ra ngoài — nếu VPS có firewall public, nên chỉ
  mở 80/443 (Caddy) và chặn các port kia từ ngoài internet, vì hiện traffic
  đã đi qua Caddy nên không cần expose thẳng các port đó ra công cộng.
- Đổi `JWT_SECRET_KEY` trong `backend/app/.env` thành chuỗi random thật khi
  deploy — file mẫu hiện có giá trị demo (`your-secret-key-change-this-in-production`
  hoặc giá trị test), không dùng cho production.
- CORS permits the configured frontend URL plus localhost/127.0.0.1 for local tests. Verify production domain settings and cookie security before deployment.
  — chấp nhận được cho demo nhưng nên siết lại thành domain thật nếu cần an
  toàn hơn.

## Khi cần SSH thật vào VPS

Việc SSH trực tiếp vào VPS (để chạy `docker compose up`, kiểm tra log, debug
thực tế) cần SSH key/thông tin truy cập mà user sẽ cung cấp khi cần — xem
`HANDOFF.md` mục "Chờ user cung cấp" để biết lý do và ngữ cảnh trước khi
thực hiện bước này.

## Build validation status

The production frontend image was built and smoke-tested locally. The optimized backend Docker build was deliberately stopped on July 18, 2026 because the first CPU ML dependency download was taking too long. Before the first VPS deployment, run `docker compose build backend` and verify the resulting backend image and its OpenVINO model files.
