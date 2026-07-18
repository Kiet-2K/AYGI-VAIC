import {
  AdaptiveController,
  EMPTY_DIRECTION_STATS,
  phaseDemand,
  type DirectionStats,
  type MovementStats,
  type StatsMap
} from "@/lib/sim/adaptiveController";
import { ConflictRegistry, initRouteConflictZones, zoneAt } from "@/lib/sim/conflictBox";
import { APPROACH_LENGTH, routesForDirection, sampleAt, type Route, type Turn } from "@/lib/sim/roadGraph";
import { GREEN_PHASES, SignalController, clampGreen, type GreenPhase } from "@/lib/sim/signalController";
import { createVehicle, integrateVehicle, type Vehicle } from "@/lib/sim/vehicle";
import { pickEmergencyClass, pickVehicleClass, VEHICLE_CLASSES } from "@/lib/sim/vehicleClasses";
import { updateWrongWay } from "@/lib/sim/wrongWay";
import {
  BLANK_COUNTDOWNS,
  DIRECTIONS,
  SAFE_SIGNALS,
  type CountdownMap,
  type Direction,
  type DirectionTrafficCounts,
  type QueueCounts,
  type SignalMap,
  type SignalState,
  type TrafficReport,
  type ViolationEvent
} from "@/types/traffic";

/**
 * Simulation engine (Spec: single source of truth).
 *
 * Owns the whole traffic world and advances it with a fixed-order pipeline each
 * tick: spawn -> per-lane car-following + signal/conflict gating -> integrate ->
 * wrong-way -> despawn/release -> stats -> signal state machine. Everything is
 * delta-time driven so behaviour is independent of frame rate. No React/three
 * imports live here; the renderer only reads `vehicles` and `snapshot()`.
 */

const STOPPED_SPEED = 0.3;
const DEFAULT_MAX_VEHICLES = 68;
const DEFAULT_SPAWN_INTERVAL = 2.75;
const STATS_INTERVAL = 0.25;
const EXIT_FULL_OCCUPANCY = 0.8;
/** EMA smoothing for arrival/departure rates (per stats interval). */
const RATE_ALPHA = 0.3;
/**
 * Probability that a given spawn is an emergency vehicle. Deliberately small:
 * at the ~0.4s spawn cadence, 0.008 is roughly one priority vehicle per minute
 * across the whole intersection — matching how rare sirens really are. The old
 * 0.04 (~one every 10s) let emergencies *cluster* on one axis and chain-preempt
 * it back-to-back, which reset the cross axis's starvation clock repeatedly and
 * pushed a starved movement past the fairness cap. Rare emergencies keep
 * preemption meaningful without defeating the fairness guarantee.
 */
const EMERGENCY_SPAWN_CHANCE = 0.008;
/** How far before the stop line an approaching emergency vehicle triggers preemption. */
const PREEMPT_TRIGGER_DISTANCE = 30;
const PLATE_SPACE = 100_000;
const INTERSECTION_NAME = "Nút giao Trần Hưng Đạo – 3 Tháng 2 – Mậu Thân";

export type ScenarioId = "DEFAULT" | "IMBALANCED" | "SPILLBACK" | "EMERGENCY" | "GRIDLOCK" | "RED_LIGHT";

export interface EngineOptions {
  rng?: () => number;
  maxVehicles?: number;
  spawnIntervalSeconds?: number;
}

export interface EngineSnapshot {
  phaseLabel: string;
  nextLabel: string;
  remainingMs: number;
  remainingSeconds: number;
  committed: boolean;
  manual: boolean;
  state: string;
  reason: string;
  signals: SignalMap;
  countdowns: CountdownMap;
  mainSignals: SignalMap;
  leftSignals: SignalMap;
  mainCountdowns: CountdownMap;
  leftCountdowns: CountdownMap;
  /** True while an emergency-vehicle preemption is active. */
  preempted: boolean;
  /** The phase preemption is driving toward (for the dashboard banner), or null. */
  preemptTarget: GreenPhase | null;
  /** Live AI decision breakdown for the debug panel (Task G, in-app half). */
  aiDebug: AiDebugSnapshot;
}

/** Per-phase demand breakdown for the AI debug panel / headless harness. */
export interface PhaseDemandRow {
  phase: GreenPhase;
  demand: number;
  /** True if this is the phase the controller would pick next right now. */
  chosen: boolean;
}

/**
 * AI decision snapshot (Task G). Exposes exactly what the controller is "seeing"
 * and "thinking" this tick — per-phase demand scores, the chosen next phase, the
 * human reason, the coarse traffic state, and the per-direction stats that feed
 * the scores. Consumed by both the live debug panel and the headless observer.
 */
