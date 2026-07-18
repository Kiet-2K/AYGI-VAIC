import type { GreenPhase } from "@/lib/sim/signalController";
import { GREEN_PHASES, MIN_GREEN_SECONDS, clampGreen } from "@/lib/sim/signalController";
import { DIRECTIONS, type Direction } from "@/types/traffic";

/**
 * Adaptive traffic controller (Spec Parts 6 & 11).
 *
 * Consumes rich per-direction statistics (not just a vehicle count) and turns
 * them into a PCU-weighted demand score per green phase, a coarse traffic-state
 * classification (FREE / BUSY / CONGESTED / GRIDLOCK) and a gridlock-recovery
 * plan. It never mutates signals directly; it only answers the two questions
 * the SignalController asks: how long should this green be, and which green
 * should come next. All phase changes still flow through min-green/yellow/all-red.
 */

export type TrafficState = "FREE" | "BUSY" | "CONGESTED" | "GRIDLOCK";

/** The two movement groups an approach splits into (matches the phase pairs). */
export type MovementGroup = "left" | "through";

/**
 * Per movement-group load (Task E lane split). Because LEFT turns now queue in a
 * dedicated pocket lane served by a different phase than STRAIGHT/RIGHT, demand
 * and starvation must be tracked per group — otherwise a starved left-turn queue
 * is invisible behind a whole-direction average and never gets its own green.
 */
export interface MovementStats {
  queueLength: number;
  queuePcu: number;
  arrivalRate: number;
  avgWaitingTime: number;
  maxWaitingTime: number;
  /** Occupancy of the exit this movement feeds [0,1]. */
  downstreamOccupancy: number;
}

export const EMPTY_MOVEMENT_STATS: MovementStats = {
  queueLength: 0,
  queuePcu: 0,
  arrivalRate: 0,
  avgWaitingTime: 0,
  maxWaitingTime: 0,
  downstreamOccupancy: 0
};

export interface DirectionStats {
  /** Vehicles currently on the approach. */
  vehicleCount: number;
  /** Number of vehicles stopped/queued at the stop line. */
  queueLength: number;
  /** PCU-weighted queue load. */
  queuePcu: number;
  /** Median speed of approach vehicles (units/s). */
  medianSpeed: number;
  /** Vehicles arriving per second (rolling). */
  arrivalRate: number;
  /** Vehicles departing across the stop line per second (rolling). */
  departureRate: number;
  /** Fraction of the approach length occupied by vehicles [0,1]. */
  occupancy: number;
  /** Average waiting time of queued vehicles (s). */
  avgWaitingTime: number;
  /** Longest single-vehicle wait on this approach (s) — drives starvation guarantee. */
  maxWaitingTime: number;
  /** Occupancy of the exit that this approach's straight movement feeds [0,1]. */
  downstreamOccupancy: number;
  /** Per-group breakdown for turn-aware phase scoring (left pocket vs through/right). */
  left: MovementStats;
  through: MovementStats;
}

export const EMPTY_DIRECTION_STATS: DirectionStats = {
  vehicleCount: 0,
  queueLength: 0,
  queuePcu: 0,
  medianSpeed: 0,
  arrivalRate: 0,
  departureRate: 0,
  occupancy: 0,
  avgWaitingTime: 0,
  maxWaitingTime: 0,
  downstreamOccupancy: 0,
  left: { ...EMPTY_MOVEMENT_STATS },
  through: { ...EMPTY_MOVEMENT_STATS }
};

export type StatsMap = Record<Direction, DirectionStats>;

/** The movement group a green phase serves. */
export function groupOfPhase(green: GreenPhase): MovementGroup {
  return green === "NS_LEFT" || green === "EW_LEFT" ? "left" : "through";
}

/** Directions served by each green phase (for scoring). */
const PHASE_DIRECTIONS: Record<GreenPhase, Direction[]> = {
  NS_LEFT: ["north", "south"],
  NS_STRAIGHT_RIGHT: ["north", "south"],
  EW_LEFT: ["east", "west"],
  EW_STRAIGHT_RIGHT: ["east", "west"]
};

const DOWNSTREAM_FULL = 0.85;
const GRIDLOCK_SPEED = 0.35;
const CONGESTED_SPEED = 1.4;
/**
 * Hard fairness cap: once any movement has waited this long it is force-served
 * next regardless of the other approaches' instantaneous queue size. This is the
 * direct fix for the "East-West stuck permanently red" bug — a starved approach
 * can now always reclaim green even when the cross street keeps a bigger queue.
 */
