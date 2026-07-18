export const DIRECTIONS = ["north", "south", "east", "west"] as const;

export type Direction = (typeof DIRECTIONS)[number];
export type SignalColor = "GREEN" | "YELLOW" | "RED";
export type GreenPhase = "NS_LEFT" | "NS_STRAIGHT_RIGHT" | "EW_LEFT" | "EW_STRAIGHT_RIGHT";
export type SubPhase = "GREEN" | "YELLOW" | "ALL_RED";
export type TrafficState = "FREE" | "BUSY" | "CONGESTED" | "GRIDLOCK";

export const ROAD_NAMES: Record<Direction, string> = {
  north: "Đường Trần Hưng Đạo",
  south: "Đường 3 Tháng 2",
  east: "Đường Mậu Thân (phía Đông)",
  west: "Đường Mậu Thân (phía Tây)"
};

export type QueueCounts = Record<Direction, number>;
export type SignalMap = Record<Direction, SignalColor>;

export interface DirectionTrafficCount {
  total: number;
  waiting: number;
}
export type DirectionTrafficCounts = Record<Direction, DirectionTrafficCount>;

export interface DirectionCountdown {
  seconds: number;
  visible: boolean;
  color: SignalColor;
}
export type CountdownMap = Record<Direction, DirectionCountdown>;

export interface MovementTelemetry {
  queueLength: number;
  queuePcu: number;
  arrivalRate: number;
  avgWaitingTime: number;
  maxWaitingTime: number;
  downstreamOccupancy: number;
}

export interface DirectionTelemetry {
  total: number;
  waiting: number;
  queuePcu: number;
  medianSpeed: number;
  arrivalRate: number;
  departureRate: number;
  occupancy: number;
  left: MovementTelemetry;
  through: MovementTelemetry;
}

export type TrafficStatsMap = Record<Direction, DirectionTelemetry>;

export interface TrafficReport {
  type: "traffic_report";
  sequence: number;
  timestampMs: number;
  stats: TrafficStatsMap;
  boxOccupied: boolean;
  emergency: { phase: GreenPhase } | null;
}

export interface SignalState {
  type: "signal_state";
  revision: number;
  serverTimestampMs: number;
  phase: GreenPhase;
  subPhase: SubPhase;
  plannedNext: GreenPhase;
  signals: SignalMap;
  countdowns: CountdownMap;
  remainingMs: number;
  committed: boolean;
  manual: boolean;
  state: TrafficState;
  reason: string;
  preempted: boolean;
  preemptTarget: GreenPhase | null;
  telemetryStale: boolean;
}

export type ControlAction = "AUTO" | "MANUAL" | "NEXT" | "ALL_RED" | "CLEAR_ALL_RED" | "RESET";
export interface ControlAcknowledgement {
  type: "control_ack";
  commandId: string;
  action: ControlAction;
  accepted: boolean;
}

export type BackendConnectionState = "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "STALE";

export interface DetectionBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  waiting: boolean;
  confidence: number;
  trackId: number;
  vehicleClass: string;
  laneId: string;
  direction: Direction;
  speed: number;
  pcu: number;
  stopped: boolean;
  wrongWay: boolean;
  emergency: boolean;
  licensePlate?: string;
  redLightViolation?: boolean;
}

export const SAFE_SIGNALS: SignalMap = {
  north: "RED",
  south: "RED",
  east: "RED",
  west: "RED"
};

export const BLANK_COUNTDOWNS: CountdownMap = {
  north: { seconds: 0, visible: false, color: "RED" },
  south: { seconds: 0, visible: false, color: "RED" },
  east: { seconds: 0, visible: false, color: "RED" },
  west: { seconds: 0, visible: false, color: "RED" }
};

export const EMPTY_QUEUES: QueueCounts = { north: 0, south: 0, east: 0, west: 0 };
export const EMPTY_TRAFFIC_COUNTS: DirectionTrafficCounts = {
  north: { total: 0, waiting: 0 },
  south: { total: 0, waiting: 0 },
  east: { total: 0, waiting: 0 },
  west: { total: 0, waiting: 0 }
};
