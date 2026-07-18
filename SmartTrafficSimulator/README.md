# AYGI-VAIC — SmartTrafficSimulator

Mô phỏng bản sao số ngã tư giao thông thông minh bằng xe 3D low-poly, camera CCTV, lớp phát hiện giả lập theo bounding box và bộ điều khiển tín hiệu realtime từ backend FastAPI.

## Tính năng chính

- Mô phỏng phương tiện theo tuyến, làn, hướng đi và hành vi bám xe.
- Điều khiển bốn pha bảo vệ:
  - `NS_LEFT`
  - `NS_STRAIGHT_RIGHT`
  - `EW_LEFT`
  - `EW_STRAIGHT_RIGHT`
- Chuyển pha an toàn qua `GREEN → YELLOW → ALL_RED`.
- Ưu tiên xe cứu thương, cứu hỏa, công an và quân sự.
- Theo dõi tổng xe, xe chờ, tải PCU, thời gian chờ và độ chiếm dụng.
- Hiển thị detection overlay, track ID, biển số và hành vi vi phạm.
- Dashboard tiếng Việt với trạng thái backend, latency và điều khiển thủ công.
- Khi backend mất kết nối hoặc telemetry quá hạn, hệ thống giữ toàn đỏ an toàn.

## Kiến trúc

```text
Frontend simulation
  └─ traffic_report (~10 Hz)
       └─ WebSocket /ws/traffic
            └─ FastAPI authoritative controller (~20 Hz)
                 └─ signal_state (~10 Hz và khi trạng thái thay đổi)
                      └─ Frontend áp dụng tín hiệu cho mô phỏng 3D
```

Backend là nguồn quyết định tín hiệu duy nhất khi ứng dụng chạy. Frontend tạo phương tiện và telemetry, gửi dữ liệu cho backend rồi thi hành `signal_state` nhận lại.

## Cấu trúc dự án

```text
SmartTrafficSimulator/
├── backend/                 # FastAPI, controller, schema và pytest
│   ├── app/
│   ├── tests/
│   └── requirements.txt
├── frontend/                # Next.js, React Three Fiber, Vitest, Playwright
│   ├── app/
│   ├── components/
│   ├── hooks/
│   ├── lib/sim/
│   └── types/
├── .env.example             # Biến môi trường cho Docker Compose
├── docker-compose.yml
└── README.md
```

## Yêu cầu

### Chạy bằng Docker

- Docker Desktop hoặc Docker Engine.
- Docker Compose v2.

### Chạy local

- Python 3.12 khuyến nghị.
- Node.js 22 khuyến nghị.
- npm.

## Chạy nhanh bằng Docker Compose

Sau khi clone repository, đi vào thư mục dự án:

```bash
cd SmartTrafficSimulator
```

Tạo file môi trường từ mẫu:

```bash
cp .env.example .env
```

Khởi động hệ thống:

```bash
docker compose up --build
```

Mặc định:

- Frontend: http://localhost:3000
- Backend health: http://localhost:8000/health
- WebSocket: `ws://localhost:8000/ws/traffic`

Dừng hệ thống:

```bash
docker compose down
```

## Chạy local

### 1. Backend

Từ thư mục gốc dự án:

```bash
cd backend
python -m venv .venv
```

Kích hoạt môi trường ảo:

```bash
# Windows PowerShell
.venv\Scripts\Activate.ps1

# Windows Git Bash
source .venv/Scripts/activate

# Linux/macOS
source .venv/bin/activate
```

Cài dependency và chạy backend:

```bash
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Kiểm tra health endpoint tại http://localhost:8000/health.

### 2. Frontend

Mở terminal khác:

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Mở http://localhost:3000.

Nếu backend chạy ở cổng khác, cập nhật `frontend/.env.local` trước khi khởi động frontend:

```dotenv
NEXT_PUBLIC_TRAFFIC_WS_URL=ws://localhost:8001/ws/traffic
E2E_BASE_URL=http://localhost:3000
```

Sau khi thay đổi biến `NEXT_PUBLIC_*`, cần khởi động lại hoặc build lại frontend.

## Biến môi trường

### Root `.env` — Docker Compose

| Biến | Mặc định | Mục đích |
|---|---|---|
| `BACKEND_PORT` | `8000` | Cổng backend được mở trên máy host |
| `FRONTEND_PORT` | `3000` | Cổng frontend được mở trên máy host |
| `TRAFFIC_WS_URL` | `ws://localhost:8000/ws/traffic` | WebSocket URL mà trình duyệt sử dụng |

### Frontend `.env.local`

| Biến | Mặc định trong code | Mục đích |
|---|---|---|
| `NEXT_PUBLIC_TRAFFIC_WS_URL` | `ws://localhost:8000/ws/traffic` | Kết nối frontend tới backend realtime |
| `E2E_BASE_URL` | `http://localhost:3000` | Base URL cho Playwright |

Không commit `.env` hoặc `.env.local`. Chỉ commit các file `.env.example` không chứa credential.

> `TRAFFIC_WS_URL` là URL được trình duyệt truy cập, vì vậy khi chạy Docker local nên dùng `localhost` và cổng host thay vì hostname nội bộ `backend`.

## Kiểm thử

### Backend

```bash
cd backend
python -m pytest
```

### Frontend

```bash
cd frontend
npm run typecheck
npm test
npm run build
```

### End-to-end

Khởi động backend và frontend trước, sau đó:

```bash
cd frontend
npx playwright install chromium
npm run test:e2e
```

Để chạy E2E ở URL khác:

```bash
E2E_BASE_URL=http://localhost:3001 npm run test:e2e
```

## API realtime

- `GET /health`: kiểm tra backend.
- `WS /ws/traffic`: nhận telemetry, gửi signal state, command acknowledgement và sự kiện vi phạm.

Các loại message chính:

- `traffic_report`
- `signal_state`
- `control_command`
- `control_ack`
- `violation_event`
- `error`

## Xử lý lỗi thường gặp

### Cổng đã được sử dụng

Nếu xuất hiện `EADDRINUSE` hoặc `WinError 10048`, chọn cổng host khác.

Chạy local với backend `8001` và frontend `3001`:

```bash
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Trong `frontend/.env.local`:

```dotenv
NEXT_PUBLIC_TRAFFIC_WS_URL=ws://localhost:8001/ws/traffic
E2E_BASE_URL=http://localhost:3001
```

Sau đó:

```bash
cd frontend
npm run dev -- --port 3001
```

Với Docker Compose, chỉnh đồng thời cổng host và URL trình duyệt trong `.env`:

```dotenv
BACKEND_PORT=8001
FRONTEND_PORT=3001
TRAFFIC_WS_URL=ws://localhost:8001/ws/traffic
```

### Dashboard báo mất kết nối backend

1. Kiểm tra `/health` có trả `{"status":"ok"}` không.
2. Kiểm tra `NEXT_PUBLIC_TRAFFIC_WS_URL` hoặc `TRAFFIC_WS_URL`.
3. Khởi động lại frontend sau khi đổi biến môi trường.
4. Kiểm tra firewall hoặc proxy có chặn WebSocket không.

### Build Next.js lỗi trong `.next`

Không chạy `next build` đồng thời với `next dev` trong cùng thư mục. Dừng dev server rồi chạy lại `npm run build`.

## Mở rộng phần cứng

`backend/app/hardware.py` cung cấp `TrafficLightOutput` protocol và `MockTrafficLightOutput`. Có thể thêm adapter ESP32 qua serial hoặc Wi-Fi bằng cùng phương thức async `set_signals()` mà không cần thay đổi giao thức WebSocket hoặc controller.
