"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { AiDebugPanel } from "@/components/AiDebugPanel";
import { FakeYoloOverlay, type DetectionSink } from "@/components/FakeYoloOverlay";
import { TrafficDashboard } from "@/components/TrafficDashboard";
import type { VehicleManagerHandle } from "@/components/VehicleManager";
import { useTrafficSocket } from "@/hooks/useTrafficSocket";
import { EMPTY_DIRECTION_STATS } from "@/lib/sim/adaptiveController";
import type { EngineSnapshot } from "@/lib/sim/engine";
import {
  BLANK_COUNTDOWNS,
  EMPTY_TRAFFIC_COUNTS,
  SAFE_SIGNALS,
  type DetectionBox,
  type DirectionTrafficCounts,
  type TrafficReport
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
  const detectionSinkRef = useRef<DetectionSink>(() => undefined);
  const engineRef = useRef<VehicleManagerHandle | null>(null);
  const { connectionState, signalState, latencyMs, pendingCommand, error, sendCommand } =
    useTrafficSocket(trafficReport);

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

  const controls = {
    onRequestNext: () => sendCommand("NEXT"),
    onManual: () => sendCommand("MANUAL"),
    onAuto: () => sendCommand("AUTO"),
    onEmergency: () => sendCommand("ALL_RED"),
    onClearEmergency: () => sendCommand("CLEAR_ALL_RED"),
    onReset: () => sendCommand("RESET")
  };

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <Map3D
        signals={snapshot.signals}
        countdowns={snapshot.countdowns}
        onDetections={publishDetections}
        onQueuesChange={() => undefined}
        onTrafficCounts={updateTrafficCounts}
        onTrafficReport={setTrafficReport}
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
        controls={controls}
      />
      <AiDebugPanel ai={snapshot.aiDebug} />
    </main>
  );
}
