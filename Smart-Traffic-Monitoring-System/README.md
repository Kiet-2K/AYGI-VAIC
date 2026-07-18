# Smart Traffic Monitoring System

Hệ thống giám sát giao thông thời gian thực: xử lý video bằng YOLO/ONNX và ByteTrack, cung cấp dữ liệu qua FastAPI REST/WebSocket, rồi hiển thị trên dashboard React. Chatbot Groq hỗ trợ truy vấn tình trạng giao thông bằng ngôn ngữ tự nhiên.

## Kiến trúc

```text
Video đầu vào
  -> YOLO ONNX + ByteTrack + SpeedEstimator
  -> tiến trình xử lý riêng cho từng tuyến đường
  -> FastAPI (REST + WebSocket)
  -> React dashboard / AI chatbot
  -> PostgreSQL lưu người dùng và dữ liệu ứng dụng
```

Backend phải được chạy từ `backend/app` vì các import Python hiện tại dựa trên thư mục làm việc này.

## Công nghệ

- **Frontend:** React 19, Vite, TypeScript, Tailwind CSS, Radix/shadcn, Framer Motion.
- **Backend:** FastAPI, Uvicorn, SQLAlchemy async, asyncpg, PostgreSQL.
- **Computer vision:** Ultralytics YOLO, ONNX Runtime, OpenCV, ByteTrack, SpeedEstimator.
- **Realtime:** WebSocket truyền frame JPEG và chỉ số giao thông.
- **AI assistant:** LangGraph/LangChain và Groq.
- **Authentication:** JWT cho tài khoản và các API cần bảo vệ.

## Tính năng chính

- Đăng ký, đăng nhập và xác thực JWT.
- Dashboard theo dõi frame camera, số ô tô/xe máy và tốc độ trung bình.
- Phân loại trạng thái `Thông thoáng`, `Đông đúc`, `Tắc nghẽn` theo từng tuyến đường.
- Stream frame và số liệu thời gian thực bằng WebSocket.
- Chatbot web truy vấn dữ liệu giao thông.
- Trang quản trị theo dõi CPU, RAM, ổ đĩa và mạng.
- Mã nguồn Telegram vẫn được giữ để mở rộng sau này, nhưng mặc định bị tắt và QR không xuất hiện trên giao diện.

## Yêu cầu

- Python 3.11 trở lên.
- Node.js 18 trở lên và Corepack/pnpm.
- PostgreSQL 16 trở lên.
- Windows, Linux hoặc macOS; GPU NVIDIA là tùy chọn, cấu hình hiện tại chạy ONNX trên CPU.

## Cài đặt và chạy local không dùng container

### 1. PostgreSQL

Tạo database, ví dụ:

```sql
CREATE DATABASE transportation_system;
```

Đảm bảo PostgreSQL đang chạy và tài khoản có quyền truy cập database này.

### 2. Backend

Từ thư mục project:

```bash
cd backend/app
python -m venv .venv
```

Kích hoạt môi trường:

```bash
# Windows PowerShell
.venv\Scripts\Activate.ps1

# Linux/macOS
source .venv/bin/activate
```

Cài dependency CPU:

```bash
python -m pip install -r requirements_cpu.txt
```

Tạo cấu hình local từ file mẫu:

```bash
# Windows PowerShell
Copy-Item .env.example .env

# Linux/macOS
cp .env.example .env
```

Sửa `.env`, đặc biệt là `DATABASE_*`, `JWT_SECRET_KEY` và tùy chọn `GROQ_API_KEY`. Không commit `.env`.

Chạy backend ngay trong `backend/app`:

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

- API: `http://127.0.0.1:8000`
- Swagger: `http://127.0.0.1:8000/docs`

### 3. Frontend

Mở terminal khác tại thư mục project:

```bash
cd frontend
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Frontend chạy tại `http://127.0.0.1:5173`.

Các biến `VITE_*` được đóng vào bundle khi build. Nếu thay API URL, hãy cấu hình trước rồi build lại.

## Model ONNX

Model FP32 đi kèm tại:

```text
backend/app/ai_models/test_onnx/best_fp32_static_640.onnx
```

- Input tĩnh: `1 x 3 x 640 x 640`.
- Classes: `car`, `Motor`.
- Runtime mặc định: CPU qua ONNX Runtime.
- Đường dẫn model được cấu hình trong `backend/app/core/config.py`.

## Cấu hình video

Repository không kèm MP4 để tránh tăng kích thước Git. Cấu hình hiện tại mong đợi:

```text
backend/app/video_test/Văn Phú.mp4
```

Tạo thư mục và đặt video đúng tên, hoặc sửa `PATH_VIDEOS` trong `backend/app/core/config.py`. Khi đổi video/camera, phải hiệu chỉnh đồng bộ:

- `PATH_VIDEOS`
- `REGIONS` (ROI dùng để phân tích)
- `METER_PER_PIXELS` (quy đổi phục vụ ước lượng tốc độ)

Mỗi phần tử của ba danh sách phải cùng chỉ số và mô tả cùng một tuyến đường.

## Kiểm tra và build

Backend syntax check:

```bash
cd backend/app
python -m compileall -q .
```

Frontend production build:

```bash
cd frontend
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

## Bảo mật

- Không commit `.env`, API key, JWT secret hoặc mật khẩu database.
- Dùng secret ngẫu nhiên đủ dài ở môi trường thật.
- Đổi ngay credential nếu từng bị đưa vào source, log hoặc lịch sử Git.
- Endpoint frame không xác thực chỉ phù hợp demo/public; cần rà soát trước khi triển khai Internet.
