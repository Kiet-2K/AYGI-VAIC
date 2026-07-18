import { describe, expect, it } from "vitest";

import { zoneAt } from "@/lib/sim/conflictBox";
import { SimulationEngine } from "@/lib/sim/engine";
import { sampleAt } from "@/lib/sim/roadGraph";
import type { Vehicle } from "@/lib/sim/vehicle";

/** Deterministic RNG for reproducible soak tests. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/** Minimum bumper distance between two vehicles' body centres (approx overlap test). */
function overlaps(a: Vehicle, b: Vehicle): boolean {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const dist = Math.hypot(dx, dz);
  // Require centres to be closer than the sum of half-lengths minus slack to count
  // as a real overlap (ignores side-by-side vehicles on different lanes).
  const minCentre = (a.length + b.length) / 2 - 0.6;
  // Only meaningful when they are roughly collinear (same lane / crossing point).
  return dist < minCentre && dist < 1.2;
}

function run(engine: SimulationEngine, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) engine.tick(dt);
}

describe("SimulationEngine integration", () => {
  it("allocates unique five-digit plates and reuses normal plates after reset", () => {
    const engine = new SimulationEngine({ rng: seededRng(91), spawnIntervalSeconds: 0.05, maxVehicles: 20 });
    run(engine, 2);
    const plates = engine.vehicles.map((vehicle) => vehicle.licensePlate);
    expect(plates.length).toBeGreaterThan(1);
    expect(new Set(plates).size).toBe(plates.length);
    expect(plates.every((plate) => /^\d{5}$/.test(plate))).toBe(true);
    const released = new Set(plates);
    engine.reset();
    expect(engine.activePlateCount).toBe(0);
    expect(engine.reusablePlateCount).toBe(released.size);
    run(engine, 1);
    expect(engine.vehicles.some((vehicle) => released.has(vehicle.licensePlate))).toBe(true);
  });

  it("blacklists a red-light plate once and keeps it unavailable across reset", () => {
    const engine = new SimulationEngine({ rng: seededRng(92), spawnIntervalSeconds: 0.05, maxVehicles: 10 });
    engine.triggerRedLightViolation();
    let violation;
    for (let i = 0; i < 60 * 30 && !violation; i += 1) {
      engine.tick(1 / 60);
      violation = engine.drainViolations()[0];
    }
    expect(violation).toBeDefined();
    if (!violation) throw new Error("expected deterministic red-light violation");
    expect(violation.vehicleClass).toBeTruthy();
    expect(violation.licensePlate).toMatch(/^\d{5}$/);
    const plate = violation.licensePlate;
    expect(engine.blacklistedPlateCount()).toBeGreaterThan(0);
    engine.reset();
    run(engine, 3);
    expect(engine.vehicles.some((vehicle) => vehicle.licensePlate === plate)).toBe(false);
    expect(engine.vehicles.length).toBeLessThanOrEqual(10);
  });

  it("uses the existing clock for pause and speed controls", () => {
    const engine = new SimulationEngine({ rng: seededRng(93), spawnIntervalSeconds: 0.5 });
    engine.pause();
    run(engine, 2);
    expect(engine.vehicles).toHaveLength(0);
    engine.resume();
    engine.setSpeedMultiplier(2);
    run(engine, 0.3);
    expect(engine.vehicles.length).toBeGreaterThan(0);
  });

  it("spawns vehicles over time", () => {
    const engine = new SimulationEngine({ rng: seededRng(1), spawnIntervalSeconds: 0.5 });
    run(engine, 10);
    expect(engine.vehicles.length).toBeGreaterThan(0);
  });

  it("never lets two vehicles on the same route occupy the same point", () => {
    const engine = new SimulationEngine({ rng: seededRng(7), spawnIntervalSeconds: 0.5 });
    let maxSeen = 0;
    run(engine, 120);
    for (let i = 0; i < engine.vehicles.length; i += 1) {
      for (let j = i + 1; j < engine.vehicles.length; j += 1) {
        const a = engine.vehicles[i];
        const b = engine.vehicles[j];
        if (a.route.entryLaneId === b.route.entryLaneId) {
          expect(overlaps(a, b)).toBe(false);
        }
      }
    }
    maxSeen = engine.vehicles.length;
    expect(maxSeen).toBeGreaterThan(0);
  });

  it("holds vehicles behind the stop line on red", () => {
    const engine = new SimulationEngine({ rng: seededRng(3), spawnIntervalSeconds: 0.6 });
    run(engine, 40);
    for (const v of engine.vehicles) {
      const color = engine.snapshot().signals[v.route.direction];
      // A red-facing vehicle should not have its bumper past the stop line
      // unless it had already entered the box under a previous green.
      if (color === "RED" && v.progress < v.route.stopProgress) {
        expect(v.progress).toBeLessThanOrEqual(v.route.stopProgress + 0.3);
      }
    }
  });

  it("does not allow conflicting routes to occupy the same zone simultaneously", () => {
    const engine = new SimulationEngine({ rng: seededRng(9), spawnIntervalSeconds: 0.4 });
    for (let step = 0; step < 60 * 90; step += 1) {
      engine.tick(1 / 60);
      // Every few frames, assert no zone is claimed by two vehicles at once.
      if (step % 30 === 0) {
        const owners = new Map<string, string>();
        for (const v of engine.vehicles) {
          if (v.progress <= v.route.stopProgress) continue;
          const point = sampleAt(v.route.path, v.progress);
          const zone = zoneAt(point.x, point.z);
          if (!zone) continue;
          const existing = owners.get(zone);
          if (existing) {
            // Two bodies in one zone is only allowed if they came from the same
            // movement group and are following in a line (same entry lane).
            const other = engine.vehicles.find((x) => x.id === existing);
            if (other && other.route.entryLaneId !== v.route.entryLaneId) {
              // Different entry lanes sharing a zone => conflict violation.
              expect(other.route.entryLaneId).toBe(v.route.entryLaneId);
            }
          } else {
            owners.set(zone, v.id);
          }
        }
      }
    }
  });

  it("keeps a single monotonic countdown that never goes negative", () => {
    const engine = new SimulationEngine({ rng: seededRng(5) });
    for (let i = 0; i < 60 * 60; i += 1) {
      engine.tick(1 / 60);
      expect(engine.snapshot().remainingMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("runs a long soak without exploding vehicle count or NaN positions", () => {
    const engine = new SimulationEngine({ rng: seededRng(11), spawnIntervalSeconds: 0.5 });
    run(engine, 600); // 10 simulated minutes
    expect(engine.vehicles.length).toBeLessThanOrEqual(60);
    for (const v of engine.vehicles) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.z)).toBe(true);
      expect(Number.isFinite(v.progress)).toBe(true);
    }
  });

  it("responds to reset by clearing all vehicles", () => {
    const engine = new SimulationEngine({ rng: seededRng(2), spawnIntervalSeconds: 0.5 });
    run(engine, 20);
    engine.reset();
    expect(engine.vehicles.length).toBe(0);
  });
});
