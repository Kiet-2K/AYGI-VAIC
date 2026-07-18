# CODEBASE.md — Tài liệu kiến trúc chi tiết

Tài liệu này mô tả kiến trúc thật của codebase (đọc trực tiếp từ code, không suy đoán). Dùng khi cần hiểu sâu một phần cụ thể trước khi sửa code. Xem `CLAUDE.md` để biết quy tắc làm việc chung, `HANDOFF.md` để biết lịch sử thay đổi.

## Tổng quan hệ thống

Hệ thống giám sát giao thông real-time: video các tuyến đường → YOLO detect + ByteTrack track phương tiện → tính tốc độ/số lượng → phục vụ qua FastAPI (REST + WebSocket) → hiển thị trên React dashboard. Có thêm AI chatbot (LangGraph ReAct agent qua Groq) để hỏi đáp về tình trạng giao thông, và Telegram bot dùng chung chatbot đó.

## Backend (`backend/app/`)

Chạy bằng `uvicorn main:app` **từ thư mục `backend/app/`** (không phải `backend/`) — vì `main.py` dùng import tuyệt đối kiểu `from api import v1`, giả định cwd là `backend/app/`.

### Entry point — `main.py`
- FastAPI CORS permits the configured frontend plus localhost/127.0.0.1 local Vite origins, with credentials enabled for browser auth requests.
- `startup` event gọi `create_tables()` (tạo bảng nếu chưa có, không migrate).
- Route `/` redirect sang `settings_network.URL_FRONTEND`.
- Đăng ký 6 router, tất cả prefix `/api/v1`:
  - `api_auth.router` → `/api/v1/auth/*`
  - `api_user.router` → `/api/v1/users/*`
  - `api_vehicles_frames.router` → `/api/v1/*` (roads_name, info, frames, ws/frames, ws/info)
  - `api_chatbot.router` → `/api/v1/*` (chat, chat_no_auth, ws/chat)
  - `chat_history.router` → `/api/v1/chat/*`
  - `api_admin.router` → `/api/v1/admin/*`

### Config — `core/config.py`
Load `.env` qua `python-dotenv` (không path cụ thể → phụ thuộc cwd tiến trình, chính là lý do phải chạy uvicorn từ `backend/app/`).

- `SettingServer`: `DATABASE_URL` (asyncpg), `JWT_SECRET`, `JWT_ALGORITHM`, `ACCESS_TOKEN_EXPIRE_DAYS`
- `SettingMetricTransport`: `REGIONS` (polygon vùng đếm xe, hardcode theo pixel), `PATH_VIDEOS`, `METER_PER_PIXELS`, `MODELS_PATH` (OpenVINO INT8 model), `DEVICE`
- `SettingChatBot`: `GROQ_API_KEY`, `LLM` (ChatGroq, model `llama-3.3-70b-versatile`)
- `SettingNetwork`: `BASE_URL_API`/`URL_FRONTEND` — đọc từ `PUBLIC_API_URL`/`PUBLIC_FRONTEND_URL`, fallback `localhost` khi không set (dùng khi deploy VPS để redirect `/` và build URL ảnh chatbot đúng domain)
- `TRAFFIC_THRESHOLDS`: ngưỡng tốc độ/số lượng để phân loại "thông thoáng/đông đúc/tắc nghẽn" theo từng tuyến đường cụ thể (5 tuyến định nghĩa sẵn, fallback `DEFAULT_THRESHOLD`)

Lưu ý: `backend/app/core/config_chatbot.py` là file trùng lặp/không dùng — `SettingChatBot` thật nằm trong `config.py`, không có nơi nào import từ `config_chatbot.py`. Có thể là tàn dư refactor, nên kiểm tra lại trước khi xoá.