export const MAX_WAIT_CAP_SECONDS = 45;
/** Demand bonus applied to a starved movement so it outscores any fresh queue. */
const STARVATION_BONUS = 1000;

/**
 * Movement-group demand: PCU-weighted queue dominates, boosted by waiting time
 * (starvation avoidance) and dampened when the downstream exit is filling. The
 * wait term grows non-linearly (wait^1.5) so a group that has been starved for a
 * while eventually outscores a fresh but larger cross-queue. This is the core
 * scoring unit now that each phase serves one group (left pocket OR through/right).
 */
export function movementDemand(m: MovementStats): number {
  const queueTerm = m.queuePcu * 1.0;
  // Non-linear starvation pressure: doubling the wait more than doubles urgency.
  const waitTerm = Math.pow(Math.max(0, m.avgWaitingTime), 1.5) * 0.12;
  const arrivalTerm = m.arrivalRate * 1.5;
  // If the exit is nearly full, serving this movement won't help — discount it.
  const downstreamPenalty = m.downstreamOccupancy >= DOWNSTREAM_FULL ? 0.15 : 1.0;
  const base = (queueTerm + waitTerm + arrivalTerm) * downstreamPenalty;
  // Starvation override: a movement past the wait cap gets a bonus that survives
  // even the downstream-full discount, so it can never be starved indefinitely.
  const starvation = m.maxWaitingTime >= MAX_WAIT_CAP_SECONDS ? STARVATION_BONUS : 0;
  return base + starvation;
}

/**
 * Whole-approach demand (legacy helper): scores a direction from its aggregate
 * top-level fields, ignoring the left/through split. Kept for callers/tests that
 * reason about an approach as a whole; live phase scoring uses {@link phaseDemand}
 * which is group-aware.
 */
export function directionDemand(stats: DirectionStats): number {
  const queueTerm = stats.queuePcu * 1.0;
  const waitTerm = Math.pow(Math.max(0, stats.avgWaitingTime), 1.5) * 0.12;
  const arrivalTerm = stats.arrivalRate * 1.5;
  const downstreamPenalty = stats.downstreamOccupancy >= DOWNSTREAM_FULL ? 0.15 : 1.0;
  const base = (queueTerm + waitTerm + arrivalTerm) * downstreamPenalty;
  const starvation = stats.maxWaitingTime >= MAX_WAIT_CAP_SECONDS ? STARVATION_BONUS : 0;
  return base + starvation;
}

/**
 * Demand score for a green phase = sum over its served directions of the demand
 * of the *movement group* that phase serves. A left phase reads each approach's
 * `left` pocket, a through phase reads each approach's `through` group — so a
 * starved left queue is no longer hidden behind a whole-direction average.
 */
export function phaseDemand(green: GreenPhase, stats: StatsMap): number {
  const group = groupOfPhase(green);
  return PHASE_DIRECTIONS[green].reduce((sum, dir) => sum + movementDemand(stats[dir][group]), 0);
}

/** Classify overall intersection state from the aggregate stats. */
export function classifyState(stats: StatsMap): TrafficState {
  const dirs = DIRECTIONS.map((d) => stats[d]);
  const totalQueuePcu = dirs.reduce((s, d) => s + d.queuePcu, 0);
  const totalVehicles = dirs.reduce((s, d) => s + d.vehicleCount, 0);
  const queuedVehicles = dirs.reduce((s, d) => s + d.queueLength, 0);
  const totalDeparture = dirs.reduce((s, d) => s + d.departureRate, 0);
  const movers = dirs.filter((d) => d.vehicleCount > 0);
  const avgSpeed = movers.length
    ? movers.reduce((s, d) => s + d.medianSpeed, 0) / movers.length
    : Number.POSITIVE_INFINITY;

  // GRIDLOCK: lots of queued load, almost no movement, and nothing is departing.
  if (totalQueuePcu > 10 && avgSpeed < GRIDLOCK_SPEED && totalDeparture < 0.3) {
    return "GRIDLOCK";
  }
  // CONGESTED: heavy queues and low speed but still some flow.
  if (totalQueuePcu > 7 && avgSpeed < CONGESTED_SPEED) {
    return "CONGESTED";
  }
  // BUSY: meaningful traffic that is still flowing.
  if (totalVehicles > 6 || queuedVehicles > 3) {
    return "BUSY";
  }
  return "FREE";
}

