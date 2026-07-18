import type { Turn } from "@/lib/sim/roadGraph";
import { DIRECTIONS, type CountdownMap, type Direction, type DirectionCountdown, type SignalColor, type SignalMap } from "@/types/traffic";

/**
 * Traffic-light state machine (Spec Parts 4 & 5).
 *
 * A single monotonic internal clock drives everything, so the UI countdown and
 * the controller share one time source (fixes the old backend/UI desync). The
 * machine cycles: GREEN -> YELLOW -> ALL_RED -> (next) GREEN. Left turns are
 * protected: the four green phases separate NS/EW and left/through-right so
 * conflicting movements never run together.
 *
 * Committed phase (Part 5): once a green has <= COMMIT_SECONDS remaining it is
 * locked — its duration can neither extend nor shrink and the countdown never
 * jumps. During that window the adaptive layer may only *pick the next* phase.
 * ALL_RED is extended (up to MAX_ALL_RED) while the conflict box is still
 * occupied, and the next green opens only once the box is safe.
 */

export type GreenPhase = "NS_LEFT" | "NS_STRAIGHT_RIGHT" | "EW_LEFT" | "EW_STRAIGHT_RIGHT";
export type SubPhase = "GREEN" | "YELLOW" | "ALL_RED";

export const MIN_GREEN_SECONDS = 8;
export const MAX_GREEN_SECONDS = 32;
export const YELLOW_SECONDS = 3;
export const BASE_ALL_RED_SECONDS = 1;
export const MAX_ALL_RED_SECONDS = 3;
export const COMMIT_SECONDS = 8;
export const COUNTDOWN_SECONDS = 3;

export const GREEN_PHASES: GreenPhase[] = ["NS_LEFT", "NS_STRAIGHT_RIGHT", "EW_LEFT", "EW_STRAIGHT_RIGHT"];

/** Default safe rotation used when no adaptive choice is supplied. */
const DEFAULT_NEXT: Record<GreenPhase, GreenPhase> = {
  NS_LEFT: "NS_STRAIGHT_RIGHT",
  NS_STRAIGHT_RIGHT: "EW_LEFT",
  EW_LEFT: "EW_STRAIGHT_RIGHT",
  EW_STRAIGHT_RIGHT: "NS_LEFT"
};

/** Human-readable phase label including sub-phase, for the dashboard. */
export function phaseLabel(green: GreenPhase, sub: SubPhase): string {
  if (sub === "ALL_RED") return "ALL_RED";
  const base =
    green === "NS_LEFT"
      ? "NORTH_SOUTH_LEFT"
      : green === "NS_STRAIGHT_RIGHT"
        ? "NORTH_SOUTH_STRAIGHT_RIGHT"
        : green === "EW_LEFT"
          ? "EAST_WEST_LEFT"
          : "EAST_WEST_STRAIGHT_RIGHT";
  return `${base}_${sub}`;
}

/** The two approach directions a given green phase serves. */
export function phaseDirections(green: GreenPhase): Direction[] {
  return green === "NS_LEFT" || green === "NS_STRAIGHT_RIGHT"
    ? ["north", "south"]
    : ["east", "west"];
}

/** Which (direction, turn) movements a given green phase permits. */
export function movementAllowed(green: GreenPhase, direction: Direction, turn: Turn): boolean {
  switch (green) {
    case "NS_LEFT":
      return (direction === "north" || direction === "south") && turn === "LEFT";
    case "NS_STRAIGHT_RIGHT":
      return (direction === "north" || direction === "south") && (turn === "STRAIGHT" || turn === "RIGHT");
    case "EW_LEFT":
      return (direction === "east" || direction === "west") && turn === "LEFT";
    case "EW_STRAIGHT_RIGHT":
      return (direction === "east" || direction === "west") && (turn === "STRAIGHT" || turn === "RIGHT");
  }
}

export interface TickContext {
  /** True while any conflict zone is still reserved (box not clear). */
  boxOccupied: boolean;
  /** Desired green length for a phase (adaptive); clamped to [min,max] here. */
  decideGreenDuration: (green: GreenPhase) => number;
  /** Choose the next green phase (adaptive / gridlock recovery). */
  chooseNextGreen: (current: GreenPhase) => GreenPhase;
  /**
   * The phase that should force-end the current green because one of its
   * movements has starved past the fairness cap, or null. Used to cut a running
   * green short (after min-green) so a starved movement doesn't have to wait out
   * the full green + transition before it is served.
   */
  starvationCut?: (current: GreenPhase) => GreenPhase | null;
}