### Database — `db/base.py` + `models/`
- Async SQLAlchemy: `create_async_engine` + `AsyncSessionLocal` (asyncpg driver), `get_db()` yield `AsyncSession`.
- `create_tables()` chỉ `Base.metadata.create_all` — **không có Alembic/migration thật**, đổi schema phải tự tay ALTER hoặc drop & tạo lại.
- Models: `User` (`users`), `ChatMessage` (`chat_messages`), `TokenLLM` (`token_llm`).
- `User`: `id`, `username`, `password` (hash), `role_id` (0=admin, 1=user, default 1), `email`, `phone_number` — quan hệ 1-n với `ChatMessage`.
- `ChatMessage`: lưu lịch sử chat (`message`, `is_user`, `images` JSON, `extra_data` JSON, `created_at`), có `to_dict()` convert cho frontend.

`api/v1/api_user.py` now uses `AsyncSession`, `select()`, and awaited commit/rollback/refresh calls. The live regression test `backend/tests/test_auth_e2e.py` covers credentialed CORS preflight plus register -> login -> `/auth/me` -> profile/password update -> login again.

### Auth — `utils/jwt_handler.py`
- JWT qua `python-jose`, thuật toán từ `settings_server.JWT_ALGORITHM` (mặc định HS256).
- 3 dependency khác nhau:
  - `get_current_user` — chỉ nhận Bearer token qua `Authorization` header (dùng cho REST thường).
  - `get_current_user_ws` — nhận token từ header, cookie `access_token`, hoặc query `?token=` (dùng cho WebSocket vì browser WS không set header tuỳ ý được).
  - `get_user_by_token` — helper chung, decode + query DB.
- Token payload gồm `sub` (email), `uid`, `username`, `email`, `phone_number`, `role_id`.
- Login (`api_auth.py`) set cả token trong response body và cookie `access_token` (httponly, `secure=False` — cần đổi `secure=True` khi deploy HTTPS thật).

### AI Chatbot — `services/chat_services/`
- `ChatBotAgent.py`: dùng `langgraph.prebuilt.create_react_agent`, model là `ChatGroq` (từ `core.config.setting_chatbot`), 2 tools: `get_frame_road`, `get_info_road` (định nghĩa trong `tool_func.py`, gọi vào `state.analyzer` — instance `AnalyzeOnRoadForMultiprocessing` toàn cục).
- Checkpointer `InMemorySaver` — lịch sử hội thoại theo `thread_id = user_id`, **mất khi restart server** (không persist).
- Prompt hệ thống bằng tiếng Việt, ép format trả lời có cấu trúc (tóm tắt, số liệu từng tuyến, khuyến nghị, ảnh nếu được yêu cầu). `response_format=ChatResponse` (Pydantic) để LangGraph parse structured output.
- Route `/api/v1/chat` (auth), `/api/v1/chat_no_auth` (không auth, user_id giả = 9999, dùng cho Telegram bot), `/api/v1/ws/chat` (WebSocket).
- `state.py` giữ 2 singleton toàn cục: `analyzer` (video pipeline) và `agent` (chatbot) — khởi tạo ở `startup` event của từng router tương ứng.

### Video/Traffic pipeline — `services/road_services/`
- `AnalyzeOnRoadForMultiProcessing.py`: mỗi video chạy trong 1 `multiprocessing.Process` riêng (Windows dùng spawn method — code comment giải thích rõ vì sao phải để hàm chạy process ở `@staticmethod` để tránh lỗi pickle object YOLO).
- Dữ liệu chia sẻ giữa main process và sub-process qua `Manager().dict()`: `info_dict` (count_car, count_motor, speed_car, speed_motor) và `frame_dict` (frame JPEG bytes).
- `is_join_processes=False` khi chạy trong API (tránh block event loop); `True` khi chạy như script standalone để test (`if __name__ == '__main__'`).
- Model: OpenVINO INT8 quantized YOLO, đường dẫn cấu hình trong `SettingMetricTransport.MODELS_PATH`, tracker `bytetrack.yaml` (Ultralytics built-in).
- Video test nằm ở `backend/app/video_test/*.mp4`, tên file dùng làm `road_name` (bỏ đuôi `.mp4`), khớp key trong `TRAFFIC_THRESHOLDS`.
- Signal handler + `atexit` đảm bảo terminate hết sub-process khi server tắt (Ctrl+C hoặc SIGTERM), có timeout + force kill fallback.

