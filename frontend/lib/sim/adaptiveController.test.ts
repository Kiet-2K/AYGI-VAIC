import { describe, expect, it } from "vitest";

import {
  AdaptiveController,
  EMPTY_DIRECTION_STATS,
  classifyState,
  directionDemand,
  phaseDemand,
  type DirectionStats,
  type StatsMap
} from "@/lib/sim/adaptiveController";
import type { Direction } from "@/types/traffic";

/**
 * Build a StatsMap for tests. Live phase scoring now reads each approach's
 * `left`/`through` movement groups (Task E lane split), so a fixture that only
 * sets top-level queue fields would score 0 under `phaseDemand`. To keep the
 * fixtures terse and express the common "undivided approach" case, top-level
 * queue/arrival/wait fields are mirrored into the `through` group by default
 * (i.e. all traffic is straight/right unless the test sets `left`/`through`
 * explicitly). Tests that need a split can still pass `through`/`left` overrides.
 */
function stats(overrides: Partial<Record<Direction, Partial<DirectionStats>>>): StatsMap {
  const base = (): DirectionStats => ({ ...EMPTY_DIRECTION_STATS });
  const map: StatsMap = { north: base(), south: base(), east: base(), west: base() };
  for (const dir of Object.keys(overrides) as Direction[]) {
    const merged: DirectionStats = { ...map[dir], ...overrides[dir] };
    const o = overrides[dir]!;
    // Mirror aggregate queue fields into the through group unless the test set it.
    if (o.through === undefined) {
      merged.through = {
        ...merged.through,
        queueLength: merged.queueLength,
        queuePcu: merged.queuePcu,
        arrivalRate: merged.arrivalRate,
        avgWaitingTime: merged.avgWaitingTime,
        maxWaitingTime: merged.maxWaitingTime,
        downstreamOccupancy: merged.downstreamOccupancy
      };
    }
    map[dir] = merged;
  }
  return map;
}

describe("directionDemand", () => {
  it("rises with PCU-weighted queue load, not just vehicle count", () => {
    const light = directionDemand({ ...EMPTY_DIRECTION_STATS, queueLength: 3, queuePcu: 3 });
    const heavy = directionDemand({ ...EMPTY_DIRECTION_STATS, queueLength: 3, queuePcu: 9 });
    // Same number of vehicles, but trucks (higher PCU) create more demand.
    expect(heavy).toBeGreaterThan(light);
  });

  it("discounts demand when the downstream exit is full", () => {
    const clear = directionDemand({ ...EMPTY_DIRECTION_STATS, queuePcu: 6, downstreamOccupancy: 0.1 });
    const blocked = directionDemand({ ...EMPTY_DIRECTION_STATS, queuePcu: 6, downstreamOccupancy: 0.95 });
    expect(blocked).toBeLessThan(clear);
  });
});

describe("phaseDemand", () => {
  it("sums demand across the directions a phase serves", () => {
    const s = stats({ north: { queuePcu: 4 }, south: { queuePcu: 2 } });
    expect(phaseDemand("NS_STRAIGHT_RIGHT", s)).toBeCloseTo(6, 5);
    expect(phaseDemand("EW_STRAIGHT_RIGHT", s)).toBe(0);
  });
});

describe("classifyState", () => {
  it("returns FREE for an empty intersection", () => {
    expect(classifyState(stats({}))).toBe("FREE");
  });

  it("returns BUSY when traffic is present but flowing", () => {
    const s = stats({
      north: { vehicleCount: 5, medianSpeed: 5 },
      east: { vehicleCount: 4, medianSpeed: 5 }
    });
    expect(classifyState(s)).toBe("BUSY");
  });

  it("returns GRIDLOCK when queues are heavy, speed ~0 and nothing departs", () => {
    const s = stats({
      north: { vehicleCount: 8, queueLength: 8, queuePcu: 8, medianSpeed: 0.1, departureRate: 0 },
      south: { vehicleCount: 6, queueLength: 6, queuePcu: 6, medianSpeed: 0.1, departureRate: 0 }
    });
    expect(classifyState(s)).toBe("GRIDLOCK");
  });
});

describe("AdaptiveController", () => {
  it("prefers the higher-demand phase", () => {
    const controller = new AdaptiveController(stats({}));
    controller.update(
      stats({
        east: { queuePcu: 10, queueLength: 5, arrivalRate: 1 },
        west: { queuePcu: 8, queueLength: 4 }
      })
    );
    expect(controller.chooseNextGreen("NS_STRAIGHT_RIGHT")).toMatch(/EW/);
  });

  it("gives longer green to heavier PCU demand", () => {
    const controller = new AdaptiveController(stats({}));
    controller.update(stats({ north: { queuePcu: 12 }, south: { queuePcu: 12 } }));
    const busy = controller.decideGreenDuration("NS_STRAIGHT_RIGHT");
    controller.update(stats({ north: { queuePcu: 1 } }));
    const quiet = controller.decideGreenDuration("NS_STRAIGHT_RIGHT");
    expect(busy).toBeGreaterThan(quiet);
  });

  it("blocks entry and reports gridlock during recovery", () => {
    const controller = new AdaptiveController(stats({}));
    controller.update(
      stats({
        north: { vehicleCount: 8, queueLength: 8, queuePcu: 8, medianSpeed: 0.1, departureRate: 0 },
        south: { vehicleCount: 6, queueLength: 6, queuePcu: 6, medianSpeed: 0.1, departureRate: 0 }
      })
    );
    expect(controller.trafficState).toBe("GRIDLOCK");
    expect(controller.blockEntry).toBe(true);
    // Recovery should open a phase and surface a reason mentioning gridlock.
    controller.chooseNextGreen("NS_STRAIGHT_RIGHT");
    expect(controller.reason).toMatch(/GRIDLOCK/);
  });

  it("avoids opening a phase whose downstream exits are all full", () => {
    const controller = new AdaptiveController(stats({}));
    controller.update(
      stats({
        north: { queuePcu: 10, downstreamOccupancy: 0.95 },
        south: { queuePcu: 10, downstreamOccupancy: 0.95 },
        east: { queuePcu: 3, downstreamOccupancy: 0.1 },
        west: { queuePcu: 3, downstreamOccupancy: 0.1 }
      })
    );
    // NS has more raw PCU but its exits are full, so EW should win.
    expect(controller.chooseNextGreen("EW_STRAIGHT_RIGHT")).toMatch(/EW/);
  });
});
