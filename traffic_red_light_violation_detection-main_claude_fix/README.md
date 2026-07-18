# 🚦 Ngã Tư Thông Minh – Đếm Xe + Điều Khiển Đèn + Phát Hiện Vượt Đèn Đỏ
## Traffic Red Light Violation Detection v3.0

> Camera (AI YOLOv8) đếm xe → Laptop → Arduino Mega điều khiển đèn thích ứng → lưu vi phạm Excel

### Sơ đồ luồng
```
   CAMERA (dọc + ngang)          LAPTOP (main.py)              ARDUINO MEGA (Ethernet)
   ├─ nhận diện + đếm xe   ──►    ├─ gom số xe mỗi chu kỳ  ──►  ├─ COUNT: chỉnh thời gian đèn xanh
   └─ đọc biển số               ├─ nhận LIGHT từ Mega   ◄──  ├─ điều khiển đèn 2 pha + LED 7 đoạn
                                 ├─ bắt xe vượt đèn đỏ        └─ đẩy trạng thái đèn (LIGHT) về PC
                                 └─ lưu Excel + CSV + ảnh
```
- **Mega là bộ điều khiển đèn**: biết chính xác đang đỏ/xanh → laptop lấy đèn từ Mega để bắt vi phạm.
- Đèn 2 pha: trục **dọc** (Bắc-Nam) và **ngang** (Đông-Tây) luôn ngược pha.

---

## 📦 Cài Đặt

```bash
pip install -r requirements.txt
```

---

## 🖥️ Cấu Trúc File

```
traffic_red_light_violation_detection-main/
├── main.py                     ← Chương trình chính (chạy file này)
├── camera_manager.py           ← Quản lý camera (thread riêng)
├── violation_detector.py       ← Phát hiện vi phạm (state machine, hỗ trợ 2 hướng)
├── vehicle_counter.py          ← Đếm xe qua vạch theo track_id
├── arduino_comm.py             ← Giao tiếp TCP với Mega (gửi COUNT, nhận LIGHT)
├── arduino_mega_ethernet.ino   ← Code nạp cho Mega: điều khiển đèn 2 pha thích ứng
├── train_colab.ipynb           ← Notebook train model trên Google Colab (GPU free)
├── test_camera.py              ← Kiểm tra camera trước khi chạy
├── test_arduino.py             ← Kiểm tra kết nối Mega (COUNT + LIGHT)
├── requirements.txt
├── models/
│   ├── vehicle/vehicle.pt                    ← nhận diện xe (cars, motorbike)
│   └── license_plate/
│       ├── license_plate_detection.pt        ← phát hiện vùng biển số
│       └── license_plate_ocr.pt              ← đọc ký tự biển số (0-9, A-Z)
├── violations.xlsx          ← File Excel vi phạm (tự tạo)
├── violations/              ← Ảnh vi phạm: toàn cảnh + crop (tự tạo)
├── logs/                    ← CSV log + screenshot (tự tạo)
└── plates_cropped/          ← Ảnh biển số cắt ra (tự tạo)
```

> **Dùng model ĐÃ TRAIN của bạn** (không phải YOLO COCO generic):
> `vehicle.pt` (cars, motorbike) + `license_plate_ocr.pt` (đọc ký tự bằng YOLO).
> Model `traffic_light.pt` **không còn dùng** vì đèn lấy trực tiếp từ Mega.

---

## 🚀 Cách Chạy

### Bước 1 – Kiểm tra camera
```bash
python test_camera.py               # Webcam mặc định (index 0)
python test_camera.py --camera 1    # Webcam khác
```
- Nhấn `+`/`-` để điều chỉnh vạch dừng
- Ghi nhớ số Y của vạch dừng để dùng ở bước 3

### Bước 2 – (Tùy chọn) Kiểm tra Arduino Mega
```bash
python test_arduino.py --host 192.168.1.200
```

### Bước 3 – Chạy hệ thống
```bash
# 1 camera (test trước – tuyến ngang coi như 0 xe)
python main.py --camera-v 0 --arduino 192.168.1.200

# 2 camera đầy đủ (dọc = index 0, ngang = index 1)
python main.py --camera-v 0 --camera-h 1 --arduino 192.168.1.200

# Chạy thử KHÔNG Mega, ép đèn đỏ để test bắt vi phạm + ghi Excel
python main.py --camera-v 0 --force-red

# IP camera RTSP cho trục dọc
python main.py --camera-v rtsp://admin:123@192.168.1.50:554/stream --arduino 192.168.1.200

# Chạy nhanh hơn trên CPU yếu
python main.py --camera-v 0 --imgsz 416 --frame-skip 4

# Đặt vạch dừng / vạch đếm thủ công
python main.py --camera-v 0 --stop-line-v 450 --count-line-v 450
```

