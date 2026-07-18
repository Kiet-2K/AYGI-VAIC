"""
violation_detector.py – State machine phát hiện vi phạm đèn đỏ
Đặc điểm:
  - Theo dõi lịch sử vị trí từng xe theo track_id
  - State machine: UNKNOWN → APPROACHING → STOPPED → CROSSING → VIOLATED
  - Debounce: cần vượt qua stopline nhiều frame mới tính vi phạm
  - Tự dọn dẹp xe không còn xuất hiện
  - Hỗ trợ stopline ngang (Y cố định)
"""

from collections import defaultdict, deque
from enum import Enum, auto
import time
import logging

logger = logging.getLogger(__name__)


class VehicleState(Enum):
    UNKNOWN     = auto()  # Chưa đủ dữ liệu
    BELOW_LINE  = auto()  # Xe đang ở phía dưới vạch dừng (chưa qua)
    AT_LINE     = auto()  # Xe đang tiếp cận vạch dừng
    VIOLATED    = auto()  # Đã vi phạm (đã ghi nhận)


class VehicleTracker:
    """Theo dõi một xe duy nhất."""

    HISTORY_LEN    = 20   # Số frame lưu lịch sử
    DEBOUNCE_COUNT = 4    # Số frame liên tiếp vượt line mới ghi vi phạm
    MAX_IDLE_SEC   = 3.0  # Giây không thấy xe → xóa tracker

    def __init__(self, track_id, stop_line_y, direction="up", debounce_count=None):
        self.track_id   = track_id
        self.stop_line_y = stop_line_y
        self.direction  = direction  # "up" | "down" | "auto"
        if debounce_count is not None:
            self.DEBOUNCE_COUNT = debounce_count

        self.history    = deque(maxlen=self.HISTORY_LEN)  # [(cx, cy, cy_bottom, ts)]
        self.state      = VehicleState.UNKNOWN
        self.above_count = 0   # Đếm frame xe đã vượt vạch (theo hướng vi phạm)
        self.violated   = False
        self.last_seen  = time.time()
        self.label      = "vehicle"

    def _infer_direction(self):
        """Suy ra hướng di chuyển của xe từ lịch sử (dùng cho direction='auto')."""
        if len(self.history) < 5:
            return "up"
        ys = [h[2] for h in self.history]
        net = ys[-1] - ys[0]  # <0: đi lên (Y giảm), >0: đi xuống
        return "up" if net < 0 else "down"

    def update(self, box, label):
        """
        Cập nhật vị trí xe.
        box: [x1, y1, x2, y2]
        Trả về True nếu vi phạm mới được phát hiện.
        """
        x1, y1, x2, y2 = box
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2  # Dùng bottom center của xe để chính xác hơn
        cy_bottom = y2      # Mép dưới xe (phần tiếp xúc đất)

        self.label = label
        self.last_seen = time.time()
        self.history.append((cx, cy, cy_bottom, time.time()))

        # Cần ít nhất 3 điểm lịch sử để phán đoán
        if len(self.history) < 3:
            return False

        direction = self._infer_direction() if self.direction == "auto" else self.direction
        line = self.stop_line_y
        hist = list(self.history)
        recent = hist[-5:]

        # Tốc độ di chuyển – tránh false positive do rung camera
        displacement = abs(recent[-1][1] - recent[0][1])
        has_significant_movement = displacement > 5  # pixels

        if direction == "up":
            # Vi phạm: xe từng ở DƯỚI vạch → nay đã vượt LÊN trên vạch (đi lên)
            was_on_start = any(h[2] > line for h in hist[:-1])   # từng ở dưới
            now_crossed  = cy_bottom < line                       # nay ở trên
            moving_right_way = recent[-1][1] < recent[0][1]       # cy giảm = đi lên
        else:  # "down"
            # Vi phạm: xe từng ở TRÊN vạch → nay đã vượt XUỐNG dưới vạch (đi xuống)
            was_on_start = any(h[1] < line for h in hist[:-1])   # từng ở trên (dùng tâm)
            now_crossed  = cy > line                              # nay tâm ở dưới
            moving_right_way = recent[-1][1] > recent[0][1]      # cy tăng = đi xuống

        if now_crossed and was_on_start and moving_right_way and has_significant_movement:
            self.above_count += 1
        elif not now_crossed:
            self.above_count = 0

        # Chỉ tính vi phạm nếu đèn ĐỎ (kiểm tra từ bên ngoài) và debounce đủ
        if self.above_count >= self.DEBOUNCE_COUNT and not self.violated:
            return True  # Caller sẽ kiểm tra trạng thái đèn

        return False

    def mark_violated(self):
        self.violated = True
        self.state = VehicleState.VIOLATED

    def is_expired(self):
        return time.time() - self.last_seen > self.MAX_IDLE_SEC