export interface AiDebugSnapshot {
  state: string;
  reason: string;
  currentGreen: GreenPhase;
  chosenNext: GreenPhase;
  phaseDemands: PhaseDemandRow[];
  stats: StatsMap;
  preempted: boolean;
  preemptTarget: GreenPhase | null;
}

interface RateTracker {
  arrivals: number;
  departures: number;
  arrivalRate: number;
  departureRate: number;
}

export class SimulationEngine {
  readonly vehicles: Vehicle[] = [];
  private readonly conflicts = new ConflictRegistry();
  private readonly signal = new SignalController("NS_STRAIGHT_RIGHT");
  private readonly adaptive: AdaptiveController;
  private readonly rng: () => number;
  private readonly maxVehicles: number;
  private readonly spawnInterval: number;
  private authoritativeState: SignalState | null = null;
  private authoritativeMode = false;
  private reportSequence = 0;
  private readonly activePlates = new Set<string>();
  private readonly reusablePlates: string[] = [];
  private readonly reusablePlateSet = new Set<string>();
  private readonly blacklistedPlates = new Set<string>();
  private readonly pendingViolations: ViolationEvent[] = [];
  private nextPlateNumber = 0;
  private scenario: ScenarioId = "DEFAULT";
  private pendingEmergencySpawn = false;
  private pendingViolationSpawn = false;
  private paused = false;
  private speedMultiplier = 1;

  private spawnClock = 0;
  private statsClock = 0;
  private nextTrackId = 1;
  private stats: StatsMap;
  private readonly rates: Record<Direction, RateTracker>;
  /** Per-direction downstream (exit lane) occupancy, updated each stats pass. */
  private outboundOccupancy: Record<Direction, number>;

  constructor(options: EngineOptions = {}) {
    initRouteConflictZones();
    this.rng = options.rng ?? Math.random;
    this.maxVehicles = options.maxVehicles ?? DEFAULT_MAX_VEHICLES;
    this.spawnInterval = options.spawnIntervalSeconds ?? DEFAULT_SPAWN_INTERVAL;
    this.stats = emptyStatsMap();
    this.rates = {
      north: emptyRate(),
      south: emptyRate(),
      east: emptyRate(),
      west: emptyRate()
    };
    this.outboundOccupancy = { north: 0, south: 0, east: 0, west: 0 };
    this.adaptive = new AdaptiveController(this.stats);
  }

  // -- public controls -------------------------------------------------------

  setManual(manual: boolean): void {
    this.signal.setManual(manual);
  }

  requestNextPhase(): void {
    this.signal.requestNextPhase();
  }

  emergencyAllRed(): void {
    this.signal.emergencyAllRed();
  }

  clearEmergency(): void {
    this.signal.clearEmergency();
  }

  setScenario(scenario: ScenarioId): void {
    this.scenario = scenario;
    this.reset();
  }