### Telegram bot — `bot_tele.py`
Bot riêng, chạy độc lập (không phải route FastAPI) — polling qua `python-telegram-bot`, gọi vào backend qua HTTP thật (`requests.post` tới `{BASE_URL_API}/api/v1/chat_no_auth`), không dùng auth. Muốn chạy bot phải chạy `python bot_tele.py` song song với backend, cần `BOT_TOKEN` trong `.env`.

### System metrics — `utils/system_metrics.py`, dùng trong `api_admin.py`
Endpoint admin-only (`role_id == 0`) trả CPU/RAM/Disk/Network qua `psutil`, có cả REST và WebSocket (poll 2s).

## Frontend (`frontend/src/`)

React 19 + Vite 7 + TypeScript, pnpm là package manager chính thức (xác nhận qua `pnpm-lock.yaml`, `.pnpm` virtual store — **không dùng npm**, `package-lock.json` là tàn dư đã xoá).

### Cấu trúc
- `pages/` — `LoginPage`, `ChatPage`, `AnalyticsPage`, `AdminPage`, `ProfilePage` (route-level components)
- `modules/features/` — `auth/`, `chat/`, `traffic/`, `video/` (component theo domain, không theo loại file)
- `modules/shared/components/` — component tái dùng chung
- `ui/` — shadcn/ui + Radix primitives (Tailwind v4)
- `hooks/` — `useWebSocket.ts`, `useTrafficStore.tsx`
- `services/` — `chatHistoryService.ts` (gọi REST API `/api/v1/chat/messages`)
- `config.ts` — **file config chính đang được dùng thật** (import bởi `App.tsx`, hooks, mọi component auth/chat). Đọc `VITE_API_HTTP_BASE`/`VITE_API_WS_BASE` từ env, build sẵn các URL endpoint (`endpoints.roadNames`, `endpoints.framesWs()`, `endpoints.chatWs`, v.v.)
- `config/settings.ts` — file config mở rộng hơn nhiều (feature flags, cache TTL, notification, upload limits...) nhưng **chỉ được import bởi `AdminPage.tsx`** — có vẻ là bản thiết kế lại chưa migrate hết, phần lớn app vẫn dùng `config.ts` cũ hơn.

### Kết nối backend
- REST: base URL từ `apiConfig.API_HTTP_BASE` = `VITE_API_HTTP_BASE` + `/api/v1`.
- WebSocket: 3 kênh — `ws/chat`, `ws/frames/{road}`, `ws/info/{road}` — auth qua token (cách gửi cụ thể xem trong từng hook/component gọi `useWebSocket`).
- Auth token lưu ở `localStorage` (`access_token`, key đặt trong `AuthConfig`/`config.ts`).

### Build/deploy
`vite build` bake `VITE_*` vào bundle tĩnh tại thời điểm build (không đổi được sau khi build xong) — đây là lý do Dockerfile frontend nhận `VITE_API_HTTP_BASE`/`VITE_API_WS_BASE` làm **build-arg**, không phải runtime env.

## Docker & Deploy

Xem `DEPLOY.md` để biết hướng dẫn đầy đủ. Tóm tắt kiến trúc:

```
Internet → Caddy (80/443, tự cấp SSL) ─┬─→ /api/*, /docs, /redoc, /openapi.json → backend:8000
                                        └─→ còn lại (SPA) → frontend:80 (nginx static build)
```

