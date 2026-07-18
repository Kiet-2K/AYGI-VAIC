"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Vector3 } from "three";

import { projectWorldBoundingBox } from "@/lib/projection";
import { toDetection } from "@/lib/sim/detectionAdapter";
import { SimulationEngine, type EngineSnapshot } from "@/lib/sim/engine";
import type { Vehicle } from "@/lib/sim/vehicle";
import { VEHICLE_CLASSES } from "@/lib/sim/vehicleClasses";
import type { DetectionBox, DirectionTrafficCounts, QueueCounts, SignalState, TrafficReport } from "@/types/traffic";

const DETECTION_UPDATE_SECONDS = 1 / 30;
const SNAPSHOT_UPDATE_SECONDS = 0.1;

export interface VehicleManagerHandle {
  requestNextPhase: () => void;
  setManual: (manual: boolean) => void;
  emergencyAllRed: () => void;
  clearEmergency: () => void;
  reset: () => void;
  applySignalState: (state: SignalState | null) => void;
}

interface VehicleManagerProps {
  onDetections: (boxes: DetectionBox[]) => void;
  onQueuesChange: (queues: QueueCounts) => void;
  onTrafficCounts: (counts: DirectionTrafficCounts) => void;
  onTrafficReport: (report: TrafficReport) => void;
  onFpsChange: (fps: number) => void;
  onSnapshot: (snapshot: EngineSnapshot) => void;
  bindEngine: (handle: VehicleManagerHandle) => void;
}

/**
 * One vehicle mesh, sized/coloured by class (Spec Part 7). The group's transform
 * is bound imperatively to the engine's vehicle every frame, so per-vehicle
 * React state is never touched inside the RAF loop (Spec: performance).
 */
function VehicleModel({ vehicle }: { vehicle: Vehicle }) {
  const spec = VEHICLE_CLASSES[vehicle.cls];
  const bindObject = useCallback(
    (object: Group | null) => {
      vehicle.object = object;
    },
    [vehicle]
  );

  return (
    <group ref={bindObject} position={[vehicle.x, 0, vehicle.z]} rotation={[0, vehicle.yaw, 0]}>
      <mesh position={[0, spec.height / 2, 0]} frustumCulled>
        <boxGeometry args={[spec.width, spec.height, spec.length]} />
        <meshStandardMaterial color={spec.color} roughness={0.5} metalness={0.08} />
      </mesh>
      <mesh position={[0, spec.height + 0.05, -spec.length * 0.05]} scale={[1, 1, 0.6]} frustumCulled>
        <boxGeometry args={[spec.width * 0.8, spec.height * 0.45, spec.length * 0.7]} />
        <meshStandardMaterial color="#b9e9ff" roughness={0.25} metalness={0.15} />
      </mesh>
      {/* Emergency/priority vehicles get a glowing roof beacon so they read as
          siren vehicles at a glance (Spec Part 4+). */}
      {spec.emergency ? (
        <mesh position={[0, spec.height + 0.28, 0]} frustumCulled>
          <boxGeometry args={[spec.width * 0.5, 0.22, 0.4]} />
          <meshStandardMaterial color="#ff2d2d" emissive="#ff2d2d" emissiveIntensity={2.4} />
        </mesh>
      ) : null}
    </group>
  );
}

// The engine's Vehicle gains an optional `object` handle for the bound mesh.
declare module "@/lib/sim/vehicle" {
  interface Vehicle {
    object?: Group | null;
  }
}

export function VehicleManager({
  onDetections,
  onQueuesChange,
  onTrafficCounts,
  onTrafficReport,
  onFpsChange,
  onSnapshot,
  bindEngine
}: VehicleManagerProps) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const engine = useMemo(() => new SimulationEngine(), []);
  const detectionClockRef = useRef(0);
  const snapshotClockRef = useRef(0);
  const fpsClockRef = useRef(0);
  const frameCountRef = useRef(0);
  const dimsRef = useRef(new Vector3());
  const rosterSizeRef = useRef(0);
  const [, setRenderRevision] = useState(0);

  // Expose imperative controls to the parent (dashboard buttons).
  useEffect(() => {
    bindEngine({
      requestNextPhase: () => engine.requestNextPhase(),
      setManual: (manual: boolean) => engine.setManual(manual),
      emergencyAllRed: () => engine.emergencyAllRed(),
      clearEmergency: () => engine.clearEmergency(),
      reset: () => {
        engine.reset();
        setRenderRevision((r) => r + 1);
      },
      applySignalState: (state) => engine.applySignalState(state)
    });
  }, [engine, bindEngine]);

  useFrame((_state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    engine.tick(delta);

    // Bind mesh transforms imperatively (no React state per vehicle per frame).
    for (const vehicle of engine.vehicles) {
      if (vehicle.object) {
        vehicle.object.position.set(vehicle.x, 0, vehicle.z);
        vehicle.object.rotation.y = vehicle.yaw;
        vehicle.object.updateMatrixWorld(true);
      }
    }
    // Re-render only when the roster size changes (spawn/despawn), never per-move.
    if (engine.vehicles.length !== rosterSizeRef.current) {
      rosterSizeRef.current = engine.vehicles.length;
      setRenderRevision((r) => r + 1);
    }

    detectionClockRef.current += delta;
    snapshotClockRef.current += delta;
    fpsClockRef.current += delta;
    frameCountRef.current += 1;

    if (detectionClockRef.current >= DETECTION_UPDATE_SECONDS) {
      detectionClockRef.current = 0;
      camera.updateMatrixWorld();
      const detections: DetectionBox[] = [];
      for (const vehicle of engine.vehicles) {
        if (!vehicle.object) continue;
        const spec = VEHICLE_CLASSES[vehicle.cls];
        dimsRef.current.set(spec.width, spec.height, spec.length);
        const bounds = projectWorldBoundingBox(vehicle.object.matrixWorld, dimsRef.current, camera, size);
        if (bounds) detections.push(toDetection(vehicle, bounds));
      }
      onDetections(detections);
      onQueuesChange(engine.queueCounts());
      onTrafficCounts(engine.trafficCounts());
    }

    if (snapshotClockRef.current >= SNAPSHOT_UPDATE_SECONDS) {
      snapshotClockRef.current = 0;
      onSnapshot(engine.snapshot());
      onTrafficReport(engine.trafficReport());
    }

    if (fpsClockRef.current >= 0.5) {
      onFpsChange(Math.round(frameCountRef.current / fpsClockRef.current));
      fpsClockRef.current = 0;
      frameCountRef.current = 0;
    }
  });

  return (
    <group>
      {engine.vehicles.map((vehicle) => (
        <VehicleModel key={vehicle.id} vehicle={vehicle} />
      ))}
    </group>
  );
}
