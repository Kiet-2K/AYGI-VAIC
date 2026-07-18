# AYGI-VAIC

Repository tổng hợp các dự án Smart Traffic.

## Các dự án

### SmartTrafficSimulator

Mô phỏng bản sao số ngã tư giao thông với frontend Next.js/Three.js và backend FastAPI điều khiển tín hiệu realtime.

- Thư mục dự án: [`SmartTrafficSimulator/`](./SmartTrafficSimulator/)
- Hướng dẫn chạy: [`SmartTrafficSimulator/README.md`](./SmartTrafficSimulator/README.md)
- Backend: [`SmartTrafficSimulator/backend/`](./SmartTrafficSimulator/backend/)
- Frontend: [`SmartTrafficSimulator/frontend/`](./SmartTrafficSimulator/frontend/)

## Quy tắc cấu trúc

Mỗi dự án mới được đặt thành một thư mục riêng ở root repository, ví dụ:

```text
AYGI-VAIC/
├── SmartTrafficSimulator/
├── SmartTrafficHardware/
└── README.md
```

Không đặt `.git` lồng bên trong các thư mục dự án. Mỗi dự án tự quản lý tài liệu, dependency và lệnh chạy trong thư mục của mình.
