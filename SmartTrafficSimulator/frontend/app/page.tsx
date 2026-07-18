"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { AiDebugPanel } from "@/components/AiDebugPanel";
import { FakeYoloOverlay, type DetectionSink } from "@/components/FakeYoloOverlay";
import { TrafficDashboard } from "@/components/TrafficDashboard";
import type { VehicleManagerHandle } from "@/components/VehicleManager";
import { useTrafficSocket } from "@/hooks/useTrafficSocket";
import { EMPTY_DIRECTION_STATS } from "@/lib/sim/adaptiveController";
import type { EngineSnapshot, ScenarioId } from "@/lib/sim/engine";
import {
  BLANK_COUNTDOWNS,
  EMPTY_TRAFFIC_COUNTS,
  SAFE_SIGNALS,
  type DetectionBox,
  type DirectionTrafficCounts,
  type TrafficReport,
  type ViolationEvent
} from "@/types/traffic";

const Map3D = dynamic(() => import("@/components/Map3D").then((module) => module.Map3D), { ssr: false });

const INITIAL_SNAPSHOT: EngineSnapshot = {
  phaseLabel: "ALL_RED",
  nextLabel: "NS_STRAIGHT_RIGHT",
  remainingMs: 0,
  remainingSeconds: 0,
  committed: false,
  manual: false,
  state: "FREE",
  reason: "Đang chờ trạng thái điều khiển từ backend.",
  signals: SAFE_SIGNALS,
  countdowns: BLANK_COUNTDOWNS,
  mainSignals: SAFE_SIGNALS,
  leftSignals: SAFE_SIGNALS,
  mainCountdowns: BLANK_COUNTDOWNS,
  leftCountdowns: BLANK_COUNTDOWNS,
  preempted: false,
  preemptTarget: null,
  aiDebug: {
    state: "FREE",
    reason: "Đang chờ dữ liệu giao thông.",
    currentGreen: "NS_STRAIGHT_RIGHT",
    chosenNext: "NS_STRAIGHT_RIGHT",
    phaseDemands: [
      { phase: "NS_LEFT", demand: 0, chosen: false },
      { phase: "NS_STRAIGHT_RIGHT", demand: 0, chosen: true },
      { phase: "EW_LEFT", demand: 0, chosen: false },
      { phase: "EW_STRAIGHT_RIGHT", demand: 0, chosen: false }
    ],
    stats: {
      north: { ...EMPTY_DIRECTION_STATS },
      south: { ...EMPTY_DIRECTION_STATS },
      east: { ...EMPTY_DIRECTION_STATS },
      west: { ...EMPTY_DIRECTION_STATS }
    },
    preempted: false,
    preemptTarget: null
  }
};

export default function Home() {
  const [trafficCounts, setTrafficCounts] = useState<DirectionTrafficCounts>(EMPTY_TRAFFIC_COUNTS);
  const [trafficReport, setTrafficReport] = useState<TrafficReport | null>(null);
  const [fps, setFps] = useState(0);
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(INITIAL_SNAPSHOT);
  const [violations, setViolations] = useState<ViolationEvent[]>([]);
  const [blacklistedCount, setBlacklistedCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const detectionSinkRef = useRef<DetectionSink>(() => undefined);
  const engineRef = useRef<VehicleManagerHandle | null>(null);
  const { connectionState, signalState, latencyMs, pendingCommand, error, violations: authoritativeViolations, sendCommand, sendViolations } =
    useTrafficSocket(trafficReport);

  useEffect(() => {
    setViolations(authoritativeViolations);
  }, [authoritativeViolations]);

  useEffect(() => {
    engineRef.current?.applySignalState(signalState);
  }, [signalState]);

  const updateTrafficCounts = useCallback((next: DirectionTrafficCounts) => {
    setTrafficCounts((current) =>
      Object.keys(next).every((key) => {
        const direction = key as keyof DirectionTrafficCounts;
        return current[direction].total === next[direction].total && current[direction].waiting === next[direction].waiting;
      })
        ? current
        : next
    );
  }, []);

  const publishDetections = useCallback((boxes: DetectionBox[]) => detectionSinkRef.current(boxes), []);
  const registerDetectionSink = useCallback((sink: DetectionSink) => {
    detectionSinkRef.current = sink;
  }, []);
  const bindEngine = useCallback((handle: VehicleManagerHandle) => {
    engineRef.current = handle;
  }, []);

  const handleViolations = useCallback((events: ViolationEvent[], count: number) => {
    setBlacklistedCount(count);
    sendViolations(events);
  }, [sendViolations]);

  const setPausedState = (next: boolean) => {
    setPaused(next);
    engineRef.current?.setPaused(next);
  };
  const setSpeed = (next: number) => {
    setSpeedMultiplier(next);
    engineRef.current?.setSpeedMultiplier(next);
  };
  const setScenario = (scenario: ScenarioId) => engineRef.current?.setScenario(scenario);

  const controls = {
    onRequestNext: () => sendCommand("NEXT"),
    onManual: () => sendCommand("MANUAL"),
    onAuto: () => sendCommand("AUTO"),
    onEmergency: () => sendCommand("ALL_RED"),
    onClearEmergency: () => sendCommand("CLEAR_ALL_RED"),
    onReset: () => {
      if (sendCommand("RESET")) engineRef.current?.reset();
    },
    onPauseChange: setPausedState,
    onSpeedChange: setSpeed,
    onScenarioChange: setScenario,
    onSpawnEmergency: () => engineRef.current?.triggerEmergency(),
    onTriggerViolation: () => engineRef.current?.triggerRedLightViolation()
  };

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <Map3D
        mainSignals={snapshot.mainSignals}
        leftSignals={snapshot.leftSignals}
        mainCountdowns={snapshot.mainCountdowns}
        leftCountdowns={snapshot.leftCountdowns}
        onDetections={publishDetections}
        onQueuesChange={() => undefined}
        onTrafficCounts={updateTrafficCounts}
        onTrafficReport={setTrafficReport}
        onViolations={handleViolations}
        onFpsChange={setFps}
        onSnapshot={setSnapshot}
        bindEngine={bindEngine}
      />
      <FakeYoloOverlay registerSink={registerDetectionSink} />
      <TrafficDashboard
        counts={trafficCounts}
        snapshot={snapshot}
        connectionState={connectionState}
        latencyMs={latencyMs}
        pendingCommand={pendingCommand}
        backendError={error}
        fps={fps}
        violations={violations}
        blacklistedCount={blacklistedCount}
        paused={paused}
        speedMultiplier={speedMultiplier}
        trafficReport={trafficReport}
        controls={controls}
      />
      <AiDebugPanel ai={snapshot.aiDebug} />
    </main>
  );
}