- `docker-compose.yml`: 4 service — `database` (postgres:16), `backend`, `frontend`, `caddy`.
- 2 tầng `.env` khác nhau, **đừng nhầm**:
  - `backend/app/.env` — secret runtime thật của app (JWT, GROQ_API_KEY, BOT_TOKEN, DB credentials) — Compose đọc qua `env_file:`.
  - `.env` ở root — chỉ dùng cho biến `${...}` trong `docker-compose.yml` (domain, public URL, build-args) và **không** được Compose tự áp cho `env_file:` khác.
- `frontend/Dockerfile` is multi-stage: pnpm + Vite build, then a minimal `nginx:alpine` runtime. `nginx.conf` provides SPA fallback and immutable cache headers for `/assets/`; host mapping remains `5173:80` for local checks.
- `Caddyfile` route domain tự động lấy SSL Let's Encrypt, không cần certbot thủ công.
- `backend/.dockerignore` excludes `.venv`, video data, `.env`, and MP4 files from build context; Compose bind-mounts video data at runtime. CPU requirements pin official `+cpu` PyTorch wheels to avoid CUDA downloads, and development-only Alembic, psycopg2, and pytest are excluded from the CPU runtime image.

## Biến môi trường — danh sách đầy đủ

### Backend (đọc qua `os.getenv`, cần trong `backend/app/.env`)
| Biến | Dùng ở đâu | Ghi chú |
|---|---|---|
| `DATABASE_USERNAME/PASSWORD/PORT/HOST/NAME` | `core/config.py` | build `DATABASE_URL` (asyncpg) |
| `JWT_SECRET_KEY` | `core/config.py` | ký JWT — **đổi khi deploy production**, giá trị hiện tại là placeholder demo |
| `JWT_ALGORITHM` | `core/config.py` | mặc định HS256 |
| `ACCESS_TOKEN_EXPIRE_DAYS` | `core/config.py` | hạn token |
| `GROQ_API_KEY` | `core/config.py` (`SettingChatBot`) | API key cho ChatGroq LLM |
| `BOT_TOKEN` | `bot_tele.py` | Telegram bot token |
| `PUBLIC_API_URL` | `core/config.py` (`SettingNetwork`) | fallback `http://localhost:8000` nếu không set |
| `PUBLIC_FRONTEND_URL` | `core/config.py` (`SettingNetwork`) | fallback `http://localhost:5173` nếu không set |

### Frontend (`import.meta.env`, prefix `VITE_`, set lúc build)
`config.ts` (đang dùng thật): `VITE_API_HTTP_BASE`, `VITE_API_WS_BASE`.
`config/settings.ts` (chỉ `AdminPage.tsx` dùng): rất nhiều biến `VITE_*` cho feature flags/UI/cache — xem file trực tiếp nếu cần, không liệt kê hết ở đây vì phần lớn chưa được adopt toàn app.

### Root `.env` (chỉ cho `docker-compose.yml`)
`DOMAIN`, `PUBLIC_API_URL`, `PUBLIC_API_WS_URL`, `PUBLIC_FRONTEND_URL`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`, `DATABASE_NAME` — xem `.env.example`.

## Known issues / kỹ thuật nợ (phát hiện qua đọc code, chưa fix)

1. **`config_chatbot.py` duplication**: it appears unused beside `SettingChatBot` in `config.py`; confirm before deletion.
2. **Chat memory persistence**: LangGraph `InMemorySaver` is reset when the backend restarts.
3. **Production auth cookie**: `secure=False` must become `True` when deployed behind HTTPS.
4. **Two frontend config systems**: most code uses `src/config.ts`, while `AdminPage.tsx` uses `config/settings.ts`.
5. **Migration process**: Alembic files exist, but startup still runs `create_tables()`; schema changes need a clear migration workflow.
6. **Noisy reload logs**: the video multiprocessing signal handler calls `sys.exit()` during `uvicorn --reload`, causing `SystemExit`/`CancelledError` noise although the server restarts.