  get scenarioId(): ScenarioId {
    return this.scenario;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setSpeedMultiplier(multiplier: number): void {
    this.speedMultiplier = Math.max(0.25, Math.min(4, multiplier));
  }

  get simulationSpeed(): number {
    return this.speedMultiplier;
  }

  triggerEmergency(): void {
    this.pendingEmergencySpawn = true;
  }

  triggerRedLightViolation(): void {
    this.pendingViolationSpawn = true;
  }

  drainViolations(): ViolationEvent[] {
    return this.pendingViolations.splice(0);
  }

  blacklistedPlateCount(): number {
    return this.blacklistedPlates.size;
  }

  reset(): void {
    for (const vehicle of this.vehicles) this.releasePlate(vehicle);
    this.vehicles.length = 0;
    this.conflicts.clear();
    this.spawnClock = 0;
    this.statsClock = 0;
    this.stats = emptyStatsMap();
    this.outboundOccupancy = { north: 0, south: 0, east: 0, west: 0 };
    this.pendingEmergencySpawn = this.scenario === "EMERGENCY";
    this.pendingViolationSpawn = this.scenario === "RED_LIGHT";
    for (const d of DIRECTIONS) this.rates[d] = emptyRate();
  }

  get activePlateCount(): number {
    return this.activePlates.size;
  }

  get reusablePlateCount(): number {
    return this.reusablePlateSet.size;
  }

  get manual(): boolean {
    return this.signal.manual;
  }

  applySignalState(state: SignalState | null): void {
    this.authoritativeMode = true;
    this.authoritativeState = state;
  }

  // -- main loop -------------------------------------------------------------

  /** Advance the whole world by `dt` seconds. */
  tick(dt: number): void {
    if (this.paused || dt <= 0) return;
    dt *= this.speedMultiplier;
    this.spawnClock += dt;
    this.statsClock += dt;

    const effectiveSpawnInterval = this.scenario === "GRIDLOCK" || this.scenario === "SPILLBACK"
      ? Math.min(this.spawnInterval, 0.35)
      : this.spawnInterval;
    if (this.spawnClock >= effectiveSpawnInterval) {
      this.spawnClock -= effectiveSpawnInterval;
      this.trySpawn();
    }

    this.advanceVehicles(dt);
    this.despawnAndRelease();

    if (this.statsClock >= STATS_INTERVAL) {
      this.recomputeStats(this.statsClock);
      this.statsClock = 0;
      this.adaptive.update(this.stats);
    }

    // Keep the local controller available for headless/unit tests only. Runtime
    // movement gating reads the backend state once one has been applied.
    if (!this.authoritativeMode) {
      this.updatePreemption();
      this.signal.tick(dt, {
        boxOccupied: this.conflicts.occupied,
        decideGreenDuration: (green: GreenPhase) => clampGreen(this.adaptive.decideGreenDuration(green)),
        chooseNextGreen: (current: GreenPhase) => this.adaptive.chooseNextGreen(current),
        starvationCut: (current: GreenPhase) => this.adaptive.starvationCut(current)
      });
    }
  }

  // -- spawning --------------------------------------------------------------

  private trySpawn(): void {
    if (this.vehicles.length >= this.maxVehicles) return;

    // Round-robin start direction, but skip approaches whose entry is selectively
    // throttled (downstream full). Selective throttling — never all four at once —
    // is what stops spawning from permanently stalling during a jam (was: global
    // blockEntry killed all spawns forever once GRIDLOCK latched).
    const start = this.nextTrackId % DIRECTIONS.length;
    let direction: Direction | null = null;
    for (let i = 0; i < DIRECTIONS.length; i += 1) {
      const cand = DIRECTIONS[(start + i) % DIRECTIONS.length];
      if (!this.adaptive.blockEntryFor(cand)) {
        direction = cand;
        break;
      }
    }
    if (!direction) return; // every approach throttled this tick (rare)

    const candidates = routesForDirection(direction);
    const route = candidates[Math.floor(this.rng() * candidates.length)];

    // Only spawn if the mouth of the approach is clear (no vehicle near progress 0).
    const clear = this.vehicles.every(
      (v) => v.route.entryLaneId !== route.entryLaneId || v.progress > v.length + v.minGap + 1
    );
    if (!clear) return;

    const emergency = this.pendingEmergencySpawn || this.scenario === "EMERGENCY" || this.rng() < EMERGENCY_SPAWN_CHANCE;
    const forceViolation = this.pendingViolationSpawn;
    this.pendingEmergencySpawn = false;
    this.pendingViolationSpawn = false;
    const cls = emergency ? pickEmergencyClass(this.rng) : pickVehicleClass(this.rng);
    const trackId = this.nextTrackId++;
    const licensePlate = this.allocatePlate();
    if (!licensePlate) return;
    this.rates[direction].arrivals += 1;
    const vehicle = createVehicle({
      id: `veh-${trackId}`,
      trackId,
      cls,
      route,
      confidence: 0.9 + this.rng() * 0.09,
      reactionTime: 0.9 + this.rng() * 0.5,
      emergency,
      licensePlate
    });
    vehicle.forceRedLightViolation = forceViolation;
    this.vehicles.push(vehicle);
  }

  private allocatePlate(): string | null {
    while (this.reusablePlates.length > 0) {
      const plate = this.reusablePlates.pop()!;
      this.reusablePlateSet.delete(plate);
      if (!this.blacklistedPlates.has(plate) && !this.activePlates.has(plate)) {
        this.activePlates.add(plate);
        return plate;
      }
    }
    for (let checked = 0; checked < PLATE_SPACE; checked += 1) {
      const plate = this.nextPlateNumber.toString().padStart(5, "0");
      this.nextPlateNumber = (this.nextPlateNumber + 1) % PLATE_SPACE;
      if (!this.activePlates.has(plate) && !this.blacklistedPlates.has(plate)) {
        this.activePlates.add(plate);
        return plate;
      }
    }
    return null;
  }

  private releasePlate(vehicle: Vehicle): void {
    const plate = vehicle.licensePlate;
    this.activePlates.delete(plate);
    if (vehicle.redLightViolation || this.blacklistedPlates.has(plate) || this.reusablePlateSet.has(plate)) return;
    this.reusablePlates.push(plate);
    this.reusablePlateSet.add(plate);
  }

  // -- emergency preemption --------------------------------------------------

  /**
   * Emergency-vehicle signal preemption (Spec Part 4+, user-chosen "signal
   * priority"). Find the nearest emergency vehicle that is still approaching the
   * stop line; steer the signal toward the green phase serving its movement. Once
   * no emergency vehicle is approaching (the current one has entered/cleared the
   * box), release the preemption so normal adaptive control resumes.
   */
  private updatePreemption(): void {
    let target: GreenPhase | null = null;
    let nearest = Number.POSITIVE_INFINITY;

    for (const v of this.vehicles) {
      if (!v.emergency) continue;
      // Only vehicles still short of the line and within trigger range matter;
      // once past the line they are already crossing under the granted green.
      const distToLine = v.route.stopProgress - v.progress;
      if (distToLine < 0 || distToLine > PREEMPT_TRIGGER_DISTANCE) continue;
      if (distToLine < nearest) {
        nearest = distToLine;
        target = phaseForMovement(v.route.direction, v.route.turn);
      }
    }

    if (target) this.signal.preemptFor(target);
    else if (this.signal.preempted) this.signal.clearPreempt();
  }

  // -- movement pipeline -----------------------------------------------------

  private advanceVehicles(dt: number): void {
    // Group vehicles by entry lane, ordered by progress (leader last-processed first).
    const byLane = new Map<string, Vehicle[]>();
    for (const v of this.vehicles) {
      const lane = byLane.get(v.route.entryLaneId);
      if (lane) lane.push(v);
      else byLane.set(v.route.entryLaneId, [v]);
    }

    for (const lane of byLane.values()) {
      // Sort by descending progress so each vehicle sees the one ahead as leader.
      lane.sort((a, b) => b.progress - a.progress);
      let leader: Vehicle | null = null;

      for (const vehicle of lane) {
        const previous = { x: vehicle.x, z: vehicle.z, progress: vehicle.progress };
        const colorBeforeMove = this.movementColor(vehicle.route.direction, vehicle.route.turn);
        const obstacle = this.obstacleFor(vehicle, leader);
        integrateVehicle(vehicle, dt, obstacle);
        if (
          !vehicle.redLightViolation &&
          !vehicle.emergency &&
          previous.progress <= vehicle.route.stopProgress &&
          vehicle.progress > vehicle.route.stopProgress &&
          colorBeforeMove !== "GREEN"
        ) {
          vehicle.redLightViolation = true;
          this.blacklistedPlates.add(vehicle.licensePlate);
          this.reusablePlateSet.delete(vehicle.licensePlate);
          this.pendingViolations.push({
            type: "violation_event",
            trackId: vehicle.trackId,
            licensePlate: vehicle.licensePlate,
            vehicleClass: vehicle.cls,
            direction: vehicle.route.direction,
            movement: vehicle.route.turn,
            violation: "RED_LIGHT",
            signal: colorBeforeMove,
            timestampMs: Date.now(),
            intersection: INTERSECTION_NAME,
            evidence: {
              laneId: vehicle.route.entryLaneId,
              speed: vehicle.speed,
              signal: colorBeforeMove
            }
          });
        }
        // Accumulate real queued time: a vehicle that is stopped and still short
        // of the stop line is waiting for green (feeds the starvation metric).
        if (vehicle.speed < STOPPED_SPEED && vehicle.progress <= vehicle.route.stopProgress + 0.5) {
          vehicle.waitTime += dt;
        }
        this.updateStatusAndConflicts(vehicle);
        updateWrongWay(vehicle, vehicle.x - previous.x, vehicle.z - previous.z);
        leader = vehicle;
      }
    }
  }

  /**
   * Determine the single most-constraining obstacle ahead of a vehicle:
   *   1. the leader in the same lane (rear bumper),
   *   2. the stop line (virtual obstacle) when the vehicle may not proceed,
   * whichever is closer wins (smaller progress edge).
   */
  private obstacleFor(
    vehicle: Vehicle,
    leader: Vehicle | null
  ): { progress: number; speed: number } | null {
    let edge = Number.POSITIVE_INFINITY;
    let speed = 0;

    if (leader) {
      // Leader's rear bumper edge = its front progress minus its body length.
      const rear = leader.progress - leader.length;
      if (rear < edge) {
        edge = rear;
        speed = leader.speed;
      }
    }

    // Virtual stop-line obstacle: place a wall at the stop line when the vehicle
    // must not cross (red/committed-yellow, unmet conflict reservation, full exit).
    if (!vehicle.forceRedLightViolation && !vehicle.hasReserved && this.mustStopAtLine(vehicle)) {
      // Wall just before the stop line, offset by body length so the bumper lands on it.
      const wall = vehicle.route.stopProgress;
      if (wall < edge) {
        edge = wall;
        speed = 0;
      }
    }

    if (!Number.isFinite(edge)) return null;
    return { progress: edge, speed };
  }

  private movementColor(direction: Direction, turn: Turn): "GREEN" | "YELLOW" | "RED" {
    if (!this.authoritativeMode) return this.signal.movementColor(direction, turn);
    const state = this.authoritativeState;
    if (!state || state.telemetryStale) return "RED";
    const phase = phaseForMovement(direction, turn);
    return state.phase === phase ? state.subPhase === "ALL_RED" ? "RED" : state.subPhase : "RED";
  }

  /** Should the vehicle hold at the stop line this tick? */
  private mustStopAtLine(vehicle: Vehicle): boolean {
    // Only relevant while still approaching the line.
    if (vehicle.progress > vehicle.route.stopProgress) return false;

    const color = this.movementColor(vehicle.route.direction, vehicle.route.turn);
    if (color === "RED") return true;
    if (color === "YELLOW") {
      // Yellow: stop unless too close to halt safely (can clear the line).
      const distToLine = vehicle.route.stopProgress - vehicle.progress;
      const brakingDist = (vehicle.speed * vehicle.speed) / (2 * vehicle.comfortBrake);
      return distToLine > brakingDist + 0.5;
    }

    // GREEN: may proceed only if the conflict box + downstream exit are clear.
    if (!this.canEnterBox(vehicle)) return true;
    return false;
  }

  /**
   * Conflict-box gate (Spec Part 3): a green vehicle near the line may enter only
   * if it can reserve all its zones AND its exit lane has room for its body.
   * Reservation happens here so it persists until the body clears the box.
   */
  private canEnterBox(vehicle: Vehicle): boolean {
    // Gate only when close to the line (about to commit into the box).
    const distToLine = vehicle.route.stopProgress - vehicle.progress;
    if (distToLine > vehicle.length + vehicle.minGap + 1.5) return true;

    const exitDir = exitDirectionOf(vehicle.route);
    if (this.outboundOccupancy[exitDir] >= EXIT_FULL_OCCUPANCY) return false;

    if (!this.conflicts.canReserve(vehicle.route.conflictZones, vehicle.id)) return false;

    this.conflicts.reserve(vehicle.route.conflictZones, vehicle.id);
    vehicle.hasReserved = true;
    vehicle.reservedZones = vehicle.route.conflictZones;
    return true;
  }

  /** Update per-vehicle status and free conflict zones the body has cleared. */
  private updateStatusAndConflicts(vehicle: Vehicle): void {
    if (vehicle.hasReserved) {
      const rearProgress = vehicle.progress - vehicle.length;
      const beforeLine = vehicle.progress <= vehicle.route.stopProgress;
      const color = this.movementColor(vehicle.route.direction, vehicle.route.turn);

      // Stale-reservation guard (deadlock fix): a vehicle that reserved on green
      // but is still behind the stop line when its movement has gone RED (its
      // phase ended before it could commit into the box) must hand the zones
      // back at once. Otherwise it holds shared centre zones across the phase
      // change and blocks the *next* phase against a physically empty box —
      // exactly the "inBox=0 but blockedGreen>0" freeze the harness caught.
      // Yellow keeps the reservation so an already-committed vehicle can clear.
      if (beforeLine && color === "RED") {
        this.conflicts.release(vehicle.reservedZones, vehicle.id);
        vehicle.hasReserved = false;
        vehicle.reservedZones = [];
      } else if (vehicle.progress > vehicle.route.stopProgress) {
        // All-or-nothing release (safety): hold every reserved zone until the
        // whole body has fully cleared the box, then release them together. An
        // earlier "progressive" variant freed each zone the body had individually
        // vacated — but that let a vehicle hand back the shared centre zone while
        // still physically crossing it, and an opposing left-turn immediately
        // reserved and entered it (two EW_LEFT turners colliding in z_1_1). Keep
        // the reservation whole so conflicting movements stay serialised through
        // the centre. The dedicated left-turn pockets, not progressive release,
        // are what actually broke the throughput deadlock.
        const stillInBox = vehicle.reservedZones.some((zone) =>
          this.bodyStillInZone(vehicle, zone, rearProgress)
        );
        if (!stillInBox) {
          this.conflicts.release(vehicle.reservedZones, vehicle.id);
          vehicle.reservedZones = [];
          vehicle.hasReserved = false;
        }
      }
    }

    if (vehicle.speed < STOPPED_SPEED && vehicle.progress <= vehicle.route.stopProgress + 0.5) {
      const color = this.movementColor(vehicle.route.direction, vehicle.route.turn);
      vehicle.status = color === "GREEN" ? "WAITING_CONFLICT" : "WAITING_SIGNAL";
    } else if (vehicle.progress > vehicle.route.stopProgress) {
      vehicle.status = "CLEARING";
      // Cleared the stop line: it is moving through, so its wait resets.
      vehicle.waitTime = 0;
    } else {
      vehicle.status = vehicle.speed < STOPPED_SPEED ? "FOLLOWING" : "DRIVING";
    }
  }

  /** Whether any sampled point of the vehicle body still falls inside `zone`. */
  private bodyStillInZone(vehicle: Vehicle, zone: string, rearProgress: number): boolean {
    const samples = 3;
    for (let i = 0; i <= samples; i += 1) {
      const p = rearProgress + (vehicle.length * i) / samples;
      if (p < 0) continue;
      const point = sampleAt(vehicle.route.path, p);
      if (zoneAt(point.x, point.z) === zone) return true;
    }
    return false;
  }

  // -- despawn ---------------------------------------------------------------

  private despawnAndRelease(): void {
    for (let i = this.vehicles.length - 1; i >= 0; i -= 1) {
      const vehicle = this.vehicles[i];
      if (vehicle.progress >= vehicle.route.path.length - 0.05) {
        this.conflicts.releaseAll(vehicle.id);
        this.rates[vehicle.route.direction].departures += 1;
        this.releasePlate(vehicle);
        this.vehicles.splice(i, 1);
      }
    }
  }

  // -- statistics ------------------------------------------------------------

  private recomputeStats(interval: number): void {
    const grouped: Record<Direction, Vehicle[]> = { north: [], south: [], east: [], west: [] };
    for (const v of this.vehicles) grouped[v.route.direction].push(v);

    // Outbound occupancy: fraction of each exit lane's length covered by bodies.
    const outLength: Record<Direction, number> = { north: 0, south: 0, east: 0, west: 0 };
    for (const v of this.vehicles) {
      if (v.progress > v.route.stopProgress) {
        outLength[exitDirectionOf(v.route)] += v.length;
      }
    }
    for (const d of DIRECTIONS) {
      this.outboundOccupancy[d] = Math.min(1, outLength[d] / APPROACH_LENGTH);
    }

    for (const d of DIRECTIONS) {
      const list = grouped[d];
      const queued = list.filter(
        (v) => v.speed < STOPPED_SPEED && v.progress <= v.route.stopProgress + 1
      );
      const speeds = list.map((v) => v.speed);
      const rate = this.rates[d];
      rate.arrivalRate = RATE_ALPHA * (rate.arrivals / interval) + (1 - RATE_ALPHA) * rate.arrivalRate;
      rate.departureRate =
        RATE_ALPHA * (rate.departures / interval) + (1 - RATE_ALPHA) * rate.departureRate;
      rate.arrivals = 0;
      rate.departures = 0;

      // Real waiting time (Task A): mean and max of queued vehicles' accumulated
      // stopped-time. Replaces the old faked `queued.length * 0.7` proxy so the
      // adaptive controller can detect true starvation and force-serve it.
      const waits = queued.map((v) => v.waitTime);
      const avgWaitingTime = waits.length ? waits.reduce((s, w) => s + w, 0) / waits.length : 0;
      const maxWaitingTime = waits.length ? Math.max(...waits) : 0;

      // Per movement-group stats (Task E lane split): left-turn pocket vs
      // through/right share one approach but are served by different phases, so
      // the controller needs their queue/wait/downstream tracked separately —
      // otherwise a starved left pocket stays invisible behind the whole-approach
      // average and never earns its own green (the 292s fairness miss).
      const leftDownstream = this.outboundOccupancy[leftExitOf(d)];
      const throughDownstream = this.outboundOccupancy[throughExitOf(d)];
      const left = movementStatsFor(
        queued.filter((v) => v.route.turn === "LEFT"),
        rate.arrivalRate,
        queued.length,
        leftDownstream
      );
      const through = movementStatsFor(
        queued.filter((v) => v.route.turn !== "LEFT"),
        rate.arrivalRate,
        queued.length,
        throughDownstream
      );

      const stats: DirectionStats = {
        vehicleCount: list.length,
        queueLength: queued.length,
        queuePcu: queued.reduce((s, v) => s + VEHICLE_CLASSES[v.cls].pcu, 0),
        medianSpeed: median(speeds),
        arrivalRate: rate.arrivalRate,
        departureRate: rate.departureRate,
        occupancy: Math.min(1, list.reduce((s, v) => s + v.length, 0) / APPROACH_LENGTH),
        avgWaitingTime,
        maxWaitingTime,
        // The through movement of direction d feeds the far exit; use its occupancy.
        downstreamOccupancy: throughDownstream,
        left,
        through
      };
      this.stats[d] = stats;
    }
  }

  // -- snapshots for the UI --------------------------------------------------

  /** Queue counts (kept for backward compatibility with the existing panel). */
  queueCounts(): QueueCounts {
    return {
      north: this.stats.north.queueLength,
      south: this.stats.south.queueLength,
      east: this.stats.east.queueLength,
      west: this.stats.west.queueLength
    };
  }

  trafficCounts(): DirectionTrafficCounts {
    return {
      north: { total: this.stats.north.vehicleCount, waiting: this.stats.north.queueLength },
      south: { total: this.stats.south.vehicleCount, waiting: this.stats.south.queueLength },
      east: { total: this.stats.east.vehicleCount, waiting: this.stats.east.queueLength },
      west: { total: this.stats.west.vehicleCount, waiting: this.stats.west.queueLength }
    };
  }

  trafficReport(): TrafficReport {
    const stats = Object.fromEntries(
      DIRECTIONS.map((direction) => {
        const value = this.stats[direction];
        return [direction, {
          total: value.vehicleCount,
          waiting: value.queueLength,
          queuePcu: value.queuePcu,
          medianSpeed: value.medianSpeed,
          arrivalRate: value.arrivalRate,
          departureRate: value.departureRate,
          occupancy: value.occupancy,
          left: value.left,
          through: value.through
        }];
      })
    ) as TrafficReport["stats"];
    let emergency: { phase: GreenPhase } | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const vehicle of this.vehicles) {
      if (!vehicle.emergency) continue;
      const distance = vehicle.route.stopProgress - vehicle.progress;
      if (distance >= 0 && distance <= PREEMPT_TRIGGER_DISTANCE && distance < nearest) {
        nearest = distance;
        emergency = { phase: phaseForMovement(vehicle.route.direction, vehicle.route.turn) };
      }
    }
    return {
      type: "traffic_report",
      sequence: this.reportSequence++,
      timestampMs: Date.now(),
      stats,
      boxOccupied: this.conflicts.occupied,
      emergency
    };
  }

