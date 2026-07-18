"""
main.py – Ngã tư thông minh: laptop đếm xe + Mega điều khiển đèn + lưu vi phạm Excel

Kiến trúc:
  - Camera (cắm laptop) dùng YOLO ĐẾM XE theo 2 trục: dọc (Bắc-Nam) + ngang (Đông-Tây)
  - Laptop gửi số xe (COUNT) cho Mega qua Ethernet TCP
  - Mega ĐIỀU KHIỂN ĐÈN thích ứng theo số xe, gửi TRẠNG THÁI ĐÈN về laptop
  - Laptop lấy đèn TỪ MEGA để phát hiện vượt đèn đỏ → lưu vi phạm ra Excel + CSV + ảnh

Cách chạy:
  # 1 camera (test trước – tuyến ngang coi như 0 xe)
  python main.py --camera-v 0 --arduino 192.168.1.200

  # 2 camera đầy đủ (dọc = index 0, ngang = index 1)
  python main.py --camera-v 0 --camera-h 1 --arduino 192.168.1.200

  # Chạy thử KHÔNG Mega (không tính vi phạm trừ khi --force-red)
  python main.py --camera-v 0 --force-red

Cấu trúc thư mục cần có:
  models/
    vehicle/vehicle.pt
    license_plate/license_plate_detection.pt
    license_plate/license_plate_ocr.pt
  violations/  logs/  plates_cropped/   (tự tạo)
"""

import cv2
import numpy as np
import torch
from ultralytics import YOLO
import re
import os
import csv
import json
import time
import logging
import argparse
import threading
from datetime import datetime
from collections import defaultdict, deque

from camera_manager import CameraManager
from violation_detector import ViolationDetector
from vehicle_counter import VehicleCounter
from arduino_comm import ArduinoComm
from telegram_notifier import TelegramNotifier

# Bắt buộc stdout/stderr dùng UTF-8 trên Windows (tránh lỗi cp1252 với tiếng Việt)
import sys
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ======================================================================
# THƯ MỤC ĐẦU RA (tạo TRƯỚC khi cấu hình logging vì FileHandler ghi vào logs/)
# ======================================================================
os.makedirs("violations", exist_ok=True)
os.makedirs("logs", exist_ok=True)
os.makedirs("plates_cropped", exist_ok=True)

# ======================================================================
# LOGGING
# ======================================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("logs/system.log", encoding="utf-8"),
    ]
)
logger = logging.getLogger(__name__)

# ======================================================================
# THƯ MỤC ĐẦU RA
# ======================================================================
os.makedirs("violations", exist_ok=True)
os.makedirs("logs", exist_ok=True)
os.makedirs("plates_cropped", exist_ok=True)

# ======================================================================
# ARGUMENT PARSER
# ======================================================================
def parse_args():
    ap = argparse.ArgumentParser(description="Ngã tư thông minh – đếm xe + phát hiện vượt đèn đỏ")
    # --- Camera 2 trục ---
    ap.add_argument("--camera-v", default="0",
                    help="Camera trục DỌC (Bắc-Nam): index webcam hoặc RTSP URL. Mặc định: 0")
    ap.add_argument("--camera-h", default=None,
                    help="Camera trục NGANG (Đông-Tây). Bỏ trống = chạy 1 camera (test)")
    ap.add_argument("--width", type=int, default=1280, help="Chiều rộng frame")
    ap.add_argument("--height", type=int, default=720, help="Chiều cao frame")
    # --- Vạch dừng (vi phạm) + vạch đếm cho từng trục ---
    ap.add_argument("--stop-line-v", type=int, default=None,
                    help="Y vạch dừng trục dọc (px). Mặc định 65%% chiều cao")
    ap.add_argument("--stop-line-h", type=int, default=None,
                    help="Y vạch dừng trục ngang (px). Mặc định 65%% chiều cao")
    ap.add_argument("--count-line-v", type=int, default=None,
                    help="Y vạch đếm xe trục dọc (px). Mặc định = vạch dừng")
    ap.add_argument("--count-line-h", type=int, default=None,
                    help="Y vạch đếm xe trục ngang (px). Mặc định = vạch dừng")
    ap.add_argument("--count-interval", type=float, default=10.0,
                    help="Chu kỳ (giây) gửi số xe cho Mega. Mặc định: 10")
    # --- Arduino ---
    ap.add_argument("--arduino", default=None,
                    help="IP Arduino Mega (vd: 192.168.1.200). Bỏ qua nếu không dùng")
    ap.add_argument("--arduino-port", type=int, default=8080)
    ap.add_argument("--force-red", action="store_true",
                    help="Ép đèn = đỏ cả 2 trục (test vi phạm khi KHÔNG có Mega)")
    # --- Hiển thị / hiệu năng ---
    ap.add_argument("--no-display", action="store_true",
                    help="Không hiển thị cửa sổ video (chạy server mode)")
    ap.add_argument("--frame-skip", type=int, default=3,
                    help="Xử lý 1 trong N frame (giảm tải CPU). Mặc định: 3")
    # --- Model ---
    ap.add_argument("--vehicle-model", default="yolov8n.pt",
                    help="Model YOLO nhận diện xe. Mặc định yolov8n.pt (nhẹ, nhanh). "
                         "Dùng models/vehicle/vehicle.pt nếu muốn model đã train")
    ap.add_argument("--vehicle-classes", default="auto",
                    help="Lọc class xe: 'auto' (tự nhận COCO→car/moto/bus/truck), "
                         "'all', hoặc danh sách id vd '2,3,5,7'")
    ap.add_argument("--plate-model",   default="models/license_plate/license_plate_detection.pt")
    ap.add_argument("--ocr-model",     default="models/license_plate/license_plate_ocr.pt",
                    help="Model YOLO đọc ký tự biển số (0-9, A-Z)")
    ap.add_argument("--ocr-engine", choices=["yolo", "easyocr"], default="yolo",
                    help="yolo = dùng license_plate_ocr.pt (nhẹ, khuyến nghị); easyocr = fallback")
    ap.add_argument("--conf", type=float, default=0.45, help="Ngưỡng confidence tối thiểu")
    ap.add_argument("--imgsz", type=int, default=480,
                    help="Kích thước ảnh khi inference (giảm để nhanh hơn trên CPU)")
    ap.add_argument("--direction", choices=["up", "down", "auto"], default="up",
                    help="Hướng xe vi phạm khi vượt vạch. up=đi lên (mặc định), down, auto")
    # --- Xuất ---
    ap.add_argument("--xlsx", default="violations.xlsx",
                    help="File Excel lưu vi phạm. Mặc định: violations.xlsx")
    ap.add_argument("--device", default="cpu", help="cpu hoặc cuda:0")
    return ap.parse_args()

