"""
hub_bridge.py — Chuyển tiếp vi phạm từ simulator lên hub STMS (tích hợp).

Simulator vẫn CHẠY ĐỘC LẬP được: bridge chỉ bật khi có biến môi trường
    HUB_URL       = http://<hub-host>:8000    (bỏ trống = tắt)
    HUB_DEVICE_KEY = <khóa khớp DEVICE_INGEST_KEY của hub>

Gửi ở LUỒNG NỀN (daemon thread), không chặn event loop WebSocket của simulator.
Dùng urllib chuẩn thư viện, KHÔNG thêm dependency mới.

Map ViolationEvent (simulator) -> canonical ingest của hub:
    trackId       -> source_track_id
    licensePlate  -> license_plate            (biển fake 5 số vẫn nhận được)
    vehicleClass  -> vehicle_type (lowercase)
    direction     -> direction
    movement      -> movement
    violation     -> violation_type (RED_LIGHT | WRONG_WAY)
    timestampMs   -> occurred_at (ISO)
    intersection  -> road_name
"""
from __future__ import annotations

import json
import logging
import os
import threading
import urllib.request
import urllib.error
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


class HubBridge:
    def __init__(self) -> None:
        self.base_url = (os.getenv("HUB_URL") or "").rstrip("/")
        self.device_key = os.getenv("HUB_DEVICE_KEY") or ""
        self.enabled = bool(self.base_url and self.device_key)
        if self.enabled:
            logger.info("HubBridge: BẬT chuyển tiếp vi phạm lên hub %s", self.base_url)
        else:
            logger.info("HubBridge: chưa cấu hình HUB_URL/HUB_DEVICE_KEY → tắt (chạy độc lập).")

    def forward_violation(self, event) -> None:
        """Xếp lịch gửi 1 vi phạm lên hub ở luồng nền. Không chặn, không raise."""
        if not self.enabled:
            return
        try:
            payload = self._map(event)
        except Exception as e:  # noqa: BLE001
            logger.warning("HubBridge: map sự kiện lỗi (%s).", e)
            return
        threading.Thread(target=self._post, args=(payload,), daemon=True,
                         name="HubBridge").start()

    def replay_history(self, events) -> None:
        """Đồng bộ lại log SQLite đã có khi bridge được bật sau simulator."""
        if not self.enabled:
            return
        payloads = []
        for event in events:
            try:
                payloads.append(self._map(event))
            except Exception as e:  # noqa: BLE001
                logger.warning("HubBridge: bỏ qua lịch sử lỗi map (%s).", e)
        if not payloads:
            return
        logger.info("HubBridge: đồng bộ lại %d vi phạm lịch sử lên hub.", len(payloads))
        threading.Thread(target=self._post_many, args=(payloads,), daemon=True,
                         name="HubBridgeReplay").start()

    def _post_many(self, payloads: list[dict]) -> None:
        for payload in payloads:
            self._post(payload)

    def _map(self, event) -> dict:
        occurred = None
        try:
            occurred = datetime.fromtimestamp(event.timestamp_ms / 1000, tz=timezone.utc).isoformat()
        except (ValueError, OverflowError, OSError):
            occurred = None
        vclass = getattr(event.vehicle_class, "value", str(event.vehicle_class))
        vio = getattr(event.violation, "value", str(event.violation))
        direction = getattr(event.direction, "value", str(event.direction))
        movement = getattr(event.movement, "value", str(event.movement))
        return {
            "source": "sim",
            # UUID is stable across simulator restarts; track_id is only locally unique.
            "source_track_id": str(event.id or event.track_id),
            "road_name": event.intersection,
            "direction": direction,
            "movement": movement,
            "vehicle_type": str(vclass).lower(),
            "license_plate": event.license_plate,
            "violation_type": str(vio).upper(),
            "occurred_at": occurred,
        }

    def _post(self, payload: dict) -> None:
        # Hub nhận multipart cho /ingest/violation; ở đây không có ảnh nên gửi
        # 1 phần form 'payload' bằng multipart tối giản tự dựng.
        boundary = "----simbridge7c2a"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="payload"\r\n\r\n'
            f"{json.dumps(payload, ensure_ascii=False)}\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/v1/ingest/violation",
            data=body, method="POST",
            headers={
                "X-Device-Key": self.device_key,
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status >= 300:
                    logger.warning("HubBridge: hub trả %s", resp.status)
        except urllib.error.URLError as e:
            logger.warning("HubBridge: gửi thất bại (%s).", e)
        except Exception as e:  # noqa: BLE001
            logger.warning("HubBridge: lỗi không xác định (%s).", e)