class ViolationDetector:
    """
    Quản lý toàn bộ xe và phát hiện vi phạm.
    """

    def __init__(self, stop_line_y, confirm_frames=4, direction="up"):
        """
        stop_line_y: tọa độ Y của vạch dừng (pixel trên frame đã resize)
        confirm_frames: số frame liên tiếp cần vượt qua để xác nhận vi phạm
        direction: hướng xe vi phạm khi vượt vạch:
                   "up"   = xe đi từ dưới lên (mặc định, camera nhìn xe chạy tới)
                   "down" = xe đi từ trên xuống (camera lắp ngược hướng)
                   "auto" = tự suy ra từ quỹ đạo mỗi xe
        """
        self._stop_line_y  = stop_line_y
        self.confirm_frames = confirm_frames
        self.direction     = direction
        self.trackers: dict[int, VehicleTracker] = {}
        self._violation_history: list[dict] = []  # Log vi phạm đã xảy ra

    @property
    def stop_line_y(self):
        return self._stop_line_y

    @stop_line_y.setter
    def stop_line_y(self, value):
        """Cập nhật vạch dừng và truyền xuống tất cả tracker đang hoạt động."""
        self._stop_line_y = value
        for tracker in self.trackers.values():
            tracker.stop_line_y = value

    # ------------------------------------------------------------------
    def update(self, track_id, box, label, light_status):
        """
        Cập nhật vị trí xe và kiểm tra vi phạm.
        Trả về dict thông tin vi phạm nếu có, ngược lại trả về None.
        """
        if track_id not in self.trackers:
            self.trackers[track_id] = VehicleTracker(
                track_id, self.stop_line_y, self.direction, self.confirm_frames)

        tracker = self.trackers[track_id]
        potential_violation = tracker.update(box, label)

        # Chỉ ghi nhận vi phạm khi đèn ĐỎ và đủ debounce
        if potential_violation and light_status == "red" and not tracker.violated:
            tracker.mark_violated()
            info = {
                "track_id"  : track_id,
                "label"     : label,
                "box"       : box,
                "timestamp" : time.strftime("%Y%m%d_%H%M%S"),
                "light"     : light_status,
            }
            self._violation_history.append(info)
            logger.info("VI PHẠM! ID=%d %s vượt đèn đỏ", track_id, label)
            return info

        return None

    # ------------------------------------------------------------------
    def cleanup(self):
        """Xóa các tracker của xe không còn xuất hiện."""
        expired = [tid for tid, t in self.trackers.items() if t.is_expired()]
        for tid in expired:
            del self.trackers[tid]

    # ------------------------------------------------------------------
    def get_state(self, track_id):
        if track_id in self.trackers:
            return self.trackers[track_id].state
        return VehicleState.UNKNOWN

    def has_violated(self, track_id):
        if track_id in self.trackers:
            return self.trackers[track_id].violated
        return False

    def total_violations(self):
        return len(self._violation_history)

    def violation_history(self):
        return list(self._violation_history)