  statsMap(): StatsMap {
    return this.stats;
  }

  perDirectionSignals(): SignalMap {
    return this.authoritativeMode ? this.authoritativeState?.signals ?? SAFE_SIGNALS : this.signal.perDirectionSignals();
  }

  snapshot(): EngineSnapshot {
    const backend = this.authoritativeState;
    if (this.authoritativeMode && backend) {
      return {
        phaseLabel: `${backend.phase}_${backend.subPhase}`,
        nextLabel: backend.plannedNext,
        remainingMs: backend.remainingMs,
        remainingSeconds: backend.remainingMs / 1000,
        committed: backend.committed,
        manual: backend.manual,
        state: backend.state,
        reason: backend.reason,
        signals: backend.telemetryStale ? SAFE_SIGNALS : backend.mainSignals,
        countdowns: backend.telemetryStale ? BLANK_COUNTDOWNS : backend.mainCountdowns,
        mainSignals: backend.telemetryStale ? SAFE_SIGNALS : backend.mainSignals,
        leftSignals: backend.telemetryStale ? SAFE_SIGNALS : backend.leftSignals,
        mainCountdowns: backend.telemetryStale ? BLANK_COUNTDOWNS : backend.mainCountdowns,
        leftCountdowns: backend.telemetryStale ? BLANK_COUNTDOWNS : backend.leftCountdowns,
        preempted: backend.preempted,
        preemptTarget: backend.preemptTarget,
        aiDebug: this.aiDebug()
      };
    }
    if (this.authoritativeMode) {
      return {
        phaseLabel: "ALL_RED",
        nextLabel: "NS_STRAIGHT_RIGHT",
        remainingMs: 0,
        remainingSeconds: 0,
        committed: false,
        manual: false,
        state: this.adaptive.trafficState,
        reason: "Đang chờ trạng thái điều khiển từ backend.",
        signals: SAFE_SIGNALS,
        countdowns: BLANK_COUNTDOWNS,
        mainSignals: SAFE_SIGNALS,
        leftSignals: SAFE_SIGNALS,
        mainCountdowns: BLANK_COUNTDOWNS,
        leftCountdowns: BLANK_COUNTDOWNS,
        preempted: false,
        preemptTarget: null,
        aiDebug: this.aiDebug()
      };
    }
    return {
      phaseLabel: this.signal.label,
      nextLabel: this.signal.nextLabel,
      remainingMs: this.signal.remainingMs,
      remainingSeconds: this.signal.remainingSeconds,
      committed: this.signal.committed,
      manual: this.signal.manual,
      state: this.adaptive.trafficState,
      reason: this.adaptive.reason,
      signals: this.signal.perDirectionSignals(),
      countdowns: this.signal.perDirectionCountdown(),
      mainSignals: this.signal.perDirectionSignals(),
      leftSignals: this.signal.leftSignals(),
      mainCountdowns: this.signal.perDirectionCountdown(),
      leftCountdowns: this.signal.leftCountdown(),
      preempted: this.signal.preempted,
      preemptTarget: this.signal.preemptTarget,
      aiDebug: this.aiDebug()
    };
  }

