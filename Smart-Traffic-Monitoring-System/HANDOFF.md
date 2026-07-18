# HANDOFF.md — Lịch sử thay đổi & bàn giao giữa các session

Mục đích: giúp session AI sau hiểu nhanh những gì đã làm, đang chờ gì, và vì sao. Không lặp lại nội dung kiến trúc (xem `CODEBASE.md`) hay quy tắc làm việc (xem `CLAUDE.md`).

## Chờ user cung cấp

### SSH key vào VPS (FPT Cloud)
User có VPS trên FPT Cloud, đã có domain riêng, dự định deploy hệ thống này lên đó qua Docker Compose (xem `DEPLOY.md`). User **chưa gửi SSH key/thông tin truy cập VPS** — theo yêu cầu rõ ràng của user, việc gửi key sẽ làm **sau, khi cần**, không phải ngay bây giờ.

Lý do cần ghi lại: nếu một session AI sau này cần SSH thật vào VPS để chạy `docker compose up -d --build`, xem log, debug production — session đó phải hỏi user cung cấp SSH key/thông tin truy cập vào lúc đó, không tự bịa hoặc giả định đã có. Đây không phải việc quên làm, mà là quyết định chủ động của user (trì hoãn cho tới khi thực sự cần dùng).

Khi user gửi key: lưu key ở nơi an toàn ngoài phạm vi git-tracked (không commit key vào repo), dùng để SSH và chạy các bước trong `DEPLOY.md`.

## Đã hoàn thành

### Chạy được website ở local (2026-07-17)
- Cài PostgreSQL 17 (winget) trên Windows local để test full flow trước khi lên VPS.
- Set password role `postgres` = `odoo`, tạo database `transportation_system`, sửa `DATABASE_PORT` trong `backend/app/.env` từ `5433` → `5432` để khớp cổng thật của PostgreSQL local (Docker Compose không bị ảnh hưởng vì nó tự override `DATABASE_PORT: 5432` bên trong container, độc lập với `.env`).
- Backend chạy được từ `backend/app/` bằng `uvicorn main:app` — DB connect thành công, `create_tables()` chạy xong, model YOLO/OpenVINO load được cho cả 2 tuyến đường test, `/docs` trả 200.
- Frontend chạy được bằng `pnpm dev` (dùng binary local `node_modules/.bin/pnpm` vì pnpm không có sẵn trên PATH của máy này) — Vite dev server trả 200 ở `http://localhost:5173`.

### Chuẩn bị deploy VPS qua Docker + Caddy (trước đó)
- Gộp 2 file `.env` trùng lặp về một chuẩn (`backend/app/.env`), xoá `backend/.env` cũ.
- Sửa `core/config.py` — `SettingNetwork.BASE_URL_API`/`URL_FRONTEND` đọc từ env `PUBLIC_API_URL`/`PUBLIC_FRONTEND_URL`, fallback localhost khi không set — để redirect `/` và URL ảnh chatbot đúng domain khi deploy.
- Viết `Caddyfile` — reverse proxy tự cấp HTTPS (Let's Encrypt), route `/api/*`, `/docs`, `/redoc`, `/openapi.json` → backend, còn lại → frontend.
- Sửa `docker-compose.yml` — thêm service `caddy`, `env_file` đúng cho từng service, thêm `.env.example` ở root riêng cho biến `${...}` của Compose (khác với `backend/app/.env`).
- Sửa `frontend/Dockerfile` thành multi-stage: build bằng pnpm + Vite, serve static bằng package `serve` (không dùng `pnpm dev` cho production).
- Viết `DEPLOY.md` — hướng dẫn đầy đủ chạy trên VPS: điền 2 file `.env`, `docker compose up -d --build`, DNS A record, firewall 80/443.
- Bổ sung `langchain_groq` vào `requirements_cpu.txt`/`requirements_gpu.txt` (bị thiếu dù `core/config.py` import trực tiếp — nếu không cài, backend crash lúc import config).
- Dọn frontend package manager: xoá `package-lock.json` (npm, trùng lặp), bỏ `pnpm` ra khỏi `dependencies` (không phải app dep), chuyển `serve` từ devDependencies sang dependencies (cần lúc runtime container).

## Quyết định đã bị từ chối / đổi hướng (để tránh lặp lại)

- **Cloudflare D1 làm database thay PostgreSQL** — đã lên plan rewrite toàn bộ DB layer (D1Client, bỏ SQLAlchemy dialect, viết lại models/routes) nhưng **user từ chối** sau khi thấy phạm vi thay đổi quá lớn, chuyển hướng sang deploy PostgreSQL thật lên VPS. Không quay lại hướng D1 trừ khi user chủ động yêu cầu lại.

## Việc còn tồn đọng (biết nhưng chưa fix, xem chi tiết ở CODEBASE.md phần "Known issues")

1. `backend/app/core/config_chatbot.py` nghi là file trùng lặp không dùng, cần xác nhận trước khi xoá.
2. Chat memory của AI agent (LangGraph `InMemorySaver`) không persist qua restart.
3. Production auth cookie: `secure=False` must be changed to `secure=True` behind HTTPS.
5. Chưa có Alembic/migration — đổi schema DB phải tự tay.
6. Chưa triển khai thật lên VPS (đang chờ SSH key theo mục trên).
7. Chưa thiết lập cơ chế logging riêng cho các session AI làm việc trên project này (task còn treo, chưa bắt đầu).

## Auth regression and Docker build status (2026-07-18)

- Fixed the local browser CORS preflight failure: the API permits both `localhost` and `127.0.0.1` Vite origins, so registration/login works from either local URL.
- Added/expanded `backend/tests/test_auth_e2e.py` for live CORS preflight, register success, duplicate rejection, bad-password rejection, email/username login, `/auth/me`, profile update, password change, old-password rejection, and new-password login.
- Ran against the real local PostgreSQL/API: `2 passed`; logs showed expected 201, 400, 401, and 200 responses.
- Browser verification at `http://127.0.0.1:5173`: registered a new account, logged in, reached `/home`, fetched account/road data, and opened authenticated traffic WebSockets.
- Docker optimization changes remain in the workspace. The long cold backend image build was deliberately stopped at the user's request, so a full backend-image rebuild/verification is still required before production deployment.
- Docker builders, backend/video processes, and browser test tabs were stopped after verification to release resources.
