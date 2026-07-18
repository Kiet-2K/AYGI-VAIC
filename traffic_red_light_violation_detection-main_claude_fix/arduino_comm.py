"""
arduino_comm.py – TCP Client giao tiếp với Arduino Mega qua Ethernet
Giao thức: JSON strings, mỗi lệnh kết thúc bằng newline '\n'

Lệnh gửi đi (PC → Arduino):
  {"cmd":"PING"}
  {"cmd":"VIOLATION","plate":"51A12345","type":"car","ts":"20260713_235959"}
  {"cmd":"LIGHT_STATUS","state":"red"}
  {"cmd":"STATS"}

Phản hồi từ Arduino (Arduino → PC):
  {"status":"PONG"}
  {"status":"OK","violations":5}
  {"status":"OK","light":"red","violations":3}
"""

import socket
import json
import threading
import time
import logging

logger = logging.getLogger(__name__)


class ArduinoComm:
    """
    TCP Client kết nối tới Arduino Mega (TCP Server).
    Tự động reconnect khi mất kết nối.
    Thread-safe.
    """

    RECONNECT_DELAY = 5.0   # giây chờ giữa các lần thử kết nối
    SEND_TIMEOUT    = 3.0   # giây timeout khi gửi
    RECV_TIMEOUT    = 3.0   # giây timeout khi nhận

    def __init__(self, host="192.168.1.200", port=8080, enabled=True):
        """
        host: IP của Arduino Mega (đặt trong code Arduino)
        port: port TCP server trên Arduino (mặc định 8080)
        enabled: False = chạy ở chế độ offline (không cần Arduino)
        """
        self.host    = host
        self.port    = port
        self.enabled = enabled

        self._sock   = None
        self._lock   = threading.Lock()
        self._connected = False
        self._running   = False
        self._thread    = None
        self._reader    = None
        self._total_sent = 0

        # Trạng thái đèn Mega ĐẨY VỀ (Mega là bộ điều khiển đèn)
        # g_v/g_h = thời gian xanh thích ứng; c_v/c_h = số xe Mega dùng để tính
        self._light = {
            "vertical": "unknown", "horizontal": "unknown",
            "t_v": 0, "t_h": 0,
            "g_v": 0, "g_h": 0, "c_v": 0, "c_h": 0,
        }
        self._recv_buf = ""

    # ------------------------------------------------------------------
    def start(self):
        """Bắt đầu thread kết nối nền."""
        if not self.enabled:
            logger.info("ArduinoComm: chế độ OFFLINE (không kết nối Arduino)")
            return
        self._running = True
        self._thread = threading.Thread(target=self._connect_loop, daemon=True, name="ArduinoCommThread")
        self._thread.start()
        self._reader = threading.Thread(target=self._reader_loop, daemon=True, name="ArduinoReaderThread")
        self._reader.start()

    def stop(self):
        self._running = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=5)
        if self._reader:
            self._reader.join(timeout=5)
        logger.info("ArduinoComm đã đóng.")

    # ------------------------------------------------------------------
    def _reader_loop(self):
        """Thread nền: đọc liên tục dòng JSON Mega đẩy về (nhất là LIGHT)."""
        while self._running:
            sock = self._sock if self._connected else None
            if sock is None:
                time.sleep(0.2)
                continue
            try:
                data = sock.recv(512)
                if not data:
                    time.sleep(0.1)
                    continue
                self._recv_buf += data.decode("utf-8", errors="replace")
                while "\n" in self._recv_buf:
                    line, self._recv_buf = self._recv_buf.split("\n", 1)
                    self._handle_incoming(line.strip())
            except socket.timeout:
                continue
            except (socket.error, OSError):
                time.sleep(0.2)
                continue

    def _handle_incoming(self, line: str):
        """Parse 1 dòng JSON từ Mega. Quan tâm status=LIGHT để cập nhật đèn."""
        if not line:
            return
        try:
            msg = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            return
        if msg.get("status") == "LIGHT":
            with self._lock:
                for k in ("vertical", "horizontal"):
                    if k in msg:
                        self._light[k] = str(msg[k]).lower()
                for k in ("t_v", "t_h", "g_v", "g_h", "c_v", "c_h"):
                    if k in msg:
                        try:
                            self._light[k] = int(msg[k])
                        except (ValueError, TypeError):
                            pass
            logger.debug("Đèn từ Mega: %s", self._light)

    # ------------------------------------------------------------------
    def _connect_loop(self):
        """Thread nền: liên tục thử kết nối tới Arduino."""
        while self._running:
            if not self._connected:
                try:
                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sock.settimeout(5.0)
                    sock.connect((self.host, self.port))
                    sock.settimeout(self.RECV_TIMEOUT)
                    with self._lock:
                        self._sock = sock
                        self._connected = True
                    logger.info("Arduino kết nối thành công: %s:%d", self.host, self.port)

                    # Ping xác nhận
                    self._send_raw({"cmd": "PING"})

                except (socket.error, OSError) as e:
                    logger.warning("Arduino kết nối thất bại: %s – thử lại sau %.0fs", e, self.RECONNECT_DELAY)
                    self._connected = False
                    time.sleep(self.RECONNECT_DELAY)
            else:
                # Gửi keepalive ping mỗi 10 giây
                time.sleep(10)
                ok = self._send_raw({"cmd": "PING"})
                if not ok:
                    with self._lock:
                        self._connected = False
                    logger.warning("Arduino mất kết nối – đang thử lại...")

    # ------------------------------------------------------------------
    def _send_raw(self, data: dict) -> bool:
        """Gửi JSON + newline tới Arduino. Trả về True nếu thành công."""
        if not self.enabled:
            return True
        try:
            msg = json.dumps(data, ensure_ascii=False) + "\n"
            with self._lock:
                if self._sock is None:
                    return False
                self._sock.sendall(msg.encode("utf-8"))
                self._total_sent += 1
            return True
        except (socket.error, OSError) as e:
            logger.error("Gửi lệnh thất bại: %s", e)
            with self._lock:
                self._connected = False
                try:
                    self._sock.close()
                except Exception:
                    pass
                self._sock = None
            return False

    # ------------------------------------------------------------------
    def send_violation(self, plate: str, vehicle_type: str, timestamp: str = None) -> bool:
        """
        Thông báo vi phạm tới Arduino.
        plate: biển số xe (vd: "51A12345")
        vehicle_type: loại xe ("car", "motorcycle", ...)
        """
        if timestamp is None:
            timestamp = time.strftime("%Y%m%d_%H%M%S")

        data = {
            "cmd"   : "VIOLATION",
            "plate" : plate,
            "type"  : vehicle_type,
            "ts"    : timestamp,
        }
        ok = self._send_raw(data)
        if ok:
            logger.info("Gửi vi phạm → Arduino: %s [%s]", plate, vehicle_type)
        return ok

    def send_count(self, vertical: int, horizontal: int) -> bool:
        """
        Gửi số xe đếm được mỗi trục cho Mega để chỉnh thời gian đèn thích ứng.
        vertical  : số xe trục dọc (Bắc-Nam) trong chu kỳ vừa rồi
        horizontal: số xe trục ngang (Đông-Tây)
        """
        ok = self._send_raw({"cmd": "COUNT",
                             "vertical": int(vertical),
                             "horizontal": int(horizontal)})
        if ok:
            logger.info("Gửi COUNT → Mega: dọc=%d, ngang=%d", vertical, horizontal)
        return ok

    def send_light_status(self, state: str) -> bool:
        """(Giữ tương thích ngược – Mega giờ TỰ điều khiển đèn, không nhận lệnh này)."""
        return True

    def request_stats(self) -> bool:
        """Yêu cầu Arduino gửi thống kê hiện tại."""
        return self._send_raw({"cmd": "STATS"})

    # ------------------------------------------------------------------
    def get_light(self, axis: str = "vertical") -> str:
        """Trạng thái đèn của trục ('vertical'|'horizontal') do Mega đẩy về."""
        with self._lock:
            return self._light.get(axis, "unknown")

    def get_light_time(self, axis: str = "vertical") -> int:
        """Giây còn lại của đèn trục đó (Mega đẩy về, dùng hiển thị UI)."""
        with self._lock:
            return int(self._light.get("t_v" if axis == "vertical" else "t_h", 0))

    def get_green_time(self, axis: str = "vertical") -> int:
        """Thời gian xanh THÍCH ỨNG Mega tính cho trục đó (giây). 0 nếu chưa có."""
        with self._lock:
            return int(self._light.get("g_v" if axis == "vertical" else "g_h", 0))

    # ------------------------------------------------------------------
    def is_connected(self):
        return self._connected and self.enabled

    def total_sent(self):
        return self._total_sent

    # ------------------------------------------------------------------
    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *args):
        self.stop()


# ======================================================================
# Chạy thử độc lập – python arduino_comm.py --host 192.168.1.200
# ======================================================================
if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")

    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.1.200")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()

    comm = ArduinoComm(host=args.host, port=args.port)
    comm.start()

    time.sleep(2)
    print(f"Kết nối: {comm.is_connected()}")

    # Test gửi vi phạm
    comm.send_violation("51A12345", "car")
    time.sleep(1)
    comm.send_light_status("red")
    time.sleep(5)
    comm.stop()
