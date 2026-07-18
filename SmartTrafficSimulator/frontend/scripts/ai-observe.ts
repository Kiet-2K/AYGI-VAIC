/**
 * Headless AI observer (Task G).
 *
 * Runs the real {@link SimulationEngine} for a number of simulated minutes with a
 * fixed timestep and records what the adaptive brain decides over the run: the
 * traffic state, per-phase demand, the chosen phase and its reason, green-time
 * balance between the NS and EW axes, the worst per-direction wait, and
 * throughput. It is deliberately free of React/three so it can run under the
 * plain vitest/node loader (no extra deps like `tsx` required).
 *
 * Two entry points:
 *   - {@link runObservation} returns a structured {@link ObservationReport} used
 *     by the fairness/no-stall assertions in `ai-observe.test.ts`.
 *   - the bottom `import.meta` guard prints a human-readable decision log when
 *     this file is executed directly (e.g. `node --import tsx scripts/ai-observe.ts`).
 */

import { MAX_WAIT_CAP_SECONDS } from "@/lib/sim/adaptiveController";
import { SimulationEngine } from "@/lib/sim/engine";
import type { GreenPhase } from "@/lib/sim/signalController";
import { DIRECTIONS, type Direction } from "@/types/traffic";

/** Deterministic LCG so a run is reproducible from a seed. */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export interface DecisionSample {
  /** Simulated seconds elapsed at the moment of sampling. */
  t: number;
  state: string;
  currentGreen: GreenPhase;
  chosenNext: GreenPhase;
  reason: string;
  /** Demand per phase in GREEN_PHASES order, rounded for readability. */
  demands: { phase: GreenPhase; demand: number }[];
  /** Worst per-direction max-wait at this instant. */
  worstWait: number;
  preempted: boolean;
}

export interface ObservationReport {
  seed: number;
  simSeconds: number;
  samples: DecisionSample[];
  /** Seconds each axis spent green (approximated by sampling the active phase). */
  greenTime: { ns: number; ew: number };
  /** Peak per-direction max-wait observed across the whole run. */
  peakWaitByDirection: Record<Direction, number>;
  /** Global peak wait across all directions. */
  peakWait: number;
  /** Total vehicles that departed (crossed and despawned) during the run. */
  throughput: number;
  /** Highest simultaneous vehicle count (spawn-stall canary: never hits 0 mid-run). */
  peakVehicles: number;
  /** Lowest vehicle count seen AFTER the warm-up period (stall canary). */
  minVehiclesAfterWarmup: number;
}

export interface ObserveOptions {
  seed?: number;
  minutes?: number;
  dt?: number;
  /** How often (sim seconds) to capture a decision sample. */
  sampleEverySeconds?: number;
  spawnIntervalSeconds?: number;
  maxVehicles?: number;
}

function axisOf(green: GreenPhase): "ns" | "ew" {
  return green === "NS_LEFT" || green === "NS_STRAIGHT_RIGHT" ? "ns" : "ew";
}

