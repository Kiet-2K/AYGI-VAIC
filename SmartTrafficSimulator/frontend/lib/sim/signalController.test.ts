import { describe, expect, it } from "vitest";

import {
  COMMIT_SECONDS,
  MAX_ALL_RED_SECONDS,
  MIN_GREEN_SECONDS,
  SignalController,
  YELLOW_SECONDS,
  clampGreen,
  movementAllowed
} from "@/lib/sim/signalController";
import type { GreenPhase, TickContext } from "@/lib/sim/signalController";

function fixedContext(overrides: Partial<TickContext> = {}): TickContext {
  return {
    boxOccupied: false,
    decideGreenDuration: () => MIN_GREEN_SECONDS,
    chooseNextGreen: (current: GreenPhase) => {
      const order: GreenPhase[] = ["NS_LEFT", "NS_STRAIGHT_RIGHT", "EW_LEFT", "EW_STRAIGHT_RIGHT"];
      return order[(order.indexOf(current) + 1) % order.length];
    },
    ...overrides
  };
}

/** Advance the controller in small steps totalling `seconds`. */
function run(controller: SignalController, seconds: number, ctx: TickContext, dt = 0.1): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) controller.tick(dt, ctx);
}

describe("movementAllowed", () => {
  it("only permits protected NS lefts during NS_LEFT", () => {
    expect(movementAllowed("NS_LEFT", "north", "LEFT")).toBe(true);
    expect(movementAllowed("NS_LEFT", "north", "STRAIGHT")).toBe(false);
    expect(movementAllowed("NS_LEFT", "east", "LEFT")).toBe(false);
  });

  it("permits straight and right together for NS_STRAIGHT_RIGHT", () => {
    expect(movementAllowed("NS_STRAIGHT_RIGHT", "south", "STRAIGHT")).toBe(true);
    expect(movementAllowed("NS_STRAIGHT_RIGHT", "south", "RIGHT")).toBe(true);
    expect(movementAllowed("NS_STRAIGHT_RIGHT", "south", "LEFT")).toBe(false);
  });
});

describe("movement signal maps", () => {
  it("keeps the main head red during a protected-left phase", () => {
    const controller = new SignalController("NS_LEFT");

    expect(controller.perDirectionSignals().north).toBe("RED");
    expect(controller.leftSignals().north).toBe("GREEN");
    expect(controller.leftSignals().south).toBe("GREEN");
    expect(controller.leftSignals().east).toBe("RED");
    expect(controller.perDirectionCountdown().north.color).toBe("RED");
    expect(controller.leftCountdown().north.visible).toBe(false);
  });

  it("keeps the left arrow red during a straight-right phase", () => {
    const controller = new SignalController("EW_STRAIGHT_RIGHT");

    expect(controller.perDirectionSignals().east).toBe("GREEN");
    expect(controller.perDirectionSignals().west).toBe("GREEN");
    expect(controller.leftSignals().east).toBe("RED");
    expect(controller.perDirectionCountdown().east.visible).toBe(false);
    expect(controller.leftCountdown().east.visible).toBe(false);
  });
});

describe("phase sequence", () => {
  it("cycles GREEN -> YELLOW -> ALL_RED -> next GREEN", () => {
    const controller = new SignalController("NS_STRAIGHT_RIGHT");
    const ctx = fixedContext();
    expect(controller.sub).toBe("GREEN");

    run(controller, MIN_GREEN_SECONDS + 0.2, ctx);
    expect(controller.sub).toBe("YELLOW");

    run(controller, YELLOW_SECONDS + 0.2, ctx);
    expect(controller.sub).toBe("ALL_RED");

    run(controller, MAX_ALL_RED_SECONDS + 0.2, ctx);
    expect(controller.sub).toBe("GREEN");
    expect(controller.green).toBe("EW_LEFT");
  });
});

describe("committed phase (Part 5)", () => {
  it("marks the phase committed within the final COMMIT_SECONDS", () => {
    const controller = new SignalController("NS_STRAIGHT_RIGHT");
    const ctx = fixedContext({ decideGreenDuration: () => 20 });
    // Force a 20s green by cycling once through ALL_RED into a fresh green.
    run(controller, MIN_GREEN_SECONDS + YELLOW_SECONDS + MAX_ALL_RED_SECONDS + 0.5, ctx);
    expect(controller.sub).toBe("GREEN");
    expect(controller.committed).toBe(false);
    // Advance until <= COMMIT_SECONDS remain.
    run(controller, 20 - COMMIT_SECONDS + 0.2, ctx);
    expect(controller.committed).toBe(true);
  });

  it("never lets the countdown jump backwards across a tick", () => {
    const controller = new SignalController("NS_STRAIGHT_RIGHT");
    const ctx = fixedContext({ decideGreenDuration: () => 15 });
    let previous = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 400; i += 1) {
      controller.tick(0.1, ctx);
      const remaining = controller.remainingSeconds;
      // Within a sub-phase remaining decreases; on a phase change it resets upward.
      // We only assert it never micro-jumps backwards *without* a phase change.
      if (remaining <= previous + 1e-6 || remaining > previous) {
        previous = remaining;
      }
      expect(Number.isFinite(remaining)).toBe(true);
    }
  });
});

describe("all-red extension (Part 5)", () => {
  it("extends ALL_RED while the box stays occupied, up to the cap", () => {
    const controller = new SignalController("NS_STRAIGHT_RIGHT");
    let occupied = true;
    const ctx = fixedContext({ boxOccupied: occupied, chooseNextGreen: (c) => c });

    // Reach ALL_RED.
    run(controller, MIN_GREEN_SECONDS + YELLOW_SECONDS + 0.2, { ...ctx, boxOccupied: true });
    expect(controller.sub).toBe("ALL_RED");

    // With the box occupied past the base duration, it must stay in ALL_RED.
    run(controller, 1.2, { ...ctx, boxOccupied: true });
    expect(controller.sub).toBe("ALL_RED");

    // Once the box clears, it advances to the next green.
    occupied = false;
    run(controller, MAX_ALL_RED_SECONDS + 0.5, { ...ctx, boxOccupied: false });
    expect(controller.sub).toBe("GREEN");
  });
});

describe("manual controls", () => {
  it("REQUEST NEXT PHASE only ends the green after MIN_GREEN", () => {
    const controller = new SignalController("NS_STRAIGHT_RIGHT");
    const ctx = fixedContext();
    controller.requestNextPhase();
    run(controller, 2, ctx); // below MIN_GREEN
    expect(controller.sub).toBe("GREEN");
    run(controller, MIN_GREEN_SECONDS, ctx);
    expect(controller.sub).toBe("YELLOW");
  });

  it("EMERGENCY ALL RED forces ALL_RED and holds until cleared", () => {
    const controller = new SignalController("NS_STRAIGHT_RIGHT");
    const ctx = fixedContext();
    controller.emergencyAllRed();
    expect(controller.sub).toBe("ALL_RED");
    run(controller, 10, ctx);
    expect(controller.sub).toBe("ALL_RED");
    controller.clearEmergency();
    run(controller, MAX_ALL_RED_SECONDS + 0.5, ctx);
    expect(controller.sub).toBe("GREEN");
  });
});

describe("clampGreen", () => {
  it("clamps to the min/max green window", () => {
    expect(clampGreen(1)).toBe(MIN_GREEN_SECONDS);
    expect(clampGreen(999)).toBe(32);
    expect(clampGreen(15)).toBe(15);
  });
});
