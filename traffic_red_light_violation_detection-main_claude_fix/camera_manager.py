"""
camera_manager.py – Quản lý camera thật (USB webcam / IP camera RTSP)
Đặc điểm:
  - Thread riêng đọc frame liên tục → không bao giờ bị lag do inference
  - Tự động reconnect khi mất tín hiệu camera
  - Hỗ trợ USB webcam (index int) và IP camera (RTSP URL string)
"""

import cv2
import sys
import threading
import time
import logging

logger = logging.getLogger(__name__)


class CameraManager:
    """
    Quản lý camera với buffer frame riêng.
    Dùng thread nền để liên tục đọc frame → inference thread luôn có frame mới nhất.
    """

    def __init__(self, source=0, width=1280, height=720, fps=30, reconnect_delay=3.0):
        """
        source: int (index webcam USB) hoặc str (RTSP URL)
                Ví dụ: 0, 1, 'rtsp://admin:pass@192.168.1.100:554/stream'
        width/height: độ phân giải mong muốn (0 = giữ nguyên camera)
        fps: FPS mong muốn
        reconnect_delay: giây chờ trước khi thử kết nối lại
        """
        self.source = source
        self.width = width
        self.height = height
        self.fps = fps
        self.reconnect_delay = reconnect_delay

        self._cap = None
        self._frame = None
        self._lock = threading.Lock()
        self._running = False
        self._thread = None
        self._connected = False
        self._frame_count = 0
        self._last_frame_time = 0.0

    # ------------------------------------------------------------------
    def _open_camera(self):
        """Mở camera và cấu hình độ phân giải / FPS."""
        if isinstance(self.source, int):
            # USB webcam. CAP_DSHOW chi co tren Windows; Linux (Jetson) dung backend mac dinh (V4L2).
            if sys.platform == "win32":
                cap = cv2.VideoCapture(self.source, cv2.CAP_DSHOW)
                if not cap.isOpened():
                    cap = cv2.VideoCapture(self.source)
            else:
                cap = cv2.VideoCapture(self.source)
        else:
            # IP camera / RTSP
            cap = cv2.VideoCapture(self.source)

        if not cap.isOpened():
            return None

        # Đặt độ phân giải
        if self.width > 0:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        if self.height > 0:
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        if self.fps > 0:
            cap.set(cv2.CAP_PROP_FPS, self.fps)

        # Giảm buffer nội bộ của OpenCV → lấy frame mới nhất, không bị trễ
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        return cap

    # ------------------------------------------------------------------
    def _read_loop(self):
        """Vòng lặp nền: liên tục đọc frame từ camera."""
        while self._running:
            # Kết nối lần đầu hoặc sau khi mất kết nối
            if self._cap is None or not self._cap.isOpened():
                self._connected = False
                logger.warning("Camera mất kết nối, đang thử lại sau %.1fs...", self.reconnect_delay)
                time.sleep(self.reconnect_delay)

                self._cap = self._open_camera()
                if self._cap is None:
                    continue

                # Đọc vài frame bỏ đi để camera ổn định
                for _ in range(5):
                    self._cap.read()

                self._connected = True
                logger.info("Camera kết nối thành công: %s", self.source)

            ret, frame = self._cap.read()
            if not ret or frame is None:
                self._cap.release()
                self._cap = None
                self._connected = False
                continue

            with self._lock:
                self._frame = frame
                self._frame_count += 1
                self._last_frame_time = time.time()

    # ------------------------------------------------------------------
    def start(self):
        """Bắt đầu thread đọc camera."""
        if self._running:
            return

        self._running = True
        self._thread = threading.Thread(target=self._read_loop, daemon=True, name="CameraThread")
        self._thread.start()

        # Chờ frame đầu tiên (tối đa 45 giây — Nano tải nặng frame đầu về chậm)
        deadline = time.time() + 45
        while time.time() < deadline:
            if self._frame is not None:
                break
            time.sleep(0.1)

        if self._frame is None:
            logger.warning("Không nhận được frame sau 10s. Kiểm tra lại camera.")
        else:
            logger.info("Camera sẵn sàng. Độ phân giải: %dx%d",
                        self._frame.shape[1], self._frame.shape[0])

    # ------------------------------------------------------------------
    def read(self):
        """
        Trả về frame mới nhất (copy).
        Trả về None nếu chưa có frame.
        """
        with self._lock:
            if self._frame is None:
                return None
            return self._frame.copy()

    # ------------------------------------------------------------------
    def is_connected(self):
        return self._connected

    def frame_count(self):
        return self._frame_count

    def fps_actual(self):
        """FPS thực tế (ước tính dựa trên thời gian frame cuối)."""
        # Đây chỉ là xấp xỉ đơn giản
        return self._cap.get(cv2.CAP_PROP_FPS) if self._cap else 0.0

    # ------------------------------------------------------------------
    def stop(self):
        """Dừng thread và giải phóng camera."""
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=5)
        if self._cap is not None:
            self._cap.release()
        logger.info("Camera đã đóng.")

    # ------------------------------------------------------------------
    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *args):
        self.stop()


# ======================================================================
# Chạy thử độc lập – python camera_manager.py
# ======================================================================
if __name__ == "__main__":
    import argparse
    import sys

    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")

    ap = argparse.ArgumentParser(description="Test CameraManager")
    ap.add_argument("--source", default="0",
                    help="Index webcam (0,1,...) hoặc RTSP URL")
    args = ap.parse_args()

    # Chuyển source về int nếu là số
    source = args.source
    try:
        source = int(source)
    except ValueError:
        pass  # giữ nguyên string (RTSP)

    with CameraManager(source=source, width=1280, height=720) as cam:
        print("Nhấn 'q' để thoát")
        while True:
            frame = cam.read()
            if frame is None:
                print("Chờ camera...", end="\r")
                time.sleep(0.1)
                continue

            cv2.putText(frame, f"Frame #{cam.frame_count()} | Connected: {cam.is_connected()}",
                        (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            cv2.imshow("Camera Test", frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
    cv2.destroyAllWindows()
