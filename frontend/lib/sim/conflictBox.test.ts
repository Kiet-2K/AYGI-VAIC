import { beforeAll, describe, expect, it } from "vitest";

import {
  ConflictRegistry,
  computeRouteZones,
  initRouteConflictZones,
  routesConflict,
  zoneAt
} from "@/lib/sim/conflictBox";
import { ROUTES } from "@/lib/sim/roadGraph";

beforeAll(() => {
  initRouteConflictZones();
});

describe("zoneAt", () => {
  it("returns null outside the intersection box", () => {
    expect(zoneAt(100, 0)).toBeNull();
    expect(zoneAt(0, 100)).toBeNull();
  });

  it("returns a stable zone id inside the box", () => {
    expect(zoneAt(0, 0)).toBe(zoneAt(0.1, 0.1));
    expect(typeof zoneAt(0, 0)).toBe("string");
  });
});

describe("route conflict zones", () => {
  it("assigns at least one zone to every route", () => {
    for (const route of Object.values(ROUTES)) {
      expect(route.conflictZones.length).toBeGreaterThan(0);
    }
  });

  it("computes zones deterministically", () => {
    const route = ROUTES.north_STRAIGHT;
    const first = computeRouteZones(route);
    const second = computeRouteZones(route);
    expect(first).toEqual(second);
  });

  it("detects two crossing straights as conflicting", () => {
    // North-straight and east-straight cross the centre -> must conflict.
    expect(routesConflict(ROUTES.north_STRAIGHT, ROUTES.east_STRAIGHT)).toBe(true);
  });

  it("treats a right turn as non-conflicting with the opposing straight", () => {
    // North right turn hugs its own corner; it should not touch south-straight's lane.
    expect(routesConflict(ROUTES.north_RIGHT, ROUTES.south_STRAIGHT)).toBe(false);
  });
});

describe("ConflictRegistry", () => {
  it("grants a free zone set and blocks a conflicting claim", () => {
    const registry = new ConflictRegistry();
    const zones = ["z_1_1", "z_1_2"];
    expect(registry.canReserve(zones, "a")).toBe(true);
    registry.reserve(zones, "a");
    expect(registry.canReserve(["z_1_2"], "b")).toBe(false);
    expect(registry.canReserve(["z_1_2"], "a")).toBe(true);
  });

  it("frees zones only when the owner releases them", () => {
    const registry = new ConflictRegistry();
    registry.reserve(["z_0_0"], "a");
    registry.release(["z_0_0"], "b"); // wrong owner -> no-op
    expect(registry.canReserve(["z_0_0"], "b")).toBe(false);
    registry.release(["z_0_0"], "a");
    expect(registry.canReserve(["z_0_0"], "b")).toBe(true);
  });

  it("reports occupancy and releases all zones for a vehicle", () => {
    const registry = new ConflictRegistry();
    expect(registry.occupied).toBe(false);
    registry.reserve(["z_0_0", "z_1_1"], "a");
    expect(registry.occupied).toBe(true);
    registry.releaseAll("a");
    expect(registry.occupied).toBe(false);
  });
});
