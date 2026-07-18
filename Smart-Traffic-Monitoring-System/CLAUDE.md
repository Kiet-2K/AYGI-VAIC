# CLAUDE.md — Hướng dẫn cho AI Agent làm việc trên project này

Đọc file này trước. Đọc `CODEBASE.md` khi cần hiểu sâu kiến trúc. Đọc `HANDOFF.md` để biết lịch sử thay đổi và việc còn tồn đọng.

## Project là gì

Smart Traffic Monitoring System: video giám sát giao thông → YOLO + ByteTrack phát hiện/đếm phương tiện → FastAPI phục vụ dữ liệu (REST + WebSocket) → React dashboard hiển thị real-time. Có AI chatbot (LangGraph ReAct agent qua Groq) trả lời câu hỏi về tình trạng giao thông, dùng chung cho cả web và Telegram bot.

Stack: FastAPI (async, SQLAlchemy+asyncpg) + PostgreSQL, React 19 + Vite 7 + TypeScript + shadcn/Radix/Tailwind, Docker Compose + Caddy cho deploy.

## Chạy project

**Backend** — bắt buộc chạy từ `backend/app/` (không phải `backend/`), vì `main.py` dùng import tuyệt đối kiểu `from api import v1` giả định cwd đó:
```bash
cd backend/app
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
Cần PostgreSQL đang chạy và khớp credentials trong `backend/app/.env` (`DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME`).

**Frontend**:
```bash
cd frontend
pnpm dev
```
Dùng **pnpm**, không dùng npm (xác nhận qua `pnpm-lock.yaml`).

**Docker Compose** (dev local hoặc deploy VPS) — xem `DEPLOY.md`.

## Quy tắc quan trọng khi sửa code ở đây

- **2 file `.env` khác nhau, đừng nhầm**: `backend/app/.env` (secret runtime của app khi chạy local/uvicorn) vs `.env` ở root (chỉ dùng cho biến `${...}` trong `docker-compose.yml`). Sửa 1 file không tự đồng bộ sang file kia.
- **`DATABASE_PORT` trong `backend/app/.env` phải khớp Postgres đang chạy thật ở máy đó** — khi chạy qua Docker Compose, port luôn là `5432` bên trong container (override cứng trong compose file), không phụ thuộc `.env`.
- **`VITE_*` env của frontend bị bake vào bundle lúc build** (Vite), không đổi được sau khi build xong — nếu cần đổi backend URL sau khi build, phải build lại, không sửa runtime.
- **Không sửa `DEVICE`/model path trong `SettingMetricTransport`** trừ khi chắc chắn model OpenVINO tương ứng có tồn tại ở `backend/app/ai_models/`.
- Code có nhiều comment tiếng Việt giải thích lý do kỹ thuật (đặc biệt multiprocessing trên Windows) — đọc comment trước khi refactor, tránh phá vỡ giả định đã ghi rõ (ví dụ vì sao method chạy process phải là `@staticmethod`).
- Trước khi sửa 1 file trong `api/v1/`, kiểm tra file đó dùng `Session` (sync, sai) hay đúng `AsyncSession` (`select()` + `await db.execute()`) — xem mục "Known issues" trong `CODEBASE.md`, đừng lặp lại lỗi sync/async mismatch đã có ở `api_user.py`.

## Khi làm task deploy/VPS

User có VPS FPT Cloud + domain riêng, muốn deploy tối giản (một lệnh `docker compose up -d --build`, tự có SSL). Xem `DEPLOY.md` cho quy trình đầy đủ. **SSH key vào VPS chưa được cung cấp** — xem `HANDOFF.md` mục "Chờ user cung cấp" trước khi giả định có quyền truy cập VPS thật.

## Khi làm task liên quan DB

Đã thử và **bị từ chối**: thay PostgreSQL bằng Cloudflare D1 (rewrite quá lớn, không có SQLAlchemy dialect). Không đề xuất lại hướng này trừ khi user chủ động yêu cầu.

## Cập nhật tài liệu

Sau khi hoàn thành một task đáng kể (sửa kiến trúc, fix bug quan trọng, thay đổi quyết định deploy), cập nhật `HANDOFF.md` (mục "Đã hoàn thành") và `CODEBASE.md` (nếu kiến trúc thay đổi) để session sau không phải đọc lại toàn bộ code từ đầu.
