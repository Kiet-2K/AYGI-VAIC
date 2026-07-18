# AYGI-VAIC

## SmartTrafficSimulator

Digital Twin mô phỏng ngã tư giao thông với xe 3D low-poly, camera CCTV cố định, lớp Fake YOLO được chiếu từ bounding volume 3D sang DOM 2D và bộ điều khiển đèn FastAPI realtime.

## Chạy demo

Yêu cầu: Docker Desktop hoặc Docker Engine có Docker Compose.

```bash
docker compose up --build
```

- Frontend: http://localhost:3000
- Backend health: http://localhost:8000/health
- WebSocket: `ws://localhost:8000/ws/traffic`

Frontend chạy trong trình duyệt nên URL WebSocket mặc định là `localhost:8000`; nếu host/port khác, đặt `NEXT_PUBLIC_TRAFFIC_WS_URL` trước khi build frontend.

## Logic đèn

Pha luôn luân phiên an toàn: `NS_GREEN → NS_YELLOW → ALL_RED → EW_GREEN → EW_YELLOW → ALL_RED`.

- Green: `clamp(8, 30, 8 + 2 × số xe chờ lớn nhất của cặp hướng)` giây
- Yellow: 3 giây
- All-red: 1 giây

Frontend báo số xe chờ bốn hướng mỗi 250 ms. Khi WebSocket mất kết nối, scene chuyển all-red an toàn và tự reconnect theo exponential backoff.

## Kiểm thử

Backend:

```bash
cd backend
python -m pip install -r requirements.txt
python -m pytest
```

Frontend:

```bash
cd frontend
npm install
npm run typecheck
npm test
```

E2E yêu cầu khởi động hai service trước, sau đó chạy `npm run test:e2e` trong `frontend/`. Lần đầu cài browser bằng `npx playwright install chromium`.

## Mở rộng phần cứng

`backend/app/hardware.py` có `TrafficLightOutput` protocol và `MockTrafficLightOutput`. Tạo adapter ESP32 serial hoặc Wi-Fi mới cùng method async `set_signals()` để nối mô hình vật lý mà không thay đổi WebSocket hay thuật toán điều khiển.