  /**
   * AI decision snapshot (Task G) for the live debug panel and headless observer.
   * Pure/read-only: `phaseDemand` is a pure function of the latest stats and we
   * reuse the controller's already-decided next phase (`signal.plannedNext`)
   * rather than re-invoking `chooseNextGreen`, so calling this never perturbs the
   * controller's recovery cursor or reason string.
   */
  aiDebug(): AiDebugSnapshot {
    const chosenNext = this.signal.plannedNext;
    const phaseDemands: PhaseDemandRow[] = GREEN_PHASES.map((phase) => ({
      phase,
      demand: phaseDemand(phase, this.stats),
      chosen: phase === chosenNext
    }));
    return {
      state: this.adaptive.trafficState,
      reason: this.adaptive.reason,
      currentGreen: this.signal.green,
      chosenNext,
      phaseDemands,
      stats: this.stats,
      preempted: this.signal.preempted,
      preemptTarget: this.signal.preemptTarget
    };
  }
}

// -- helpers -----------------------------------------------------------------

function emptyRate(): RateTracker {
  return { arrivals: 0, departures: 0, arrivalRate: 0, departureRate: 0 };
}

function emptyStatsMap(): StatsMap {
  return {
    north: { ...EMPTY_DIRECTION_STATS },
    south: { ...EMPTY_DIRECTION_STATS },
    east: { ...EMPTY_DIRECTION_STATS },
    west: { ...EMPTY_DIRECTION_STATS }
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** The exit heading a route departs on (parsed from its exit lane id). */
function exitDirectionOf(route: Route): Direction {
  return route.exitLaneId.split("_")[0] as Direction;
}

/** The exit heading a direction's STRAIGHT movement feeds (its downstream). */
function throughExitOf(direction: Direction): Direction {
  return direction;
}

/**
 * The exit heading a direction's LEFT turn feeds (its downstream), per the
 * right-hand-traffic turn table: north->west, south->east, east->north,
 * west->south. Used so the left pocket's demand is discounted against the exit
 * *it* actually spills into, not the straight-ahead exit.
 */
function leftExitOf(direction: Direction): Direction {
  switch (direction) {
    case "north":
      return "west";
    case "south":
      return "east";
    case "east":
      return "north";
    case "west":
      return "south";
  }
}

/**
 * Build a {@link MovementStats} for one movement group (left pocket or
 * through/right) from its queued vehicles. Queue load and waits are measured
 * directly from the group's own vehicles; the approach's arrival rate is split
 * proportionally by this group's share of the total queue (we don't track
 * arrivals per turn), and `downstreamOccupancy` is the exit this group feeds.
 */
function movementStatsFor(
  queuedGroup: Vehicle[],
  approachArrivalRate: number,
  totalQueued: number,
  downstreamOccupancy: number
): MovementStats {
  const queueLength = queuedGroup.length;
  const queuePcu = queuedGroup.reduce((s, v) => s + VEHICLE_CLASSES[v.cls].pcu, 0);
  const waits = queuedGroup.map((v) => v.waitTime);
  const avgWaitingTime = waits.length ? waits.reduce((s, w) => s + w, 0) / waits.length : 0;
  const maxWaitingTime = waits.length ? Math.max(...waits) : 0;
  const share = totalQueued > 0 ? queueLength / totalQueued : 0;
  return {
    queueLength,
    queuePcu,
    arrivalRate: approachArrivalRate * share,
    avgWaitingTime,
    maxWaitingTime,
    downstreamOccupancy
  };
}

/** The green phase that serves a given (direction, turn) movement. */
function phaseForMovement(direction: Direction, turn: Turn): GreenPhase {
  const isNS = direction === "north" || direction === "south";
  if (turn === "LEFT") return isNS ? "NS_LEFT" : "EW_LEFT";
  return isNS ? "NS_STRAIGHT_RIGHT" : "EW_STRAIGHT_RIGHT";
}