/** Run a headless observation and return a structured report. */
export function runObservation(options: ObserveOptions = {}): ObservationReport {
  const seed = options.seed ?? 12345;
  const simSeconds = (options.minutes ?? 10) * 60;
  const dt = options.dt ?? 1 / 60;
  const sampleEvery = options.sampleEverySeconds ?? 5;
  const warmupSeconds = 20;

  const engine = new SimulationEngine({
    rng: seededRng(seed),
    spawnIntervalSeconds: options.spawnIntervalSeconds ?? 0.4,
    maxVehicles: options.maxVehicles ?? 160
  });

  const samples: DecisionSample[] = [];
  const greenTime = { ns: 0, ew: 0 };
  const peakWaitByDirection: Record<Direction, number> = { north: 0, south: 0, east: 0, west: 0 };
  let peakWait = 0;
  let peakVehicles = 0;
  let minVehiclesAfterWarmup = Number.POSITIVE_INFINITY;

  // Throughput = cumulative departures. The engine doesn't expose a running
  // total, so we count despawns by watching the roster shrink between ticks
  // against spawns. Simpler: track ids that leave.
  const seenIds = new Set<string>();
  let everSpawned = 0;

  const steps = Math.round(simSeconds / dt);
  let sampleClock = 0;

  for (let i = 0; i < steps; i += 1) {
    engine.tick(dt);
    const t = (i + 1) * dt;

    // Roster bookkeeping for throughput + stall canary.
    for (const v of engine.vehicles) {
      if (!seenIds.has(v.id)) {
        seenIds.add(v.id);
        everSpawned += 1;
      }
    }
    const count = engine.vehicles.length;
    if (count > peakVehicles) peakVehicles = count;
    if (t > warmupSeconds && count < minVehiclesAfterWarmup) minVehiclesAfterWarmup = count;

    // Green-time accounting by active axis (only while a green is showing).
    const dbg = engine.aiDebug();
    greenTime[axisOf(dbg.currentGreen)] += dt;

    // Track peak waits every tick (cheap, from the stats map).
    for (const d of DIRECTIONS) {
      const w = dbg.stats[d].maxWaitingTime;
      if (w > peakWaitByDirection[d]) peakWaitByDirection[d] = w;
      if (w > peakWait) peakWait = w;
    }

    sampleClock += dt;
    if (sampleClock >= sampleEvery) {
      sampleClock -= sampleEvery;
      const worstWait = Math.max(...DIRECTIONS.map((d) => dbg.stats[d].maxWaitingTime));
      samples.push({
        t: Math.round(t),
        state: dbg.state,
        currentGreen: dbg.currentGreen,
        chosenNext: dbg.chosenNext,
        reason: dbg.reason,
        demands: dbg.phaseDemands.map((r) => ({ phase: r.phase, demand: Math.round(r.demand * 10) / 10 })),
        worstWait: Math.round(worstWait),
        preempted: dbg.preempted
      });
    }
  }

  const throughput = everSpawned - engine.vehicles.length;
  if (!Number.isFinite(minVehiclesAfterWarmup)) minVehiclesAfterWarmup = 0;

  return {
    seed,
    simSeconds,
    samples,
    greenTime: { ns: Math.round(greenTime.ns), ew: Math.round(greenTime.ew) },
    peakWaitByDirection,
    peakWait: Math.round(peakWait),
    throughput,
    peakVehicles,
    minVehiclesAfterWarmup
  };
}

/** Pretty-print a report as a decision log (used by the direct-run CLI). */
export function formatReport(report: ObservationReport): string {
  const lines: string[] = [];
  lines.push(`=== AI OBSERVATION (seed ${report.seed}, ${report.simSeconds}s) ===`);
  lines.push("");
  lines.push("time  state       green -> next            worst  reason");
  for (const s of report.samples) {
    const wait = String(s.worstWait).padStart(3);
    const pre = s.preempted ? " [PREEMPT]" : "";
    lines.push(
      `${String(s.t).padStart(4)}  ${s.state.padEnd(10)}  ${s.currentGreen.padEnd(18)} -> ${s.chosenNext.padEnd(18)} ${wait}s  ${s.reason}${pre}`
    );
  }
  lines.push("");
  lines.push(`green-time balance: NS=${report.greenTime.ns}s  EW=${report.greenTime.ew}s`);
  lines.push(
    `peak wait: N=${Math.round(report.peakWaitByDirection.north)} S=${Math.round(report.peakWaitByDirection.south)} ` +
      `E=${Math.round(report.peakWaitByDirection.east)} W=${Math.round(report.peakWaitByDirection.west)} (cap ${MAX_WAIT_CAP_SECONDS})`
  );
  lines.push(`throughput: ${report.throughput} vehicles departed`);
  lines.push(`vehicles: peak=${report.peakVehicles}, min-after-warmup=${report.minVehiclesAfterWarmup}`);
  return lines.join("\n");
}

// Direct-run guard: `node --import tsx frontend/scripts/ai-observe.ts [minutes] [seed]`.
// Skipped when imported (e.g. by the vitest harness), so tests stay side-effect free.
if (typeof process !== "undefined" && process.argv[1] && process.argv[1].includes("ai-observe")) {
  const minutes = Number(process.argv[2]) || 10;
  const seed = Number(process.argv[3]) || 12345;
  const report = runObservation({ minutes, seed });
  // eslint-disable-next-line no-console
  console.log(formatReport(report));
}
