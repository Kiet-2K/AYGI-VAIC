from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

Direction = Literal["north", "south", "east", "west"]
SignalColor = Literal["GREEN", "YELLOW", "RED"]
GreenPhase = Literal["NS_LEFT", "NS_STRAIGHT_RIGHT", "EW_LEFT", "EW_STRAIGHT_RIGHT"]
SubPhase = Literal["GREEN", "YELLOW", "ALL_RED"]
TrafficState = Literal["FREE", "BUSY", "CONGESTED", "GRIDLOCK"]


class MovementStats(BaseModel):
    queue_length: int = Field(alias="queueLength", ge=0, default=0)
    queue_pcu: float = Field(alias="queuePcu", ge=0, default=0)
    arrival_rate: float = Field(alias="arrivalRate", ge=0, default=0)
    avg_waiting_time: float = Field(alias="avgWaitingTime", ge=0, default=0)
    max_waiting_time: float = Field(alias="maxWaitingTime", ge=0, default=0)
    downstream_occupancy: float = Field(alias="downstreamOccupancy", ge=0, le=1, default=0)

    model_config = ConfigDict(populate_by_name=True)


class DirectionStats(BaseModel):
    total: int = Field(ge=0, default=0)
    waiting: int = Field(ge=0, default=0)
    queue_pcu: float = Field(alias="queuePcu", ge=0, default=0)
    median_speed: float = Field(alias="medianSpeed", ge=0, default=0)
    arrival_rate: float = Field(alias="arrivalRate", ge=0, default=0)
    departure_rate: float = Field(alias="departureRate", ge=0, default=0)
    occupancy: float = Field(ge=0, le=1, default=0)
    left: MovementStats = Field(default_factory=MovementStats)
    through: MovementStats = Field(default_factory=MovementStats)

    model_config = ConfigDict(populate_by_name=True)


class DirectionStatsMap(BaseModel):
    north: DirectionStats = Field(default_factory=DirectionStats)
    south: DirectionStats = Field(default_factory=DirectionStats)
    east: DirectionStats = Field(default_factory=DirectionStats)
    west: DirectionStats = Field(default_factory=DirectionStats)


class EmergencyMovement(BaseModel):
    phase: GreenPhase


class TrafficReport(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["traffic_report"]
    sequence: int = Field(ge=0)
    timestamp_ms: int = Field(alias="timestampMs", ge=0)
    stats: DirectionStatsMap
    box_occupied: bool = Field(alias="boxOccupied", default=False)
    emergency: EmergencyMovement | None = None


class DirectionCountdown(BaseModel):
    seconds: float = Field(ge=0)
    visible: bool
    color: SignalColor


class CountdownMap(BaseModel):
    north: DirectionCountdown
    south: DirectionCountdown
    east: DirectionCountdown
    west: DirectionCountdown


class SignalState(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["signal_state"] = "signal_state"
    revision: int = Field(ge=0)
    server_timestamp_ms: int = Field(alias="serverTimestampMs", ge=0)
    phase: GreenPhase
    sub_phase: SubPhase = Field(alias="subPhase")
    planned_next: GreenPhase = Field(alias="plannedNext")
    signals: dict[Direction, SignalColor]
    countdowns: CountdownMap
    main_signals: dict[Direction, SignalColor] = Field(alias="mainSignals")
    left_signals: dict[Direction, SignalColor] = Field(alias="leftSignals")
    main_countdowns: CountdownMap = Field(alias="mainCountdowns")
    left_countdowns: CountdownMap = Field(alias="leftCountdowns")
    remaining_ms: int = Field(alias="remainingMs", ge=0)
    committed: bool
    manual: bool
    state: TrafficState
    reason: str
    preempted: bool
    preempt_target: GreenPhase | None = Field(alias="preemptTarget")
    telemetry_stale: bool = Field(alias="telemetryStale")


ControlAction = Literal["AUTO", "MANUAL", "NEXT", "ALL_RED", "CLEAR_ALL_RED", "RESET"]


class ControlCommand(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["control_command"]
    command_id: str = Field(alias="commandId", min_length=1, max_length=64)
    action: ControlAction


ViolationType = Literal["RED_LIGHT", "WRONG_WAY"]
VehicleClass = Literal[
    "MOTORBIKE",
    "CAR",
    "BUS",
    "TRUCK",
    "HEAVY_TRUCK",
    "AMBULANCE",
    "FIRE_TRUCK",
    "POLICE",
    "MILITARY",
]
Turn = Literal["LEFT", "STRAIGHT", "RIGHT"]


class ViolationEvidence(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    lane_id: str = Field(alias="laneId", min_length=1)
    speed: float = Field(ge=0)
    signal: SignalColor


class ViolationEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["violation_event"]
    id: UUID | None = None
    track_id: int = Field(alias="trackId", ge=1)
    license_plate: str = Field(alias="licensePlate", pattern=r"^\d{5}$")
    vehicle_class: VehicleClass = Field(alias="vehicleClass")
    direction: Direction
    movement: Turn
    violation: ViolationType
    signal: SignalColor
    timestamp_ms: int = Field(alias="timestampMs", ge=0)
    intersection: str = Field(min_length=1, max_length=120)
    evidence_image: str | None = Field(alias="evidenceImage", default=None, max_length=2_000_000)
    evidence_image_url: str | None = Field(alias="evidenceImageUrl", default=None)
    evidence: ViolationEvidence


class ViolationDeleteBatch(BaseModel):
    ids: list[UUID] = Field(min_length=1, max_length=200)


class ViolationHistory(BaseModel):
    type: Literal["violation_history"] = "violation_history"
    violations: list[ViolationEvent]
