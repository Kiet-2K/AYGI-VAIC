from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import ValidationError

from .controller import GreenPhase, TrafficController
from .hardware import MockTrafficLightOutput, TrafficLightOutput
from .schemas import ControlCommand, TrafficReport, ViolationDeleteBatch, ViolationEvent, ViolationHistory
from .violations import SQLiteViolationRepository, ViolationRepository
from .hub_bridge import HubBridge


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    async def send(self, websocket: WebSocket, payload: dict[str, Any]) -> None:
        await websocket.send_json(payload)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self.connections:
            return
        sockets = tuple(self.connections)
        results = await asyncio.gather(
            *(websocket.send_json(payload) for websocket in sockets),
            return_exceptions=True,
        )
        for websocket, result in zip(sockets, results, strict=True):
            if isinstance(result, Exception):
                self.disconnect(websocket)


class TrafficService:
    def __init__(
        self,
        output: TrafficLightOutput | None = None,
        violations: ViolationRepository | None = None,
    ) -> None:
        self.controller = TrafficController()
        self.connections = ConnectionManager()
        self.output = output or MockTrafficLightOutput()
        data_dir = Path(__file__).resolve().parents[1] / "data"
        self.violations = violations or SQLiteViolationRepository(
            data_dir / "traffic.db",
            data_dir / "evidence",
        )
        self._last_broadcast_revision = -1
        self._last_broadcast_at = 0.0
        # Cầu nối tùy chọn: chuyển tiếp vi phạm lên hub STMS (tích hợp).
        # Tự tắt nếu chưa cấu hình HUB_URL/HUB_DEVICE_KEY → simulator chạy độc lập.
        self.hub_bridge = HubBridge()
        self.hub_bridge.replay_history(self.violations.list())

    def payload(self) -> dict[str, Any]:
        return self.controller.snapshot().model_dump(by_alias=True)

    async def record_report(self, report: TrafficReport) -> bool:
        emergency = GreenPhase(report.emergency.phase) if report.emergency else None
        return self.controller.update_report(
            report.stats,
            report.box_occupied,
            emergency,
            report.sequence,
        )

    def violation_history_payload(self) -> dict[str, Any]:
        return ViolationHistory(violations=self.violations.list()).model_dump(
            by_alias=True,
            mode="json",
        )

    async def record_violation(self, event: ViolationEvent) -> bool:
        recorded = self.violations.add(event)
        if recorded is None:
            return False
        # Chuyển tiếp lên hub STMS (nền, không chặn) — chỉ khi bridge được bật.
        self.hub_bridge.forward_violation(recorded)
        await self.connections.broadcast(recorded.model_dump(by_alias=True, mode="json", exclude_none=True))
        return True

    async def delete_violations(self, ids: list[UUID] | None = None) -> int:
        deleted, _plates, _paths = self.violations.delete(ids)
        if deleted:
            await self.connections.broadcast(self.violation_history_payload())
        return deleted

    async def handle_command(self, command: ControlCommand) -> None:
        self.controller.command(command.action)
        await self.connections.broadcast(
            {
                "type": "control_ack",
                "commandId": command.command_id,
                "action": command.action,
                "accepted": True,
            }
        )

    async def tick(self, loop_time: float) -> None:
        changed = self.controller.tick()
        snapshot = self.controller.snapshot()
        if changed:
            await self.output.set_signals(snapshot.signals)
        # 10 Hz state stream, plus immediate broadcast on every visible revision.
        should_broadcast = changed or snapshot.revision != self._last_broadcast_revision or loop_time - self._last_broadcast_at >= 0.1
        if should_broadcast:
            await self.connections.broadcast(snapshot.model_dump(by_alias=True))
            self._last_broadcast_revision = snapshot.revision
            self._last_broadcast_at = loop_time


async def controller_loop(service: TrafficService) -> None:
    loop = asyncio.get_running_loop()
    while True:
        await service.tick(loop.time())
        await asyncio.sleep(0.05)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    service = TrafficService()
    app.state.traffic_service = service
    task = asyncio.create_task(controller_loop(service))
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Bộ điều khiển đèn giao thông thông minh", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        # Cloudflare Pages domains (cập nhật sau khi deploy frontend)
        "https://*.pages.dev",
        # Cho phép tất cả Cloudflare Pages subdomain
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/violations")
async def list_violations(
    limit: int = Query(default=200, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    service: TrafficService = app.state.traffic_service
    items = service.violations.list(limit, offset)
    return {
        "type": "violation_history",
        "violations": [item.model_dump(by_alias=True, mode="json", exclude_none=True) for item in items],
    }


@app.get("/api/evidence/{name}")
async def evidence_image(name: str) -> FileResponse:
    if not name.endswith(".jpg") or Path(name).name != name:
        raise HTTPException(status_code=404)
    data_dir = Path(__file__).resolve().parents[1] / "data" / "evidence"
    path = data_dir / name
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/jpeg")


@app.delete("/api/violations/{record_id}")
async def delete_violation(record_id: UUID) -> dict[str, int]:
    service: TrafficService = app.state.traffic_service
    return {"deleted": await service.delete_violations([record_id])}


@app.post("/api/violations/delete-batch")
async def delete_violation_batch(command: ViolationDeleteBatch) -> dict[str, int]:
    service: TrafficService = app.state.traffic_service
    return {"deleted": await service.delete_violations(command.ids)}


@app.delete("/api/violations")
async def delete_all_violations() -> dict[str, int]:
    service: TrafficService = app.state.traffic_service
    return {"deleted": await service.delete_violations()}


@app.websocket("/ws/traffic")
async def traffic_socket(websocket: WebSocket) -> None:
    service: TrafficService = websocket.app.state.traffic_service
    await service.connections.connect(websocket)
    try:
        await service.connections.send(websocket, service.payload())
        await service.connections.send(websocket, service.violation_history_payload())
        while True:
            raw_message = await websocket.receive_json()
            message_type = raw_message.get("type") if isinstance(raw_message, dict) else None
            try:
                if message_type == "traffic_report":
                    report = TrafficReport.model_validate(raw_message)
                    accepted = await service.record_report(report)
                    if not accepted:
                        await service.connections.send(
                            websocket,
                            {"type": "error", "message": "Báo cáo cũ hoặc sai thứ tự."},
                        )
                elif message_type == "control_command":
                    await service.handle_command(ControlCommand.model_validate(raw_message))
                elif message_type == "violation_event":
                    await service.record_violation(ViolationEvent.model_validate(raw_message))
                else:
                    await service.connections.send(
                        websocket,
                        {"type": "error", "message": "Loại thông điệp không được hỗ trợ."},
                    )
            except ValidationError as error:
                await service.connections.send(
                    websocket,
                    {"type": "error", "message": "Dữ liệu không hợp lệ.", "detail": error.errors()},
                )
    except WebSocketDisconnect:
        service.connections.disconnect(websocket)