### Tham số quan trọng
| Tham số | Mặc định | Ý nghĩa |
|---------|----------|---------|
| `--camera-v` | 0 | Camera trục DỌC (index webcam hoặc RTSP) |
| `--camera-h` | (tắt) | Camera trục NGANG. Bỏ trống = chạy 1 cam |
| `--stop-line-v/-h` | 65% cao | Y vạch dừng (bắt vi phạm) mỗi trục |
| `--count-line-v/-h` | = vạch dừng | Y vạch đếm xe mỗi trục |
| `--count-interval` | 10 | Chu kỳ (giây) gửi số xe cho Mega |
| `--arduino` | (tắt) | IP Mega, bỏ trống = chạy offline |
| `--force-red` | tắt | Ép đèn đỏ để test vi phạm khi không có Mega |
| `--direction` | up | Hướng xe vi phạm: `up`/`down`/`auto` |
| `--imgsz` | 480 | Kích thước inference (giảm = nhanh hơn) |
| `--frame-skip` | 3 | Xử lý 1 trong N frame |
| `--ocr-engine` | yolo | `yolo` (model đã train) hoặc `easyocr` |
| `--xlsx` | violations.xlsx | File Excel lưu vi phạm |

---

## ⌨️ Phím Tắt Khi Chạy

| Phím | Tác dụng |
|------|----------|
| `q`  | Thoát chương trình |
| `s`  | Chụp screenshot lưu vào `logs/` |
| `+`  | Tăng Y vạch dừng (dịch xuống) |
| `-`  | Giảm Y vạch dừng (dịch lên) |

---

## 🔌 Phần Cứng Arduino Mega

### Kết Nối

| Thiết bị | Chân Arduino |
|---------|-------------|
| Ethernet Shield W5100/W5500 | Cắm trực tiếp lên Mega |
| Đèn ĐỎ trục DỌC | Pin 22 |
| Đèn VÀNG trục DỌC | Pin 24 |
| Đèn XANH trục DỌC | Pin 26 |
| Đèn ĐỎ trục NGANG | Pin 23 |
| Đèn VÀNG trục NGANG | Pin 25 |
| Đèn XANH trục NGANG | Pin 27 |
| Còi báo vi phạm | Pin 9 |
| Relay | Pin 5 |
| LED trạng thái | Pin 13 |
| LED 7 đoạn DỌC (DATA/CLOCK/LATCH) | Pin 2 / 3 / 4 *(tùy chọn)* |
| LED 7 đoạn NGANG (DATA/CLOCK/LATCH) | Pin 6 / 7 / 8 *(tùy chọn)* |
| LCD I2C 20x4 (SDA/SCL) | Pin 20 / 21 *(tùy chọn)* |

### Thư Viện Cần Cài (Library Manager)
- `Ethernet` (có sẵn)
- `LiquidCrystal I2C` by Frank de Brabander *(chỉ khi bật LCD)*
- **KHÔNG cần ArduinoJson** — file `.ino` parse JSON bằng tay.

### Cấu Hình IP Arduino
Mở file `arduino_mega_ethernet.ino`, chỉnh IP cho khớp mạng LAN của bạn:
```cpp
byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0x01 };
IPAddress ip(192, 168, 1, 200);  // ← Đổi IP này! Dùng ở: --arduino 192.168.1.200
IPAddress gateway(192, 168, 1, 1);
```
- Bật LED 7 đoạn đếm ngược: bỏ comment `// #define USE_7SEG` trong file `.ino`.
- Bật LCD: bỏ comment `// #define USE_LCD`.
- Chỉnh thời gian đèn: sửa `T_GREEN_MIN/MAX/BASE`, `T_YELLOW`, `COUNT_DIFF_TH` ở đầu file.

---

## 🌐 Giao Thức TCP (PC ↔ Mega, port 8080)

