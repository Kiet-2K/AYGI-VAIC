import { describe, expect, it } from "vitest";

import {
  INTERSECTION_HALF,
  LANE_OFFSET,
  LANES,
  ROUTES,
  ROUTE_LIST,
  sampleAt,
  yawFromTangent
} from "@/lib/sim/roadGraph";

describe("road graph lanes", () => {
  it("creates a through, a left-pocket, and an outbound lane per direction", () => {
    // 4 directions x 3 lanes (through inbound + left-turn pocket + outbound).
    expect(Object.keys(LANES)).toHaveLength(12);
    expect(LANES.north_in.kind).toBe("INBOUND");
    expect(LANES.north_left_in.kind).toBe("INBOUND");
    expect(LANES.north_out.kind).toBe("OUTBOUND");
  });

  it("places northbound traffic on the right (+x) per right-hand rule", () => {
    // Northbound heads -z; its right side is +x, so the lane sits at +LANE_OFFSET.
    expect(LANES.north_in.stopLine?.x).toBeCloseTo(LANE_OFFSET);
    expect(LANES.south_in.stopLine?.x).toBeCloseTo(-LANE_OFFSET);
  });

  it("splits turns across lanes: through/right outer, left in the pocket", () => {
    // Through lane carries STRAIGHT + RIGHT; the pocket carries LEFT only.
    expect(LANES.north_in.allowedTurns.sort()).toEqual(["RIGHT", "STRAIGHT"]);
    expect(LANES.north_left_in.allowedTurns).toEqual(["LEFT"]);
    expect(LANES.north_out.allowedTurns).toEqual([]);
  });
});

describe("routes", () => {
  it("builds 12 routes (4 directions x 3 turns)", () => {
    expect(ROUTE_LIST).toHaveLength(12);
  });

  it("straight route keeps the same lane offset from entry to exit", () => {
    const route = ROUTES.north_STRAIGHT;
    expect(route.exitLaneId).toBe("north_out");
    const start = sampleAt(route.path, 0);
    const end = sampleAt(route.path, route.path.length);
    expect(start.x).toBeCloseTo(LANE_OFFSET);
    expect(end.x).toBeCloseTo(LANE_OFFSET);
  });

  it("right turn from north lands in the east exit lane", () => {
    const route = ROUTES.north_RIGHT;
    expect(route.exitLaneId).toBe("east_out");
    const end = sampleAt(route.path, route.path.length);
    // East exit lane sits at z = +LANE_OFFSET, x beyond the intersection.
    expect(end.z).toBeCloseTo(LANE_OFFSET);
    expect(end.x).toBeGreaterThan(INTERSECTION_HALF);
  });

  it("left turn from north lands in the west exit lane", () => {
    const route = ROUTES.north_LEFT;
    expect(route.exitLaneId).toBe("west_out");
    const end = sampleAt(route.path, route.path.length);
    expect(end.z).toBeCloseTo(-LANE_OFFSET);
    expect(end.x).toBeLessThan(-INTERSECTION_HALF);
  });

  it("stopProgress lands the bumper at the stop line", () => {
    const route = ROUTES.north_STRAIGHT;
    const atStop = sampleAt(route.path, route.stopProgress);
    expect(atStop.z).toBeCloseTo(INTERSECTION_HALF);
  });
});

describe("path sampling", () => {
  it("produces a continuous, monotonic-length path", () => {
    for (const route of ROUTE_LIST) {
      expect(route.path.length).toBeGreaterThan(0);
      for (let i = 1; i < route.path.cumulative.length; i += 1) {
        expect(route.path.cumulative[i]).toBeGreaterThanOrEqual(route.path.cumulative[i - 1]);
      }
    }
  });

  it("returns unit tangents aligned with initial heading", () => {
    const route = ROUTES.north_STRAIGHT;
    const sample = sampleAt(route.path, 1);
    // North heads -z, so tangentZ should be about -1.
    expect(sample.tangentZ).toBeCloseTo(-1, 1);
    expect(Math.hypot(sample.tangentX, sample.tangentZ)).toBeCloseTo(1, 5);
  });

  it("yaw matches atan2(x, z) convention", () => {
    expect(yawFromTangent(0, -1)).toBeCloseTo(Math.atan2(0, -1));
    expect(yawFromTangent(1, 0)).toBeCloseTo(Math.atan2(1, 0));
  });
});