export interface PhaseDecision {
  next: GreenPhase;
  duration: number;
  /** Human-readable justification shown on the dashboard (Spec Part 10). */
  reason: string;
  state: TrafficState;
}

/**
 * Adaptive controller. Stateless w.r.t. the signal machine except for a small
 * gridlock-recovery cursor, so it can be unit-tested by feeding stats directly.
 */
export class AdaptiveController {
  private latest: StatsMap;
  private state: TrafficState = "FREE";
  private lastReason = "Khởi động: chu kỳ mặc định.";
  /** Rotation cursor used to sequence escape phases during gridlock recovery. */
  private recoveryCursor = 0;

  constructor(stats: StatsMap) {
    this.latest = stats;
  }

  update(stats: StatsMap): void {
    this.latest = stats;
    this.state = classifyState(stats);
  }

  get trafficState(): TrafficState {
    return this.state;
  }

  get reason(): string {
    return this.lastReason;
  }

  /**
   * Legacy global flag (kept for callers/tests): true only while gridlocked.
   * Prefer {@link blockEntryFor} — global blocking is what caused the old
   * "spawning dies forever" bug, so the engine now throttles selectively.
   */
  get blockEntry(): boolean {
    return this.state === "GRIDLOCK";
  }

  /**
   * Selective entry throttle (Spec Part 11, revised). Only block a specific
   * approach when its downstream exit is full — admitting more cars there would
   * just deepen the jam. Approaches with clear downstream keep spawning so the
   * intersection can actually drain. Crucially this never blocks all four at
   * once, so vehicle spawning can never permanently stall.
   */
  blockEntryFor(direction: Direction): boolean {
    if (this.state !== "GRIDLOCK" && this.state !== "CONGESTED") return false;
    // Find the emptiest downstream among all approaches; always leave it open.
    let clearestOcc = Infinity;
    for (const d of DIRECTIONS) {
      const occ = this.latest[d].downstreamOccupancy;
      if (occ < clearestOcc) clearestOcc = occ;
    }
    const occ = this.latest[direction].downstreamOccupancy;
    // Keep the single clearest approach open even if it is technically "full".
    if (occ <= clearestOcc + 1e-6) return false;
    return occ >= DOWNSTREAM_FULL;
  }

  /** Green duration for a phase: min-green + a PCU-scaled increment, clamped. */
  decideGreenDuration(green: GreenPhase): number {
    const demand = phaseDemand(green, this.latest);
    return clampGreen(MIN_GREEN_SECONDS + Math.round(demand * 1.6));
  }

  /**
   * Starvation early-cut (fairness fix): the phase that should force-preempt the
   * *currently running* green because one of its movement groups has waited past
   * the cap. Returns null when nothing is starving or the starved phase is already
   * the running one. `chooseNextGreen` only decides which phase comes *next*, so
   * without this a starved movement still waits out the full running green (up to
   * MAX_GREEN) plus the yellow/all-red transition before relief lands — that gap
   * is what let north/LEFT reach ~150s. The engine calls this each tick and, once
   * min-green is satisfied, ends the current green early to switch toward it.
   */
  starvationCut(current: GreenPhase): GreenPhase | null {
    // Scan only *other* phases. A green-but-downstream-blocked movement keeps
    // accumulating wait without draining, so it is frequently the global worst
    // waiter — but it is already being served, so cutting toward it is pointless
    // and (worse) masks a genuinely-starved RED movement in another phase. By
    // excluding the current phase we guarantee the cut fires for the starved
    // movement that actually needs relief (the north/LEFT ~150s case).
    return this.mostStarvedPhase(current);
  }

