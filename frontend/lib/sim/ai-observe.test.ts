import { describe, expect, it } from "vitest";

import { MAX_WAIT_CAP_SECONDS } from "@/lib/sim/adaptiveController";
import { runObservation } from "@/scripts/ai-observe";

/**
 * AI harness assertions (Task G, headless half). These pin the two behavioural
 * bugs the overhaul fixed so they can never silently regress:
 *   - #5 East-West must get served: BOTH axes accrue meaningful, roughly balanced
 *     green time (a permanent-red bug would zero one axis out), and at a load the
 *     intersection can actually serve, no direction waits far past the fairness cap.
 *   - #6 Spawning must never permanently stall: after warm-up the intersection
 *     always keeps some vehicles flowing (min-after-warmup > 0) and throughput
 *     is non-trivial.
 *
 * IMPORTANT on the wait bound: the MAX_WAIT_CAP is a *force-serve trigger*, not a
 * ceiling on the wait a vehicle can actually accumulate. Under an oversaturated
 * load (demand > the intersection's discharge capacity) queues grow without bound
 * and a back-of-queue vehicle legitimately waits several full signal cycles — that
 * is traffic physics, not a controller fault. So we verify the hard wait bound at a
 * *servable* load, and separately verify fairness (balanced green, no permanent
 * red) even under a saturating load, where a fixed wait ceiling would be meaningless.
 */

describe("AI observation harness", () => {
  it("keeps both axes fairly served even under a saturating load (no permanent red)", () => {
    // Deliberately oversaturate: demand far exceeds capacity. The #5 bug would
    // pin one axis red and starve it to zero green; the fix must keep BOTH axes
    // cycling with roughly balanced green time regardless of queue pressure.
    const report = runObservation({ minutes: 10, seed: 12345, spawnIntervalSeconds: 0.4 });

    expect(report.greenTime.ns).toBeGreaterThan(60);
    expect(report.greenTime.ew).toBeGreaterThan(60);

    // Neither axis may dominate: the starved axis must get at least ~65% of the
    // green the busier axis gets. (EW-stuck-red drove this ratio to ~0.)
    const balance =
      Math.min(report.greenTime.ns, report.greenTime.ew) /
      Math.max(report.greenTime.ns, report.greenTime.ew);
    expect(balance).toBeGreaterThan(0.65);
  });

  it("bounds worst-case wait at a load the intersection can serve", () => {
    // A servable load (demand <= capacity): here the fairness cap plus one
    // green/yellow/all-red transition really does bound the achievable wait.
    // Worst case relief ≈ cap + one full max phase (green+yellow+all-red) per
    // the FSM, so allow that plus headroom for queue discharge behind the leader.
    const report = runObservation({
      minutes: 10,
      seed: 12345,
      spawnIntervalSeconds: 3,
      maxVehicles: 60
    });

    // Both axes still served.
    expect(report.greenTime.ns).toBeGreaterThan(60);
    expect(report.greenTime.ew).toBeGreaterThan(60);

    // cap (45) + max green (32) + yellow (3) + all-red (3) ≈ 83s for the leader;
    // allow generous headroom for vehicles discharging behind it within the cycle.
    const ceiling = MAX_WAIT_CAP_SECONDS + 75;
    for (const dir of ["north", "south", "east", "west"] as const) {
      expect(report.peakWaitByDirection[dir]).toBeLessThan(ceiling);
    }
  });

  it("never permanently stalls spawning and moves real throughput", () => {
    const report = runObservation({ minutes: 10, seed: 777, spawnIntervalSeconds: 0.35 });

    // Spawn stall (#6) would drain the map and never refill: after warm-up we
    // must always have vehicles present.
    expect(report.minVehiclesAfterWarmup).toBeGreaterThan(0);
    // A 10-minute run should push a substantial number of vehicles through.
    expect(report.throughput).toBeGreaterThan(50);
  });

  it("produces a decision sample stream for the log", () => {
    const report = runObservation({ minutes: 2, seed: 42, sampleEverySeconds: 5 });
    expect(report.samples.length).toBeGreaterThan(10);
    // Every sample must name a valid chosen phase and carry four demand rows.
    for (const s of report.samples) {
      expect(s.demands).toHaveLength(4);
      expect(["NS_LEFT", "NS_STRAIGHT_RIGHT", "EW_LEFT", "EW_STRAIGHT_RIGHT"]).toContain(s.chosenNext);
    }
  });
});
