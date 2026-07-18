from __future__ import annotations

from typing import Protocol


class TrafficLightOutput(Protocol):
    """Replace this adapter with an ESP32 implementation without touching control logic."""

    async def set_signals(self, signals: dict[str, str]) -> None: ...


class MockTrafficLightOutput:
    """In-memory hardware substitute used by the simulation and tests."""

    def __init__(self) -> None:
        self.last_signals: dict[str, str] = {}

    async def set_signals(self, signals: dict[str, str]) -> None:
        self.last_signals = signals.copy()