  /**
   * Choose the next green. Under gridlock we rotate deterministically toward the
   * movement with the clearest downstream (an "escape phase"); otherwise we pick
   * the highest-demand phase that isn't downstream-blocked, avoiding starvation.
   */
  chooseNextGreen(current: GreenPhase): GreenPhase {
    // Fairness override (highest priority): if any movement has starved past the
    // wait cap, serve its phase next no matter what — even during gridlock. This
    // is what guarantees East-West can never be pinned red forever.
    const starved = this.mostStarvedPhase(current);
    if (starved) {
      this.lastReason = `Chống đói: ${describePhase(starved)} đã chờ quá ${MAX_WAIT_CAP_SECONDS}s, ưu tiên mở.`;
      return starved;
    }

    if (this.state === "GRIDLOCK") {
      return this.chooseEscapePhase(current);
    }

    let best: GreenPhase = current;
    let bestScore = -Infinity;
    let bestReason = this.lastReason;

    for (const phase of GREEN_PHASES) {
      // Don't reopen the exact phase we're leaving unless nothing else has demand.
      const demand = phaseDemand(phase, this.latest);
      const downstreamClear = this.phaseDownstreamClear(phase);
      // Downstream-full phases get a heavy penalty (Spec Part 6: no green if exit full).
      const score = demand + (phase === current ? -0.5 : 0) + (downstreamClear ? 0 : -100);
      if (score > bestScore) {
        bestScore = score;
        best = phase;
        bestReason = downstreamClear
          ? `Ưu tiên ${describePhase(phase)} (điểm nhu cầu PCU ${demand.toFixed(1)}).`
          : `${describePhase(phase)} bị chặn do đường ra đầy; chọn hướng khác.`;
      }
    }

    // If every phase is downstream-blocked, hold a short cycle on lowest occupancy.
    if (bestScore <= -50) {
      best = this.chooseEscapePhase(current);
      bestReason = `Mọi hướng có đường ra đầy; mở pha thoát ${describePhase(best)}.`;
    }

    this.lastReason = bestReason;
    return best;
  }

  /** Whether a phase's served directions have room downstream. */
  private phaseDownstreamClear(green: GreenPhase): boolean {
    return PHASE_DIRECTIONS[green].some((dir) => this.latest[dir].downstreamOccupancy < DOWNSTREAM_FULL);
  }

  /**
   * Find the phase serving the most-starved *movement group*, if any group has
   * exceeded the wait cap. Returns null when nothing is starving.
   *
   * Turn-aware (Task E lane split): because LEFT and STRAIGHT/RIGHT queue in
   * separate lanes served by different phases, we scan each direction's `left`
   * and `through` groups independently and open the phase that serves the group
   * with the single longest wait. The old version keyed only on whole-direction
   * wait and always defaulted to STRAIGHT_RIGHT, so a starved left-turn pocket
   * (e.g. north/LEFT) was never actually served — the 292s peak the harness
   * caught. Now the starved group's own phase is force-served.
   */
  private mostStarvedPhase(current: GreenPhase): GreenPhase | null {
    let worstWait = MAX_WAIT_CAP_SECONDS;
    let bestPhase: GreenPhase | null = null;
    for (const phase of GREEN_PHASES) {
      // Skip the phase we're already serving: its movement is (or should be)
      // discharging, and if it happens to be downstream-blocked its wait climbs
      // without draining — counting it here would let it perpetually mask a
      // starved RED movement that genuinely needs the next green.
      if (phase === current) continue;
      const group = groupOfPhase(phase);
      for (const dir of PHASE_DIRECTIONS[phase]) {
        const wait = this.latest[dir][group].maxWaitingTime;
        if (wait > worstWait) {
          worstWait = wait;
          bestPhase = phase;
        }
      }
    }
    return bestPhase;
  }

  /**
   * Gridlock recovery (Spec Part 11): rotate through green phases, preferring
   * the one whose downstream exits are emptiest so vehicles can actually escape.
   */
  private chooseEscapePhase(current: GreenPhase): GreenPhase {
    let best = GREEN_PHASES[this.recoveryCursor % GREEN_PHASES.length];
    let bestOccupancy = Infinity;
    for (const phase of GREEN_PHASES) {
      if (phase === current) continue;
      const occ = PHASE_DIRECTIONS[phase].reduce(
        (s, dir) => s + this.latest[dir].downstreamOccupancy,
        0
      );
      if (occ < bestOccupancy) {
        bestOccupancy = occ;
        best = phase;
      }
    }
    this.recoveryCursor += 1;
    this.lastReason = `GRIDLOCK: chặn xe vào, mở pha thoát ${describePhase(best)} (đường ra thoáng nhất).`;
    return best;
  }

  /** Full decision snapshot for the dashboard. */
  decision(current: GreenPhase): PhaseDecision {
    const next = this.chooseNextGreen(current);
    return {
      next,
      duration: this.decideGreenDuration(next),
      reason: this.lastReason,
      state: this.state
    };
  }
}

function describePhase(green: GreenPhase): string {
  switch (green) {
    case "NS_LEFT":
      return "Bắc-Nam rẽ trái";
    case "NS_STRAIGHT_RIGHT":
      return "Bắc-Nam thẳng/phải";
    case "EW_LEFT":
      return "Đông-Tây rẽ trái";
    case "EW_STRAIGHT_RIGHT":
      return "Đông-Tây thẳng/phải";
  }
}
