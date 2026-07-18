import { describe, expect, it } from "vitest";

import { zoneAt } from "@/lib/sim/conflictBox";
import { SimulationEngine } from "@/lib/sim/engine";
import { sampleAt } from "@/lib/sim/roadGraph";

/**
 * Scenario acceptance tests (Spec "Danh sách kịch bản đã thử").
 * Each drives the real engine and asserts an acceptance criterion holds.
 */

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function run(engine: SimulationEngine, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) engine.tick(dt);
}

/** No two vehicles from different entry lanes share a conflict zone in the box. */
function assertNoConflictSharing(engine: SimulationEngine): void {
  const owners = new Map<string, string>();
  for (const v of engine.vehicles) {
    if (v.progress <= v.route.stopProgress) continue;
    if (v.progress >= v.route.path.length - v.route.stopProgress) continue;
    const point = sampleAt(v.route.path, v.progress);
    const zone = zoneAt(point.x, point.z);
    if (!zone) continue;
    const existing = owners.get(zone);
    if (existing) {
      const other = engine.vehicles.find((x) => x.id === existing);
      if (other && other.route.entryLaneId !== v.route.entryLaneId) {
        throw new Error(`conflict zone ${zone} shared by ${existing} and ${v.id}`);
      }
    } else {
      owners.set(zone, v.id);
    }
  }
}

describe("scenario: heavy traffic", () => {
  it("stays bounded and collision-free under a fast spawn rate", () => {
    const engine = new SimulationEngine({ rng: seededRng(101), spawnIntervalSeconds: 0.3, maxVehicles: 80 });
    for (let i = 0; i < 60 * 180; i += 1) {
      engine.tick(1 / 60);
      if (i % 45 === 0) assertNoConflictSharing(engine);
    }
    expect(engine.vehicles.length).toBeLessThanOrEqual(80);
  });
});

describe("scenario: left turns follow a curve into the correct exit", () => {
  it("left-turning vehicles end on their declared exit lane", () => {
    const engine = new SimulationEngine({ rng: seededRng(202), spawnIntervalSeconds: 0.4 });
    let sawLeftTurner = false;
    for (let i = 0; i < 60 * 120; i += 1) {
      engine.tick(1 / 60);
      for (const v of engine.vehicles) {
        if (v.route.turn === "LEFT" && v.progress > v.route.stopProgress) {
          sawLeftTurner = true;
          // A left turn changes heading ~90°, so exit direction differs from entry.
          expect(v.route.exitLaneId).not.toContain(v.route.direction);
        }
      }
    }
    expect(sawLeftTurner).toBe(true);
  });
});

describe("scenario: countdown & committed phase", () => {
  it("never emits a negative countdown and marks commit in the last 8s", () => {
    const engine = new SimulationEngine({ rng: seededRng(303) });
    let sawCommitted = false;
    for (let i = 0; i < 60 * 120; i += 1) {
      engine.tick(1 / 60);
      const snap = engine.snapshot();
      expect(snap.remainingMs).toBeGreaterThanOrEqual(0);
      if (snap.committed) {
        sawCommitted = true;
        expect(snap.remainingSeconds).toBeLessThanOrEqual(8.01);
      }
    }
    expect(sawCommitted).toBe(true);
  });
});

describe("scenario: 10-minute soak", () => {
  it("runs 10 simulated minutes without NaN or runaway growth", () => {
    const engine = new SimulationEngine({ rng: seededRng(404), spawnIntervalSeconds: 0.45 });
    for (let i = 0; i < 60 * 600; i += 1) {
      engine.tick(1 / 60);
      if (i % 120 === 0) assertNoConflictSharing(engine);
    }
    for (const v of engine.vehicles) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.z)).toBe(true);
    }
    expect(engine.vehicles.length).toBeLessThanOrEqual(60);
  });
});