export class SignalController {
  private clock = 0;
  private phaseStartedAt = 0;
  green: GreenPhase = "NS_STRAIGHT_RIGHT";
  sub: SubPhase = "GREEN";
  /** Total planned length of the current sub-phase (seconds). */
  private plannedDuration = MIN_GREEN_SECONDS;
  /** Next green chosen during the commit window (shown as "next phase"). */
  plannedNext: GreenPhase = "EW_LEFT";
  manual = false;
  /** Set true by REQUEST NEXT PHASE; honoured at the next safe boundary. */
  private earlyRequest = false;
  /** Set by EMERGENCY ALL RED; holds all-red until cleared. */
  private emergencyHold = false;
  /**
   * Emergency preemption target (Spec Part 4+): the green phase an approaching
   * priority vehicle needs. While set, the machine drives toward this phase via
   * the normal yellow/all-red safety transition, then holds it green (no early
   * cut) until the vehicle clears and {@link clearPreempt} is called.
   */
  private preemptPhase: GreenPhase | null = null;

  constructor(initial: GreenPhase = "NS_STRAIGHT_RIGHT") {
    this.green = initial;
    this.plannedNext = DEFAULT_NEXT[initial];
  }

  get elapsed(): number {
    return this.clock - this.phaseStartedAt;
  }

  get remainingSeconds(): number {
    return Math.max(0, this.plannedDuration - this.elapsed);
  }

  get remainingMs(): number {
    return Math.ceil(this.remainingSeconds * 1000);
  }

  /**
   * A green is committed once it is within the final COMMIT_SECONDS: its duration
   * can no longer extend/shrink and only the *next* phase may still be chosen.
   * This is purely the timing-window meaning (it bounds `remainingSeconds`), so
   * preemption is deliberately NOT folded in here — a preempted green is protected
   * from early-cutting by the separate `preemptHolds` guard in the GREEN tick, and
   * conflating the two would let `committed` report true with a full green still
   * on the clock (breaking the "committed ⇒ ≤ COMMIT_SECONDS remaining" invariant
   * the UI countdown and tests rely on).
   */
  get committed(): boolean {
    return this.sub === "GREEN" && this.remainingSeconds <= COMMIT_SECONDS;
  }

  /** True while an emergency-vehicle preemption is active. */
  get preempted(): boolean {
    return this.preemptPhase !== null;
  }

  /** The phase preemption is driving toward, or null. */
  get preemptTarget(): GreenPhase | null {
    return this.preemptPhase;
  }

  get label(): string {
    return phaseLabel(this.green, this.sub);
  }

  get nextLabel(): string {
    return `${this.plannedNext}_GREEN`;
  }

  private enter(sub: SubPhase, duration: number): void {
    this.sub = sub;
    this.plannedDuration = duration;
    this.phaseStartedAt = this.clock;
  }

  requestNextPhase(): void {
    this.earlyRequest = true;
  }

  emergencyAllRed(): void {
    this.emergencyHold = true;
    // Drop straight into ALL_RED; safety over smoothness in an emergency.
    this.enter("ALL_RED", MAX_ALL_RED_SECONDS);
  }

  clearEmergency(): void {
    this.emergencyHold = false;
  }

  /**
   * Request emergency preemption toward the phase that serves an approaching
   * priority vehicle. Idempotent: repeated calls with the same phase are cheap.
   * The transition itself still runs through yellow/all-red inside tick(), so we
   * never flip conflicting movements to green instantaneously.
   */
  preemptFor(phase: GreenPhase): void {
    this.preemptPhase = phase;
  }

  /** Clear preemption once the emergency vehicle has cleared the box. */
  clearPreempt(): void {
    this.preemptPhase = null;
  }

  setManual(manual: boolean): void {
    this.manual = manual;
  }

  /** Colour for a specific movement (direction + turn). */
  movementColor(direction: Direction, turn: Turn): SignalColor {
    if (this.sub === "ALL_RED") return "RED";
    if (!movementAllowed(this.green, direction, turn)) return "RED";
    return this.sub === "GREEN" ? "GREEN" : "YELLOW";
  }

  perDirectionSignals(): SignalMap {
    return this.movementSignals(false);
  }

  leftSignals(): SignalMap {
    return this.movementSignals(true);
  }

  private movementSignals(left: boolean): SignalMap {
    const turn: Turn = left ? "LEFT" : "STRAIGHT";
    return {
      north: this.movementColor("north", turn),
      south: this.movementColor("south", turn),
      east: this.movementColor("east", turn),
      west: this.movementColor("west", turn)
    };
  }

  perDirectionCountdown(): CountdownMap {
    return this.movementCountdown(false);
  }

  leftCountdown(): CountdownMap {
    return this.movementCountdown(true);
  }

