import { describe, expect, it } from "vitest";

import { ROUTES } from "@/lib/sim/roadGraph";
import {
  createVehicle,
  desiredGap,
  idmAcceleration,
  integrateVehicle,
  type Vehicle
} from "@/lib/sim/vehicle";
import { VEHICLE_CLASSES, pcuOf } from "@/lib/sim/vehicleClasses";

function makeVehicle(cls: Parameters<typeof createVehicle>[0]["cls"], routeId: string): Vehicle {
  return createVehicle({
    id: `t-${routeId}-${cls}`,
    trackId: 1,
    cls,
    route: ROUTES[routeId],
    confidence: 0.95,
    reactionTime: 1.1
  });
}

describe("vehicle classes & PCU", () => {
  it("assigns distinct PCU per class, heavier = higher", () => {
    expect(pcuOf("MOTORBIKE")).toBeLessThan(pcuOf("CAR"));
    expect(pcuOf("CAR")).toBeLessThan(pcuOf("BUS"));
    expect(pcuOf("CAR")).toBeLessThan(pcuOf("HEAVY_TRUCK"));
    expect(pcuOf("HEAVY_TRUCK")).toBe(VEHICLE_CLASSES.HEAVY_TRUCK.pcu);
  });

  it("gives each class a distinct physical envelope", () => {
    expect(VEHICLE_CLASSES.MOTORBIKE.length).toBeLessThan(VEHICLE_CLASSES.CAR.length);
    expect(VEHICLE_CLASSES.HEAVY_TRUCK.length).toBeGreaterThan(VEHICLE_CLASSES.CAR.length);
    expect(VEHICLE_CLASSES.HEAVY_TRUCK.maxAccel).toBeLessThan(VEHICLE_CLASSES.CAR.maxAccel);
  });
});

describe("IDM car-following", () => {
  it("desired gap grows with speed and closing rate", () => {
    const slow = desiredGap(2, 0, 1.8, 1.1, 2.6, 3.4);
    const fast = desiredGap(6, 0, 1.8, 1.1, 2.6, 3.4);
    expect(fast).toBeGreaterThan(slow);
    const closing = desiredGap(6, 4, 1.8, 1.1, 2.6, 3.4);
    expect(closing).toBeGreaterThan(fast);
  });

  it("accelerates on a free road toward max speed", () => {
    const v = makeVehicle("CAR", "north_STRAIGHT");
    const accel = idmAcceleration(v, Number.POSITIVE_INFINITY, 0, false);
    expect(accel).toBeGreaterThan(0);
    expect(accel).toBeLessThanOrEqual(v.maxAccel + 1e-9);
  });

  it("brakes hard when the leader is too close", () => {
    const v = makeVehicle("CAR", "north_STRAIGHT");
    v.speed = 6;
    const accel = idmAcceleration(v, 0.5, 0, true);
    expect(accel).toBeLessThan(0);
  });
});

describe("integration", () => {
  it("advances a free vehicle forward", () => {
    const v = makeVehicle("CAR", "north_STRAIGHT");
    const start = v.progress;
    for (let i = 0; i < 20; i += 1) integrateVehicle(v, 0.05, null);
    expect(v.progress).toBeGreaterThan(start);
    expect(v.speed).toBeGreaterThan(0);
  });

  it("never lets the front bumper pass the obstacle edge", () => {
    const v = makeVehicle("CAR", "north_STRAIGHT");
    v.speed = 6;
    const edge = v.progress + 2;
    for (let i = 0; i < 200; i += 1) integrateVehicle(v, 0.05, { progress: edge, speed: 0 });
    expect(v.progress).toBeLessThanOrEqual(edge + 1e-6);
  });

  it("comes to rest behind a stopped obstacle with a positive gap", () => {
    const v = makeVehicle("CAR", "north_STRAIGHT");
    v.speed = 5;
    const edge = v.progress + 12;
    for (let i = 0; i < 400; i += 1) integrateVehicle(v, 0.05, { progress: edge, speed: 0 });
    expect(v.speed).toBeLessThan(0.05);
    // Should stop with roughly the standstill gap remaining, not on top of the obstacle.
    expect(edge - v.progress).toBeGreaterThan(0.5);
  });
});
