"""
telegram_notifier.py – Gửi cảnh báo vi phạm về Telegram (ảnh biển số + thông tin).

Đọc cấu hình từ telegram_config.json (cùng thư mục). Nếu chưa cấu hình hoặc
thiếu thư viện thì tự tắt (không làm crash main.py).

Cách lấy token & chat_id: xem hướng dẫn ở cuối file hoặc README.
Gửi ở luồng nền để không làm chậm vòng lặp xử lý video.
"""

import json
import logging
import os
import sys
import threading

# Console Windows mặc định cp1252 → ép UTF-8 để in tiếng Việt không lỗi
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

logger = logging.getLogger(__name__)

_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "telegram_config.json")
_API = "https://api.telegram.org"


class TelegramNotifier:
    def __init__(self, config_path=_CONFIG_PATH):
        self.enabled = False
        self.token = ""
        self.chat_id = ""
        self._requests = None
        self._load(config_path)

    def _load(self, config_path):
        try:
            import requests
            self._requests = requests
        except ImportError:
            logger.warning("Telegram: chưa cài 'requests' → tắt cảnh báo. Cài: pip install requests")
            return

        if not os.path.exists(config_path):
            logger.info("Telegram: chưa có %s → tắt cảnh báo.", os.path.basename(config_path))
            return
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Telegram: đọc config lỗi (%s) → tắt cảnh báo.", e)
            return

        self.token = str(cfg.get("bot_token", "")).strip()
        self.chat_id = str(cfg.get("chat_id", "")).strip()
        want = bool(cfg.get("enabled", True))

        if want and self.token and self.chat_id and "DAN_VAO" not in self.token:
            self.enabled = True
            logger.info("Telegram: BẬT cảnh báo vi phạm (chat_id=%s).", self.chat_id)
        else:
            logger.info("Telegram: chưa điền bot_token/chat_id trong config → tắt cảnh báo.")

    def send_violation(self, plate, vehicle_type, lane, timestamp, image_path=None):
        """Gửi cảnh báo 1 vi phạm (chạy nền, không chặn)."""
        if not self.enabled:
            return
        t = threading.Thread(
            target=self._send_worker,
            args=(plate, vehicle_type, lane, timestamp, image_path),
            daemon=True, name="TelegramSend")
        t.start()

    def _send_worker(self, plate, vehicle_type, lane, timestamp, image_path):
        caption = (
            "🚨 <b>VI PHẠM VƯỢT ĐÈN ĐỎ</b>\n"
            f"🚗 Loại xe: <b>{_esc(vehicle_type)}</b>\n"
            f"🔢 Biển số: <b>{_esc(plate) or 'Không đọc được'}</b>\n"
            f"🛣️ Tuyến: <b>{_esc(lane)}</b>\n"
            f"🕒 Thời gian: <b>{_esc(timestamp)}</b>\n"
            "📍 Ngã tư giám sát – TP. Đà Nẵng"
        )
        try:
            if image_path and os.path.exists(image_path):
                with open(image_path, "rb") as img:
                    r = self._requests.post(
                        f"{_API}/bot{self.token}/sendPhoto",
                        data={"chat_id": self.chat_id, "caption": caption, "parse_mode": "HTML"},
                        files={"photo": img}, timeout=15)
            else:
                r = self._requests.post(
                    f"{_API}/bot{self.token}/sendMessage",
                    data={"chat_id": self.chat_id, "text": caption, "parse_mode": "HTML"},
                    timeout=15)
            if r.status_code != 200:
                logger.warning("Telegram gửi lỗi %s: %s", r.status_code, r.text[:200])
            else:
                logger.info("Telegram: đã gửi cảnh báo vi phạm %s", plate)
        except Exception as e:  # noqa: BLE001 – không để lỗi mạng làm chết main
            logger.warning("Telegram gửi thất bại: %s", e)

    def test(self):
        """Gửi 1 tin nhắn thử để kiểm tra cấu hình."""
        if not self.enabled:
            print("Telegram đang TẮT. Điền bot_token + chat_id vào telegram_config.json trước.")
            return False
        try:
            r = self._requests.post(
                f"{_API}/bot{self.token}/sendMessage",
                data={"chat_id": self.chat_id,
                      "text": "✅ Kết nối Telegram thành công! Hệ thống giám sát Đà Nẵng đã sẵn sàng.",
                      "parse_mode": "HTML"}, timeout=15)
            ok = r.status_code == 200
            print("Gửi thử:", "THÀNH CÔNG" if ok else f"LỖI {r.status_code} – {r.text[:200]}")
            return ok
        except Exception as e:  # noqa: BLE001
            print("Gửi thử thất bại:", e)
            return False


def _esc(s):
    """Escape ký tự HTML cho parse_mode=HTML của Telegram."""
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            if s is not None else "")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
    TelegramNotifier().test()