# ======================================================================
# LOAD MODEL
# ======================================================================
def load_models(args):
    logger.info("Đang tải model AI...")
    models = {}

    def _load(path, name, required=False):
        if os.path.exists(path):
            m = YOLO(path)
            logger.info("✓ %s: %s  (classes: %s)", name, path, m.names)
            return m
        if required:
            logger.error("✗ %s KHÔNG tìm thấy (bắt buộc): %s", name, path)
        else:
            logger.warning("✗ %s không tìm thấy: %s", name, path)
        return None

    models["vehicle"] = _load(args.vehicle_model, "Vehicle model", required=True)
    if models["vehicle"] is None:
        raise FileNotFoundError(f"Không tìm thấy vehicle model: {args.vehicle_model}")

    models["plate"] = _load(args.plate_model, "Plate detection model")
    models["ocr"]   = _load(args.ocr_model,   "Plate OCR model") if args.ocr_engine == "yolo" else None
    # Đèn giao thông giờ do Mega điều khiển & báo về → KHÔNG cần model traffic_light nữa.

    return models

# ======================================================================
# OCR BIỂN SỐ BẰNG YOLO – dùng model license_plate_ocr.pt đã train
# ======================================================================
class PlateOCRYolo:
    """
    Đọc biển số bằng model YOLO nhận diện ký tự (classes: 0-9, A-Z).
    Gom ký tự thành hàng (biển 1 dòng hoặc 2 dòng VN), sort trái→phải, ghép chuỗi.
    Nhẹ và chính xác hơn EasyOCR cho biển số đã train.
    """

    def __init__(self, model, device="cpu", conf=0.35):
        self.model  = model
        self.device = device
        self.conf   = conf

    def recognize(self, plate_img):
        if plate_img is None or plate_img.size == 0 or self.model is None:
            return "Unknown", 0.0

        # Scale nhỏ lên để ký tự rõ hơn
        h, w = plate_img.shape[:2]
        if w < 160:
            scale = max(2, 200 // max(w, 1))
            plate_img = cv2.resize(plate_img, (w * scale, h * scale),
                                   interpolation=cv2.INTER_CUBIC)

        results = self.model(plate_img, conf=self.conf, device=self.device, verbose=False)

        chars = []  # (cx, cy, char, conf, height)
        for r in results:
            for b in r.boxes:
                c = float(b.conf)
                if c < self.conf:
                    continue
                x1, y1, x2, y2 = b.xyxy[0].tolist()
                cx = (x1 + x2) / 2
                cy = (y1 + y2) / 2
                ch = r.names[int(b.cls)]
                chars.append((cx, cy, ch, c, y2 - y1))

        if not chars:
            return "Unknown", 0.0

        # Gom hàng: nếu chênh lệch y > nửa chiều cao ký tự trung bình → hàng khác
        avg_h = sum(c[4] for c in chars) / len(chars)
        chars.sort(key=lambda c: c[1])  # sort theo y trước
        rows, cur = [], [chars[0]]
        for c in chars[1:]:
            if abs(c[1] - cur[-1][1]) > avg_h * 0.6:
                rows.append(cur); cur = [c]
            else:
                cur.append(c)
        rows.append(cur)

        text = ""
        for row in rows:
            row.sort(key=lambda c: c[0])  # trong hàng: trái → phải
            text += "".join(c[2] for c in row)

        avg_conf = sum(c[3] for c in chars) / len(chars)
        return text, avg_conf


# ======================================================================
# OCR BIỂN SỐ – EasyOCR (FALLBACK tùy chọn)
# ======================================================================
class LicensePlateOCR:
    """OCR biển số xe Việt Nam dùng EasyOCR + preprocessing (fallback)."""

    # Pattern biển số VN
    VN_PATTERNS = [
        r'^\d{2}[A-Z]\d{4,5}$',
        r'^\d{2}[A-Z]{1,2}\d{4,5}$',
        r'^\d{2}[A-Z]\d{4,5}[A-Z]$',
    ]

    def __init__(self, gpu=False):
        logger.info("Đang khởi tạo EasyOCR...")
        import easyocr  # lazy import – chỉ nạp khi thực sự dùng fallback
        self.reader = easyocr.Reader(['en'], gpu=gpu, verbose=False)
        logger.info("✓ EasyOCR sẵn sàng")

    def preprocess(self, img):
        """Tiền xử lý ảnh để tăng chất lượng OCR."""
        if img is None or img.size == 0:
            return None

        # Scale ảnh lên 4x để OCR chính xác hơn
        h, w = img.shape[:2]
        if w < 80:
            scale = max(4, 240 // w)
        else:
            scale = 3
        img = cv2.resize(img, (w * scale, h * scale), interpolation=cv2.INTER_CUBIC)

        # Chuyển grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # CLAHE tăng độ tương phản cục bộ
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        gray = clahe.apply(gray)

        # Sharpen
        kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
        gray = cv2.filter2D(gray, -1, kernel)

        # Denoise
        gray = cv2.fastNlMeansDenoising(gray, h=10)

        return gray

    def clean_text(self, text):
        """Làm sạch text OCR – chỉ giữ chữ và số."""
        return re.sub(r'[^A-Z0-9]', '', text.upper())

    def is_valid_vn_plate(self, text):
        """Kiểm tra có khớp định dạng biển số VN không."""
        for p in self.VN_PATTERNS:
            if re.match(p, text):
                return True
        # Fallback: ít nhất 5 ký tự, có cả số và chữ
        if 5 <= len(text) <= 10 and any(c.isdigit() for c in text) and any(c.isalpha() for c in text):
            return True
        return False

    def recognize(self, plate_img):
        """
        Nhận dạng biển số. Trả về (text, confidence).
        """
        if plate_img is None or plate_img.size == 0:
            return "Unknown", 0.0

        preprocessed = self.preprocess(plate_img)
        if preprocessed is None:
            return "Unknown", 0.0

        candidates = []

        try:
            # EasyOCR – chạy trên ảnh đã xử lý
            results = self.reader.readtext(preprocessed, detail=1,
                                           allowlist='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
            for (_, text, conf) in results:
                cleaned = self.clean_text(text)
                if len(cleaned) >= 4:
                    candidates.append((cleaned, conf))

            # Thử thêm với ảnh binary
            _, thresh = cv2.threshold(preprocessed, 0, 255,
                                      cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            results2 = self.reader.readtext(thresh, detail=1,
                                            allowlist='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
            for (_, text, conf) in results2:
                cleaned = self.clean_text(text)
                if len(cleaned) >= 4:
                    candidates.append((cleaned, conf * 0.9))

        except Exception as e:
            logger.debug("OCR lỗi: %s", e)

        if not candidates:
            return "Unknown", 0.0

        # Chọn kết quả tốt nhất: ưu tiên valid VN plate, rồi theo confidence
        valid = [(t, c) for t, c in candidates if self.is_valid_vn_plate(t)]
        if valid:
            best = max(valid, key=lambda x: x[1])
        else:
            best = max(candidates, key=lambda x: x[1])

        return best[0], best[1]


# ======================================================================
# CACHE BIỂN SỐ – Lưu biển số tốt nhất cho mỗi track_id
# ======================================================================
class PlateCache:
    def __init__(self):
        self._cache: dict[int, tuple[str, float]] = {}  # {track_id: (plate, conf)}

    def update(self, track_id, plate, conf):
        if plate in ("Unknown", ""):
            return
        current = self._cache.get(track_id, ("Unknown", 0.0))
        if conf > current[1]:
            self._cache[track_id] = (plate, conf)

    def get(self, track_id):
        return self._cache.get(track_id, ("Unknown", 0.0))[0]

    def cleanup(self, active_ids):
        dead = [k for k in self._cache if k not in active_ids]
        for k in dead:
            del self._cache[k]

# ======================================================================
# VẼ UI TRÊN FRAME
# ======================================================================
def draw_ui(frame, stop_line_y, count_line_y, light_status, light_time,
            lane_name, count_cycle, violations_count, fps, connected_arduino):
    h, w = frame.shape[:2]

    # Vạch dừng (vi phạm) – đỏ khi đèn đỏ
    line_color = (0, 0, 255) if light_status == "red" else (0, 255, 0)
    cv2.line(frame, (0, stop_line_y), (w, stop_line_y), line_color, 3)
    cv2.putText(frame, "STOP LINE", (10, stop_line_y - 8),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, line_color, 2)

    # Vạch đếm xe – vàng
    if count_line_y != stop_line_y:
        cv2.line(frame, (0, count_line_y), (w, count_line_y), (0, 200, 200), 2)
        cv2.putText(frame, "COUNT LINE", (10, count_line_y - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 200), 1)

    # Góc trên trái – thông tin hệ thống
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (360, 140), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.5, frame, 0.5, 0, frame)

    cv2.putText(frame, f"TUYEN: {lane_name}", (10, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    lc = {"red": (0, 0, 255), "green": (0, 255, 0), "yellow": (0, 255, 255)}.get(light_status, (200, 200, 200))
    light_txt = f"DEN: {light_status.upper()}"
    if light_time > 0:
        light_txt += f" ({light_time}s)"
    cv2.putText(frame, light_txt, (10, 56),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, lc, 2)
    cv2.putText(frame, f"XE (chu ky): {count_cycle}", (10, 84),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
    cv2.putText(frame, f"VI PHAM: {violations_count}", (10, 110),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 255), 2)
    cv2.putText(frame, f"FPS: {fps:.1f}", (10, 134),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (180, 180, 180), 1)

    # Trạng thái Arduino
    arduino_color = (0, 255, 0) if connected_arduino else (0, 0, 255)
    arduino_text = "MEGA: OK" if connected_arduino else "MEGA: OFFLINE"
    cv2.putText(frame, arduino_text, (w - 200, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, arduino_color, 2)

    return frame

def draw_vehicle(frame, box, track_id, label, violated, plate_text=""):
    x1, y1, x2, y2 = map(int, box)
    color = (0, 0, 255) if violated else (0, 220, 0)
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

    tag = f"{label}#{track_id}"
    if plate_text and plate_text != "Unknown":
        tag += f" [{plate_text}]"
    if violated:
        tag += " !VI PHAM!"

    cv2.putText(frame, tag, (x1, max(y1 - 8, 15)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)

# ======================================================================
# LƯU ẢNH VI PHẠM
# ======================================================================
def save_violation_image(frame, box, plate_text, vehicle_type, timestamp, stop_line_y=None):
    """
    Lưu 2 ảnh bằng chứng:
      - violations/<type>_<plate>_<ts>.jpg      : TOÀN CẢNH có khung xe + vạch + thông tin
      - violations/crop_<type>_<plate>_<ts>.jpg : ảnh cắt sát chiếc xe
    Trả về đường dẫn ảnh toàn cảnh (dùng cho CSV).
    """
    x1, y1, x2, y2 = map(int, box)
    h, w = frame.shape[:2]
    safe_plate = re.sub(r'[^A-Z0-9_]', '', plate_text.upper()) or "UNKNOWN"

    # --- Ảnh toàn cảnh (bằng chứng chính) ---
    scene = frame.copy()
    cv2.rectangle(scene, (x1, y1), (x2, y2), (0, 0, 255), 3)
    if stop_line_y is not None:
        cv2.line(scene, (0, stop_line_y), (w, stop_line_y), (0, 0, 255), 2)
    banner = f"VI PHAM | {vehicle_type} | {plate_text} | {timestamp}"
    cv2.rectangle(scene, (0, h - 34), (w, h), (0, 0, 0), -1)
    cv2.putText(scene, banner, (10, h - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
    scene_path = f"violations/{vehicle_type}_{safe_plate}_{timestamp}.jpg"
    cv2.imwrite(scene_path, scene)

    # --- Ảnh cắt sát xe ---
    pad = 20
    crop = frame[max(0, y1 - pad):min(h, y2 + pad), max(0, x1 - pad):min(w, x2 + pad)]
    if crop.size > 0:
        cv2.imwrite(f"violations/crop_{vehicle_type}_{safe_plate}_{timestamp}.jpg", crop)

    logger.info("Lưu ảnh vi phạm: %s", scene_path)
    return scene_path

# ======================================================================
# GHI VI PHẠM RA EXCEL (.xlsx) + CSV
# ======================================================================
class ViolationLogger:
    """
    Lưu vi phạm ra Excel (openpyxl) và CSV song song.
    Excel append từng dòng và save ngay để không mất dữ liệu nếu tắt đột ngột.
    """
    COLUMNS = ["Thời gian", "Tuyến", "Loại xe", "Biển số", "Ảnh bằng chứng", "Clip"]

    def __init__(self, xlsx_path, csv_path):
        self.xlsx_path = xlsx_path
        self._openpyxl = None
        self._wb = None
        self._ws = None
        try:
            import openpyxl
            self._openpyxl = openpyxl
            if os.path.exists(xlsx_path):
                self._wb = openpyxl.load_workbook(xlsx_path)
                self._ws = self._wb.active
            else:
                self._wb = openpyxl.Workbook()
                self._ws = self._wb.active
                self._ws.title = "ViPham"
                self._ws.append(self.COLUMNS)
                self._wb.save(xlsx_path)
            logger.info("Excel vi phạm: %s", xlsx_path)
        except ImportError:
            logger.warning("Chưa cài openpyxl → chỉ ghi CSV. Cài: pip install openpyxl")

        # CSV song song
        self._csv_file = open(csv_path, "w", newline="", encoding="utf-8-sig")
        self._csv = csv.writer(self._csv_file)
        self._csv.writerow(self.COLUMNS)

    def log(self, timestamp, lane, vehicle_type, plate, image_path, clip_path=""):
        row = [timestamp, lane, vehicle_type, plate, image_path, clip_path]
        self._csv.writerow(row)
        self._csv_file.flush()
        if self._ws is not None:
            try:
                self._ws.append(row)
                self._wb.save(self.xlsx_path)
            except Exception as e:
                logger.error("Ghi Excel lỗi: %s", e)

    def close(self):
        try:
            self._csv_file.close()
        except Exception:
            pass


# ======================================================================
# GHI TRẠNG THÁI LIVE CHO WEB DASHBOARD (logs/live_state.json)
# ======================================================================
_LIVE_STATE_PATH = os.path.join("logs", "live_state.json")

def write_live_state(lanes, arduino, fps):
    """Ghi trạng thái đèn + số xe hiện tại ra JSON để web/server.py đọc.
    Ghi atomic (file tạm rồi replace) để web không đọc phải file dở."""
    lane_v = lanes[0]
    lane_h = lanes[1] if len(lanes) > 1 else None
    state = {
        "vertical":   lane_v.light,
        "horizontal": lane_h.light if lane_h else "red",
        "t_v":        int(arduino.get_light_time("vertical")) if arduino.is_connected() else lane_v.light_time,
        "t_h":        int(arduino.get_light_time("horizontal")) if arduino.is_connected() else (lane_h.light_time if lane_h else 0),
        "count_v":    lane_v.counter.count(),
        "count_h":    lane_h.counter.count() if lane_h else 0,
        "violations": sum(l.violations for l in lanes),
        "fps":        round(float(fps), 1),
        "arduino_connected": arduino.is_connected(),
        # Đèn thích ứng (Feature #5): thời gian xanh Mega tính theo số xe
        "green_v":    int(arduino.get_green_time("vertical")) if arduino.is_connected() else 0,
        "green_h":    int(arduino.get_green_time("horizontal")) if arduino.is_connected() else 0,
    }
    try:
        tmp = _LIVE_STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, _LIVE_STATE_PATH)
    except OSError:
        pass  # không để lỗi ghi file làm chết vòng lặp video


# Ghi frame đã vẽ box nhận diện ra JPEG để web dashboard hiển thị như video
_LIVE_FRAME_PATH = os.path.join("logs", "live_frame.jpg")

def write_live_frame(frame):
    try:
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
        if not ok:
            return
        tmp = _LIVE_FRAME_PATH + ".tmp"
        with open(tmp, "wb") as f:
            f.write(buf.tobytes())
        os.replace(tmp, _LIVE_FRAME_PATH)
    except Exception:
        pass  # không để lỗi ghi ảnh làm chết vòng lặp


# ======================================================================
# GHI CLIP VIDEO VI PHẠM (Feature #1)
# ======================================================================
class ClipRecorder:
    """Ghi clip video ngắn quanh thời điểm vi phạm (pre-roll + post-roll).

    Mỗi vòng lặp feed() 1 frame đã vẽ box vào buffer vòng (pre-roll). Khi
    trigger() thì gom pre-roll rồi tiếp tục thu thêm post-roll frame, sau đó
    ghi ra .mp4 (H.264/avc1 để phát được trong trình duyệt) ở thread nền để
    không chặn vòng lặp chính.
    """

    def __init__(self, fps=15, pre_sec=2, post_sec=3, out_dir="violations"):
        self.fps = max(1, int(fps))
        self.pre = deque(maxlen=max(1, int(self.fps * pre_sec)))
        self.post_frames = max(1, int(self.fps * post_sec))
        self.out_dir = out_dir
        self._active = None

    def feed(self, frame):
        if frame is None:
            return
        if self._active is None:
            self.pre.append(frame)
        else:
            self._active["frames"].append(frame)
            self._active["left"] -= 1
            if self._active["left"] <= 0:
                self._flush()

    def trigger(self, clip_path):
        if self._active is not None:
            return  # đang ghi clip khác → bỏ qua để không chồng
        self._active = {"frames": list(self.pre),
                        "left": self.post_frames, "path": clip_path}

    def _flush(self):
        act = self._active
        self._active = None
        if act and act["frames"]:
            threading.Thread(target=self._write,
                             args=(act["path"], act["frames"]),
                             daemon=True).start()

    def _write(self, path, frames):
        try:
            h, w = frames[0].shape[:2]
            vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"avc1"),
                                 self.fps, (w, h))
            if not vw.isOpened():  # máy không có H.264 → fallback mp4v
                vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"),
                                     self.fps, (w, h))
            for fr in frames:
                if fr.shape[:2] != (h, w):
                    fr = cv2.resize(fr, (w, h))
                vw.write(fr)
            vw.release()
            logger.info("Lưu clip vi phạm: %s (%d frame)", path, len(frames))
        except Exception as e:
            logger.error("Ghi clip lỗi: %s", e)

# ======================================================================
# MAIN
# ======================================================================
def _to_source(s):
    """Chuyển '0' -> 0 (webcam index), giữ nguyên nếu là RTSP URL."""
    try:
        return int(s)
    except (ValueError, TypeError):
        return s


def resolve_vehicle_classes(model, spec):
    """
    Xác định danh sách class-id xe cần giữ, trả None = giữ tất cả.
    spec: 'auto' | 'all' | '2,3,5,7'
    'auto': nếu model có class COCO (car/motorcycle/bus/truck) thì lọc đúng chúng;
            model tự train (cars/motorbike) thì giữ tất cả.
    """
    names = model.names  # {id: name}
    if spec == "all":
        return None
    if spec != "auto":
        try:
            return [int(x) for x in spec.split(",") if x.strip() != ""]
        except ValueError:
            logger.warning("--vehicle-classes không hợp lệ (%s) → giữ tất cả", spec)
            return None
    # auto
    wanted = {"car", "motorcycle", "bus", "truck"}
    ids = [i for i, n in names.items() if str(n).lower() in wanted]
    if ids:
        logger.info("Lọc class xe (COCO): %s", {i: names[i] for i in ids})
        return ids
    logger.info("Model xe tự train (%s) → giữ tất cả class", names)
    return None


class Lane:
    """
    Một tuyến giao thông = 1 camera + detector vi phạm + counter đếm xe.
    axis: 'vertical' (dọc) hoặc 'horizontal' (ngang) – dùng để hỏi đèn từ Mega.
    """
    def __init__(self, name, axis, source, args):
        self.name = name
        self.axis = axis
        self.args = args
        self.cam = CameraManager(source=_to_source(source),
                                 width=args.width, height=args.height)
        self.fh = self.fw = 0
        self.stop_line_y = 0
        self.count_line_y = 0
        self.detector = None
        self.counter  = None
        self.violations = 0
        self.light = "unknown"
        self.light_time = 0
        self.clip = None  # ClipRecorder (Feature #1) – tạo trong start_and_probe

    def start_and_probe(self):
        self.cam.start()
        deadline = time.time() + 15
        while self.cam.read() is None and time.time() < deadline:
            time.sleep(0.2)
        f = self.cam.read()
        if f is None:
            return False
        self.fh, self.fw = f.shape[:2]
        a = self.args
        if self.axis == "vertical":
            self.stop_line_y  = a.stop_line_v  or int(self.fh * 0.65)
            self.count_line_y = a.count_line_v or self.stop_line_y
        else:
            self.stop_line_y  = a.stop_line_h  or int(self.fh * 0.65)
            self.count_line_y = a.count_line_h or self.stop_line_y
        self.detector = ViolationDetector(stop_line_y=self.stop_line_y,
                                          confirm_frames=4, direction=a.direction)
        self.counter = VehicleCounter(count_line_y=self.count_line_y)
        self.clip = ClipRecorder(fps=15, pre_sec=2, post_sec=3)
        logger.info("Tuyến %s: %dx%d | stop_line=%d | count_line=%d",
                    self.name, self.fw, self.fh, self.stop_line_y, self.count_line_y)
        return True

    def stop(self):
        self.cam.stop()


def process_lane(lane, frame, models, ocr, plate_cache, args, arduino, vlog, telegram=None):
    """
    Xử lý 1 frame của 1 tuyến: track xe → đếm → OCR biển → kiểm vi phạm → vẽ.
    Trả về frame đã annotate. Cập nhật lane.light, lane.violations, lane.counter.
    """
    fh = lane.fh

    # Lấy đèn của trục này TỪ MEGA (hoặc ép đỏ khi test)
    if args.force_red:
        lane.light = "red"
    elif arduino.is_connected():
        lane.light = arduino.get_light(lane.axis)
        lane.light_time = arduino.get_light_time(lane.axis)
    else:
        lane.light = "unknown"

    # --- Track phương tiện ---
    track_kw = dict(persist=True, conf=args.conf, imgsz=args.imgsz,
                    tracker="bytetrack.yaml", device=args.device, verbose=False)
    if vehicle_classes_holder[0] is not None:
        track_kw["classes"] = vehicle_classes_holder[0]
    results = models["vehicle"].track(frame, **track_kw)

    active_ids = set()
    vehicles = []
    for result in results:
        for box in result.boxes:
            if box.id is None:
                continue
            if float(box.conf) < args.conf:
                continue
            tid = int(box.id)
            label = result.names[int(box.cls)]
            active_ids.add(tid)
            vehicles.append((tid, label, list(map(int, box.xyxy[0].tolist()))))

    plate_cache.cleanup(active_ids)
    lane.detector.cleanup()
    lane.counter.cleanup(active_ids)

    # --- Đếm xe qua vạch đếm ---
    for tid, label, coords in vehicles:
        lane.counter.update(tid, coords)

    # --- OCR biển số (chỉ xe gần vạch dừng) ---
    if models["plate"] is not None:
        for tid, label, coords in vehicles:
            x1, y1, x2, y2 = coords
            if abs(y2 - lane.stop_line_y) > 200:
                continue
            crop = frame[y1:y2, x1:x2]
            if crop.size == 0:
                continue
            plate_results = models["plate"](crop, conf=0.4, imgsz=args.imgsz,
                                            device=args.device, verbose=False)
            for pr in plate_results:
                for pb in pr.boxes:
                    if float(pb.conf) < 0.4:
                        continue
                    px1, py1, px2, py2 = map(int, pb.xyxy[0].tolist())
                    plate_crop = crop[py1:py2, px1:px2]
                    if plate_crop.size == 0:
                        continue
                    ptext, pconf = ocr.recognize(plate_crop)
                    plate_cache.update(tid, ptext, pconf)
                    cv2.rectangle(frame, (x1+px1, y1+py1), (x1+px2, y1+py2), (255, 200, 0), 2)
                    cv2.putText(frame, ptext, (x1+px1, y1+py1-6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 200, 0), 2)

    # --- Kiểm tra vi phạm + vẽ xe ---
    for tid, label, coords in vehicles:
        plate_text = plate_cache.get(tid)
        violated = lane.detector.has_violated(tid)
        viol_info = lane.detector.update(tid, coords, label, lane.light)
        if viol_info is not None:
            lane.violations += 1
            ts = viol_info["timestamp"]
            best_plate = plate_cache.get(tid)
            logger.warning("🚨 VI PHẠM [%s] #%d | %s | Biển: %s | %s",
                           lane.name, lane.violations, label, best_plate, ts)
            img_path = save_violation_image(frame, coords, best_plate, label, ts,
                                            stop_line_y=lane.stop_line_y)
            # Clip video vi phạm (pre-roll đã có sẵn trong buffer + post-roll)
            clip_path = ""
            if lane.clip is not None:
                safe_plate = re.sub(r'[^A-Z0-9_]', '', best_plate.upper()) or "UNKNOWN"
                clip_path = f"violations/clip_{label}_{safe_plate}_{ts}.mp4"
                lane.clip.trigger(clip_path)
            vlog.log(ts, lane.name, label, best_plate, img_path, clip_path)
            if arduino.is_connected():
                arduino.send_violation(best_plate, label, ts)
            if telegram is not None:
                telegram.send_violation(best_plate, label, lane.name, ts, img_path)
            violated = True
        draw_vehicle(frame, coords, tid, label, violated, plate_text)

    draw_ui(frame, lane.stop_line_y, lane.count_line_y, lane.light, lane.light_time,
            lane.name, lane.counter.count(), lane.violations, current_fps_holder[0],
            arduino.is_connected())
    return frame


# Biến dùng chung giữa vòng lặp và process_lane (đơn giản, 1 luồng)
current_fps_holder = [0.0]
vehicle_classes_holder = [None]   # danh sách class-id xe cần lọc (None = tất cả)


def main():
    args = parse_args()

    if args.device == "cpu":
        torch.set_num_threads(max(1, (os.cpu_count() or 2)))

    models = load_models(args)
    vehicle_classes_holder[0] = resolve_vehicle_classes(models["vehicle"], args.vehicle_classes)

    if args.ocr_engine == "yolo" and models.get("ocr") is not None:
        ocr = PlateOCRYolo(models["ocr"], device=args.device)
        logger.info("OCR engine: YOLO (license_plate_ocr.pt)")
    else:
        ocr = LicensePlateOCR(gpu=(args.device != "cpu"))
        logger.info("OCR engine: EasyOCR (fallback)")

    plate_cache = PlateCache()

    # Arduino Mega (bộ điều khiển đèn)
    arduino = ArduinoComm(host=args.arduino or "192.168.1.200",
                          port=args.arduino_port,
                          enabled=(args.arduino is not None))
    arduino.start()

    # Cảnh báo Telegram khi có vi phạm (task #4). Tự tắt nếu chưa cấu hình.
    telegram = TelegramNotifier()

    # --- Tạo các tuyến (camera dọc bắt buộc, camera ngang tùy chọn) ---
    lanes = []
    lane_v = Lane("DOC", "vertical", args.camera_v, args)
    if not lane_v.start_and_probe():
        logger.error("Không nhận được frame từ camera DỌC (--camera-v). Kiểm tra camera.")
        lane_v.stop(); arduino.stop()
        return
    lanes.append(lane_v)

    if args.camera_h is not None:
        lane_h = Lane("NGANG", "horizontal", args.camera_h, args)
        if lane_h.start_and_probe():
            lanes.append(lane_h)
        else:
            logger.warning("Không mở được camera NGANG (--camera-h). Chạy 1 tuyến.")
    else:
        logger.info("Chỉ 1 camera (DỌC). Tuyến ngang coi như 0 xe. Cắm --camera-h để đủ 2 tuyến.")

    # Logger vi phạm (Excel + CSV)
    csv_path = f"logs/violations_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    vlog = ViolationLogger(args.xlsx, csv_path)

    # Biến chu kỳ đếm
    frame_count = 0
    fps_counter = 0
    fps_start   = time.time()
    current_fps = 0.0
    last_count_sent = time.time()
    lane_idx = 0  # xen kẽ xử lý các tuyến để giảm tải CPU

    logger.info("Hệ thống bắt đầu. Nhấn 'q' thoát, 's' chụp màn hình.")
    logger.info("Kết nối Mega: %s | Số tuyến: %d", "CÓ" if args.arduino else "KHÔNG", len(lanes))

    try:
        while True:
            frame_count += 1
            fps_counter += 1
            elapsed = time.time() - fps_start
            if elapsed >= 1.0:
                current_fps = fps_counter / elapsed
                current_fps_holder[0] = current_fps
                fps_counter = 0
                fps_start = time.time()

            # Gửi số xe đếm được cho Mega mỗi count_interval giây
            if arduino.is_connected() and time.time() - last_count_sent >= args.count_interval:
                cnt_v = lanes[0].counter.count()
                cnt_h = lanes[1].counter.count() if len(lanes) > 1 else 0
                arduino.send_count(cnt_v, cnt_h)
                for ln in lanes:
                    ln.counter.reset()
                last_count_sent = time.time()

            # Xen kẽ: mỗi vòng chỉ xử lý NẶNG 1 tuyến (giảm tải CPU), nhưng vẫn hiển thị tất cả
            do_heavy = (frame_count % args.frame_skip == 0)

            for i, lane in enumerate(lanes):
                frame = lane.cam.read()
                if frame is None:
                    continue
                if do_heavy and (i == lane_idx or len(lanes) == 1):
                    frame = process_lane(lane, frame, models, ocr, plate_cache,
                                         args, arduino, vlog, telegram)
                else:
                    # frame nhẹ: chỉ vẽ UI với trạng thái gần nhất
                    if args.force_red:
                        lane.light = "red"
                    elif arduino.is_connected():
                        lane.light = arduino.get_light(lane.axis)
                        lane.light_time = arduino.get_light_time(lane.axis)
                    draw_ui(frame, lane.stop_line_y, lane.count_line_y, lane.light,
                            lane.light_time, lane.name, lane.counter.count(),
                            lane.violations, current_fps, arduino.is_connected())
                if lane.clip is not None:
                    lane.clip.feed(frame.copy())
                if i == 0:
                    write_live_frame(frame)
                if not args.no_display:
                    cv2.imshow(f"Tuyen {lane.name}", frame)

            if do_heavy and len(lanes) > 1:
                lane_idx = (lane_idx + 1) % len(lanes)

            # Ghi trạng thái live cho web dashboard (mỗi ~0.5s là đủ)
            if frame_count % 5 == 0:
                write_live_state(lanes, arduino, current_fps)

            if not args.no_display:
                key = cv2.waitKey(1) & 0xFF
                if key == ord('q'):
                    break
                elif key == ord('s'):
                    ts_s = datetime.now().strftime("%Y%m%d_%H%M%S")
                    for lane in lanes:
                        f = lane.cam.read()
                        if f is not None:
                            cv2.imwrite(f"logs/screenshot_{lane.name}_{ts_s}.jpg", f)
                    logger.info("Đã chụp màn hình các tuyến.")
            else:
                time.sleep(0.01)

    except KeyboardInterrupt:
        logger.info("Người dùng dừng chương trình.")
    finally:
        logger.info("Đang dọn dẹp tài nguyên...")
        total = sum(l.violations for l in lanes)
        for lane in lanes:
            lane.stop()
        arduino.stop()
        vlog.close()
        cv2.destroyAllWindows()
        logger.info("Tổng vi phạm ghi nhận: %d", total)
        logger.info("Excel: %s | CSV: %s", args.xlsx, csv_path)


if __name__ == "__main__":
    main()