  private movementCountdown(left: boolean): CountdownMap {
    const colors = this.movementSignals(left);
    const nextDirs = phaseDirections(this.plannedNext);
    const nextIsLeft = this.plannedNext === "NS_LEFT" || this.plannedNext === "EW_LEFT";
    const revealNext = nextIsLeft === left && (this.committed || this.sub === "ALL_RED");

    const forDir = (d: Direction): DirectionCountdown => {
      const color = colors[d];
      if (color === "YELLOW") {
        return { seconds: this.remainingSeconds, visible: true, color };
      }
      if (color === "GREEN") {
        return {
          seconds: this.remainingSeconds <= COUNTDOWN_SECONDS ? this.remainingSeconds : 0,
          visible: this.remainingSeconds <= COUNTDOWN_SECONDS,
          color
        };
      }
      if (revealNext && nextDirs.includes(d) && this.sub === "ALL_RED" && this.remainingSeconds <= COUNTDOWN_SECONDS) {
        return { seconds: this.remainingSeconds, visible: true, color: "RED" };
      }
      return { seconds: 0, visible: false, color: "RED" };
    };

    return {
      north: forDir("north"),
      south: forDir("south"),
      east: forDir("east"),
      west: forDir("west")
    };
  }

  /** Advance the machine by dt seconds. Returns true if the sub-phase changed. */
  tick(dt: number, ctx: TickContext): boolean {
    this.clock += dt;
    let changed = false;

    // Update the displayed "next" choice while committed (Part 5: only choice allowed).
    if (this.committed && !this.emergencyHold) {
      this.plannedNext = ctx.chooseNextGreen(this.green);
    }

    // Emergency hold: stay in ALL_RED until explicitly cleared and box safe.
    if (this.emergencyHold) {
      if (this.sub !== "ALL_RED") this.enter("ALL_RED", MAX_ALL_RED_SECONDS);
      return changed;
    }

    // Preemption drives the phase choice toward the emergency vehicle's movement;
    // otherwise the adaptive controller chooses. Either way, transitions still go
    // through the normal yellow -> all-red safety sequence (no instant flip).
    const chooseNext = (current: GreenPhase): GreenPhase =>
      this.preemptPhase !== null ? this.preemptPhase : ctx.chooseNextGreen(current);

    switch (this.sub) {
      case "GREEN": {
        const minSatisfied = this.elapsed >= MIN_GREEN_SECONDS;
        const earlyGo = this.earlyRequest && minSatisfied;
        const timedOut = this.elapsed >= this.plannedDuration;
        // Preemption: if we are NOT already serving the emergency movement, end
        // this green as soon as min-green is met to switch toward it. If we ARE
        // serving it, hold green (never early-cut) until the vehicle clears.
        const preemptWantsSwitch =
          this.preemptPhase !== null && this.green !== this.preemptPhase && minSatisfied;
        const preemptHolds = this.preemptPhase !== null && this.green === this.preemptPhase;
        // Starvation cut (fairness): a movement that has starved past the cap and
        // is NOT the one currently green force-ends this green after min-green, so
        // relief lands within min-green + one transition rather than after the full
        // (possibly max) green. Preemption still outranks it (emergency first).
        const starvedPhase = ctx.starvationCut ? ctx.starvationCut(this.green) : null;
        const starvationWantsSwitch =
          this.preemptPhase === null && starvedPhase !== null && starvedPhase !== this.green && minSatisfied;
        // In MANUAL the phase only ends on explicit request (still via yellow).
        const shouldEnd =
          !preemptHolds &&
          (preemptWantsSwitch || starvationWantsSwitch || earlyGo || (!this.manual && timedOut));
        if (shouldEnd) {
          this.earlyRequest = false;
          this.plannedNext = chooseNext(this.green);
          this.enter("YELLOW", YELLOW_SECONDS);
          changed = true;
        }
        break;
      }
      case "YELLOW": {
        if (this.elapsed >= this.plannedDuration) {
          this.enter("ALL_RED", BASE_ALL_RED_SECONDS);
          changed = true;
        }
        break;
      }
      case "ALL_RED": {
        const baseDone = this.elapsed >= this.plannedDuration;
        // Extend all-red (up to the cap) while vehicles still occupy the box.
        if (baseDone && ctx.boxOccupied && this.plannedDuration < MAX_ALL_RED_SECONDS) {
          this.plannedDuration = Math.min(MAX_ALL_RED_SECONDS, this.plannedDuration + dt + 0.5);
        }
        const capReached = this.elapsed >= MAX_ALL_RED_SECONDS;
        if (baseDone && (!ctx.boxOccupied || capReached)) {
          const next = chooseNext(this.green);
          this.green = next;
          this.plannedNext = DEFAULT_NEXT[next];
          // A preempted green is held at max so it won't time out before the
          // vehicle clears; otherwise use the adaptive duration.
          const duration =
            this.preemptPhase === next ? MAX_GREEN_SECONDS : clampGreen(ctx.decideGreenDuration(next));
          this.enter("GREEN", duration);
          changed = true;
        }
        break;
      }
    }
    return changed;
  }
}

export function clampGreen(seconds: number): number {
  return Math.max(MIN_GREEN_SECONDS, Math.min(MAX_GREEN_SECONDS, seconds));
}