**PC → Mega** (JSON + newline):
```json
{"cmd":"COUNT","vertical":8,"horizontal":2}
{"cmd":"PING"}
{"cmd":"VIOLATION","plate":"51A12345","type":"car","ts":"20260713_235959"}
{"cmd":"STATS"}
```

**Mega → PC** (Mega đẩy LIGHT mỗi khi đổi pha):
```json
{"status":"LIGHT","vertical":"red","horizontal":"green","t_v":8,"t_h":12}
{"status":"PONG"}
{"status":"OK","violations":5}
```

---

## 🧠 Thuật Toán

### Phát Hiện Vi Phạm (State Machine)
```
Xe xuất hiện (dưới vạch) → theo dõi lịch sử vị trí
  → Đèn ĐỎ bật lên
  → Xe di chuyển lên (cy giảm)
  → Mép dưới xe (y2) vượt qua vạch dừng
  → Debounce: 4 frame liên tiếp
  → ✅ GHI NHẬN VI PHẠM
```

### Tracking Xe
- Dùng **ByteTrack** (tích hợp sẵn trong Ultralytics YOLOv8)
- Mỗi xe có **track_id ổn định** qua các frame (không mất ID khi overlap)

### OCR Biển Số (mặc định: YOLO)
1. **Crop biển số** từ model `license_plate_detection.pt`
2. **Đọc ký tự** bằng model `license_plate_ocr.pt` (YOLO detect từng ký tự 0-9, A-Z)
3. **Gom hàng**: nhóm ký tự theo tọa độ Y (xử lý biển 1 dòng & 2 dòng VN), sort trái→phải
4. **Voting**: giữ biển số confidence cao nhất cho mỗi `track_id` qua nhiều frame
5. *(Fallback)* `--ocr-engine easyocr`: EasyOCR + preprocessing (CLAHE, sharpen, denoise)

### Đếm Xe (gửi Mega chỉnh đèn)
- Mỗi xe có `track_id`; đếm **1 lần** khi tâm xe **cắt qua vạch đếm**
- Mỗi `--count-interval` giây gửi `COUNT` (số xe dọc + ngang) cho Mega
- Mega chênh lệch xe ≥ ngưỡng → ưu tiên tuyến đông xe (xanh dài hơn)

### Trạng Thái Đèn (lấy từ Mega – chính xác 100%)
- Mega điều khiển đèn nên biết chính xác đỏ/xanh, **đẩy `LIGHT` về laptop**
- Laptop dùng trạng thái đèn này để bắt vi phạm (không đoán qua camera)
- Test không có Mega: dùng `--force-red` để ép đèn đỏ

---

## 📊 Output

### File Excel vi phạm
- Lưu tại `violations.xlsx` (cùng thư mục, đổi bằng `--xlsx`)
- Cột: Thời gian, Tuyến, Loại xe, Biển số, Ảnh bằng chứng

### Ảnh Vi Phạm
- Toàn cảnh: `violations/cars_51A12345_20260713_235959.jpg`
- Cắt sát xe: `violations/crop_cars_51A12345_...jpg`

### CSV Log (dự phòng)
- Lưu tại `logs/violations_YYYYMMDD_HHMMSS.csv` (cùng cột với Excel)

### Serial Monitor Arduino (115200 baud)
```
[NET] TCP server tai 192.168.1.200:8080
[PHA] V=green H=red dur=10
[COUNT] doc=8 ngang=2
[VI PHAM] #1 bien=51A12345
```

---

## ❓ Xử Lý Lỗi Thường Gặp

| Lỗi | Nguyên nhân | Giải pháp |
|-----|------------|-----------|
| `No module named 'cv2'` | Chưa cài OpenCV | `pip install opencv-python` |
| `No module named 'openpyxl'` | Chưa cài openpyxl | `pip install openpyxl` (không có vẫn ghi CSV) |
| Camera không mở được | Index sai / camera bận | Thử `--camera-v 1`, đóng app khác |
| Mega không phản hồi | IP sai / cáp chưa cắm | Chạy `test_arduino.py` kiểm tra |
| Đèn luôn "unknown" | Chưa nối Mega | Nối Mega, hoặc `--force-red` để test |
| Không bắt được vi phạm | Sai hướng vạch | Thử `--direction down` hoặc `auto` |
| Chạy chậm (CPU yếu) | YOLOv8m nặng | Giảm `--imgsz 416 --frame-skip 4`, hoặc train yolov8n |
