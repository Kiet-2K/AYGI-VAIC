"""
web/server.py – Dashboard giám sát giao thông thời gian thực (TP. Đà Nẵng).

KHÔNG cần cài thư viện ngoài (dùng http.server chuẩn của Python) → chạy được
ngay cả trên Jetson Nano. Chạy 1 lệnh:

    python web/server.py                # mở http://<IP-máy>:8090
    python web/server.py --port 9000    # đổi port

Dữ liệu THẬT lấy từ:
  - logs/live_state.json : trạng thái đèn 2 trục + đếm ngược + số xe (main.py ghi)
  - logs/violations_*.csv : danh sách vi phạm (ViolationLogger ghi)
  - violations/*.jpg      : ảnh bằng chứng

Mở từ điện thoại/PC cùng WiFi: http://<IP-máy-chạy>:8090
"""

import argparse
import csv
import glob
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, unquote


# ThreadingHTTPServer chỉ có từ Python 3.7; tự dựng để chạy cả Python 3.6 (Jetson Nano)
class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# Console Windows mặc định cp1252 → ép UTF-8 để in tiếng Việt không lỗi
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Thư mục gốc dự án (cha của web/)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT, "web")
LOGS_DIR = os.path.join(ROOT, "logs")
VIOLATIONS_DIR = os.path.join(ROOT, "violations")
STATE_FILE = os.path.join(LOGS_DIR, "live_state.json")


def read_state():
    """Đọc trạng thái đèn/số xe từ live_state.json (main.py ghi mỗi vòng lặp)."""
    if not os.path.exists(STATE_FILE):
        return {"available": False}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        data["available"] = True
        return data
    except (json.JSONDecodeError, OSError):
        return {"available": False}


def read_violations(limit=100):
    """Đọc vi phạm từ file CSV mới nhất trong logs/. Trả về list dict (mới nhất trước)."""
    files = sorted(glob.glob(os.path.join(LOGS_DIR, "violations_*.csv")),
                   key=os.path.getmtime, reverse=True)
    rows = []
    if not files:
        return rows
    try:
        with open(files[0], "r", encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            for r in reader:
                if len(r) < 4:
                    continue
                img = r[4] if len(r) > 4 else ""
                clip = r[5] if len(r) > 5 else ""
                rows.append({
                    "time": r[0], "lane": r[1], "type": r[2],
                    "plate": r[3] or "Không đọc được",
                    "image": os.path.basename(img) if img else "",
                    "clip": os.path.basename(clip) if clip else "",
                })
    except OSError:
        return rows
    rows.reverse()
    return rows[:limit]


def read_stats():
    """Tổng hợp thống kê vi phạm cho biểu đồ dashboard (Feature #3).

    Đọc toàn bộ CSV mới nhất, trả về:
      - by_hour: đếm vi phạm theo giờ trong ngày (0-23)
      - by_type: đếm theo loại xe
      - by_lane: đếm theo tuyến
      - total: tổng vi phạm
    """
    files = sorted(glob.glob(os.path.join(LOGS_DIR, "violations_*.csv")),
                   key=os.path.getmtime, reverse=True)
    by_hour = [0] * 24
    by_type = {}
    by_lane = {}
    total = 0
    if not files:
        return {"by_hour": by_hour, "by_type": by_type, "by_lane": by_lane, "total": 0}
    try:
        with open(files[0], "r", encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            next(reader, None)  # bỏ header
            for r in reader:
                if len(r) < 4:
                    continue
                total += 1
                # timestamp dạng YYYYMMDD_HHMMSS → giờ ở ký tự 9-10
                ts = r[0]
                if len(ts) >= 11 and ts[8] == "_":
                    try:
                        hh = int(ts[9:11])
                        if 0 <= hh <= 23:
                            by_hour[hh] += 1
                    except ValueError:
                        pass
                vtype = (r[2] or "khác").strip()
                by_type[vtype] = by_type.get(vtype, 0) + 1
                lane = (r[1] or "?").strip()
                by_lane[lane] = by_lane.get(lane, 0) + 1
    except OSError:
        pass
    return {"by_hour": by_hour, "by_type": by_type, "by_lane": by_lane, "total": total}


def read_telegram_link():
    """Suy ra link Telegram để gắn vào QR (đọc telegram_config.json nếu có)."""
    cfg_path = os.path.join(ROOT, "telegram_config.json")
    default = {"link": "", "name": "Quét để nhận cảnh báo"}
    if not os.path.exists(cfg_path):
        return default
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (json.JSONDecodeError, OSError):
        return default
    username = str(cfg.get("bot_username", "")).strip().lstrip("@")
    if username:
        return {"link": f"https://t.me/{username}", "name": f"@{username}"}
    return default


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # tắt log request cho gọn console

    def _send(self, code, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path

        if path in ("/", "/index.html"):
            return self._serve_file(os.path.join(WEB_DIR, "dashboard.html"),
                                    "text/html; charset=utf-8")

        if path == "/app.js":
            return self._serve_file(os.path.join(WEB_DIR, "app.js"),
                                    "application/javascript; charset=utf-8")

        if path == "/api/state":
            return self._send(200, json.dumps(read_state(), ensure_ascii=False))

        if path == "/api/violations":
            return self._send(200, json.dumps(read_violations(), ensure_ascii=False))

        if path == "/api/stats":
            return self._send(200, json.dumps(read_stats(), ensure_ascii=False))

        if path == "/api/telegram":
            return self._send(200, json.dumps(read_telegram_link(), ensure_ascii=False))

        if path == "/qr.png":
            return self._serve_file(os.path.join(WEB_DIR, "qr.png"), "image/png")

        # Frame camera da ve box nhan dien (main.py ghi logs/live_frame.jpg)
        if path == "/frame.jpg":
            fp = os.path.join(LOGS_DIR, "live_frame.jpg")
            if not os.path.isfile(fp):
                return self._send(404, json.dumps({"error": "no frame"}))
            try:
                with open(fp, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
            except OSError:
                self._send(500, json.dumps({"error": "read error"}))
            return

        # Ảnh/clip bằng chứng: /violations/<tên file> (chống path traversal)
        if path.startswith("/violations/"):
            name = os.path.basename(unquote(path[len("/violations/"):]))
            ctype = "video/mp4" if name.lower().endswith(".mp4") else "image/jpeg"
            return self._serve_file(os.path.join(VIOLATIONS_DIR, name), ctype)

        return self._send(404, json.dumps({"error": "not found"}))

    def _serve_file(self, filepath, content_type):
        if not os.path.isfile(filepath):
            return self._send(404, json.dumps({"error": "file not found"}))
        try:
            with open(filepath, "rb") as f:
                self._send(200, f.read(), content_type)
        except OSError:
            self._send(500, json.dumps({"error": "read error"}))


def get_lan_ip():
    """Đoán IP LAN của máy để in hướng dẫn mở từ điện thoại."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    os.makedirs(LOGS_DIR, exist_ok=True)
    os.makedirs(VIOLATIONS_DIR, exist_ok=True)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    ip = get_lan_ip()
    print("=" * 56)
    print("  DASHBOARD GIÁM SÁT GIAO THÔNG – TP. ĐÀ NẴNG")
    print("=" * 56)
    print(f"  Máy này        : http://localhost:{args.port}")
    print(f"  Điện thoại/PC  : http://{ip}:{args.port}   (cùng WiFi)")
    print("=" * 56)
    print("  Ctrl+C để dừng.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nĐã dừng dashboard.")
        server.shutdown()


if __name__ == "__main__":
    main()
