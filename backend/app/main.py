from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .controller import GreenPhase, TrafficController
from .hardware import MockTrafficLightOutput, TrafficLightOutput
from .schemas import ControlCommand, TrafficReport, ViolationEvent


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
    def __init__(self, output: TrafficLightOutput | None = None) -> None:
        self.controller = TrafficController()
        self.connections = ConnectionManager()
        self.output = output or MockTrafficLightOutput()
        self.violations: list[dict[str, Any]] = []
        self._last_broadcast_revision = -1
        self._last_broadcast_at = 0.0

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

    async def record_violation(self, event: ViolationEvent) -> None:
        key = (event.track_id, event.violation)
        if any((item["trackId"], item["violation"]) == key for item in self.violations):
            return
        payload = event.model_dump(by_alias=True)
        self.violations.append(payload)
        # Bound in-memory history; persistent storage is intentionally out of scope.
        if len(self.violations) > 200:
            del self.violations[:-200]
        await self.connections.broadcast(payload)

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


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/traffic")
async def traffic_socket(websocket: WebSocket) -> None:
    service: TrafficService = websocket.app.state.traffic_service
    await service.connections.connect(websocket)
    try:
        await service.connections.send(websocket, service.payload())
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
