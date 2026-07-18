"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { useEffect } from "react";

import { TrafficLights } from "@/components/TrafficLights";
import { VehicleManager, type VehicleManagerHandle } from "@/components/VehicleManager";
import type { EngineSnapshot } from "@/lib/sim/engine";
import { APPROACH_LENGTH, INTERSECTION_HALF, LANE_OFFSET } from "@/lib/sim/roadGraph";
import type {
  CountdownMap,
  DetectionBox,
  DirectionTrafficCounts,
  QueueCounts,
  SignalMap,
  TrafficReport
} from "@/types/traffic";

// Camera pulled back and up so the whole enlarged intersection stays in frame.
const CAMERA_POSITION: [number, number, number] = [46, 52, 46];

// Geometry derived from the sim so the road always matches where vehicles drive.
const ARM = INTERSECTION_HALF + APPROACH_LENGTH; // half-length of each road arm
const ROAD_SPAN = ARM * 2; // full road length across the map
const ROAD_WIDTH = (LANE_OFFSET + 1.2) * 2; // two lanes + shoulder
const GROUND = ROAD_SPAN + 24; // ground plane a bit larger than the roads

interface Map3DProps {
  signals: SignalMap;
  countdowns: CountdownMap;
  onDetections: (boxes: DetectionBox[]) => void;
  onQueuesChange: (queues: QueueCounts) => void;
  onTrafficCounts: (counts: DirectionTrafficCounts) => void;
  onTrafficReport: (report: TrafficReport) => void;
  onFpsChange: (fps: number) => void;
  onSnapshot: (snapshot: EngineSnapshot) => void;
  bindEngine: (handle: VehicleManagerHandle) => void;
}

function FixedCctvCamera() {
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    camera.position.set(...CAMERA_POSITION);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }, [camera]);

  return null;
}

function RoadMarking({
  position,
  scale,
  color = "#f7d774"
}: {
  position: [number, number, number];
  scale: [number, number, number];
  color?: string;
}) {
  return (
    <mesh position={position} scale={scale} frustumCulled>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} roughness={0.72} />
    </mesh>
  );
}

/**
 * A flat directional chevron painted on the tarmac to show which way a lane
 * flows (phân luồng). `yaw` rotates the arrow to point along the lane's travel.
 */
function LaneArrow({ position, yaw }: { position: [number, number, number]; yaw: number }) {
  return (
    <group position={position} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0, 0.55]} frustumCulled>
        <boxGeometry args={[0.16, 0.02, 1.4]} />
        <meshStandardMaterial color="#e8eef7" roughness={0.6} />
      </mesh>
      <mesh position={[0.28, 0, 1.15]} rotation={[0, Math.PI / 4, 0]} frustumCulled>
        <boxGeometry args={[0.16, 0.02, 0.7]} />
        <meshStandardMaterial color="#e8eef7" roughness={0.6} />
      </mesh>
      <mesh position={[-0.28, 0, 1.15]} rotation={[0, -Math.PI / 4, 0]} frustumCulled>
        <boxGeometry args={[0.16, 0.02, 0.7]} />
        <meshStandardMaterial color="#e8eef7" roughness={0.6} />
      </mesh>
    </group>
  );
}

function IntersectionEnvironment() {
  const zebra = Array.from({ length: 7 }, (_, i) => -4.5 + i * 1.5);
  // Dashed centre-line offsets along each arm (skip the intersection box).
  const dashStart = INTERSECTION_HALF + 2;
  const dashes = Array.from({ length: 8 }, (_, i) => dashStart + i * 4.5).filter((d) => d < ARM - 1);
  const arrowStart = INTERSECTION_HALF + 4;

  return (
    <group>
      {/* Grass / ground */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow frustumCulled>
        <planeGeometry args={[GROUND, GROUND]} />
        <meshStandardMaterial color="#1f3a2a" roughness={1} />
      </mesh>

      {/* Two crossing asphalt roads */}
      <mesh position={[0, 0.015, 0]} receiveShadow frustumCulled>
        <boxGeometry args={[ROAD_WIDTH, 0.03, ROAD_SPAN]} />
        <meshStandardMaterial color="#2b2f36" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.02, 0]} receiveShadow frustumCulled>
        <boxGeometry args={[ROAD_SPAN, 0.04, ROAD_WIDTH]} />
        <meshStandardMaterial color="#2b2f36" roughness={0.9} />
      </mesh>

      {/* Stop bars at each approach edge of the box */}
      <RoadMarking position={[0, 0.06, INTERSECTION_HALF]} scale={[ROAD_WIDTH, 0.04, 0.3]} />
      <RoadMarking position={[0, 0.06, -INTERSECTION_HALF]} scale={[ROAD_WIDTH, 0.04, 0.3]} />
      <RoadMarking position={[INTERSECTION_HALF, 0.06, 0]} scale={[0.3, 0.04, ROAD_WIDTH]} />
      <RoadMarking position={[-INTERSECTION_HALF, 0.06, 0]} scale={[0.3, 0.04, ROAD_WIDTH]} />

      {/* Dashed centre dividers separating the two travel directions on each arm */}
      {dashes.flatMap((d) => [
        <RoadMarking key={`cn-${d}`} position={[0, 0.05, -d]} scale={[0.18, 0.02, 2]} color="#d7dee8" />,
        <RoadMarking key={`cs-${d}`} position={[0, 0.05, d]} scale={[0.18, 0.02, 2]} color="#d7dee8" />,
        <RoadMarking key={`ce-${d}`} position={[d, 0.05, 0]} scale={[2, 0.02, 0.18]} color="#d7dee8" />,
        <RoadMarking key={`cw-${d}`} position={[-d, 0.05, 0]} scale={[2, 0.02, 0.18]} color="#d7dee8" />
      ])}

      {/* Lane-flow arrows: one per inbound approach, pointing toward the box */}
      <LaneArrow position={[LANE_OFFSET, 0.06, arrowStart]} yaw={Math.PI} />
      <LaneArrow position={[-LANE_OFFSET, 0.06, -arrowStart]} yaw={0} />
      <LaneArrow position={[-arrowStart, 0.06, LANE_OFFSET]} yaw={Math.PI / 2} />
      <LaneArrow position={[arrowStart, 0.06, -LANE_OFFSET]} yaw={-Math.PI / 2} />

      {/* Zebra crossings on all four approaches */}
      {zebra.map((o) => (
        <RoadMarking key={`zn-${o}`} position={[o, 0.06, INTERSECTION_HALF - 0.9]} scale={[0.72, 0.02, 0.75]} color="#e8eef7" />
      ))}
      {zebra.map((o) => (
        <RoadMarking key={`zs-${o}`} position={[o, 0.06, -INTERSECTION_HALF + 0.9]} scale={[0.72, 0.02, 0.75]} color="#e8eef7" />
      ))}
      {zebra.map((o) => (
        <RoadMarking key={`ze-${o}`} position={[INTERSECTION_HALF - 0.9, 0.06, o]} scale={[0.75, 0.02, 0.72]} color="#e8eef7" />
      ))}
      {zebra.map((o) => (
        <RoadMarking key={`zw-${o}`} position={[-INTERSECTION_HALF + 0.9, 0.06, o]} scale={[0.75, 0.02, 0.72]} color="#e8eef7" />
      ))}
    </group>
  );
}

export function Map3D({
  signals,
  countdowns,
  onDetections,
  onQueuesChange,
  onTrafficCounts,
  onTrafficReport,
  onFpsChange,
  onSnapshot,
  bindEngine
}: Map3DProps) {
  return (
    <Canvas
      className="h-full w-full"
      camera={{ fov: 46, near: 0.1, far: 260, position: CAMERA_POSITION }}
      dpr={[1, 1.5]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
    >
      <color attach="background" args={["#09131f"]} />
      <ambientLight intensity={1.6} />
      <directionalLight position={[16, 28, 12]} intensity={2.5} />
      <FixedCctvCamera />
      <IntersectionEnvironment />
      <TrafficLights signals={signals} countdowns={countdowns} />
      <VehicleManager
        onDetections={onDetections}
        onQueuesChange={onQueuesChange}
        onTrafficCounts={onTrafficCounts}
        onTrafficReport={onTrafficReport}
        onFpsChange={onFpsChange}
        onSnapshot={onSnapshot}
        bindEngine={bindEngine}
      />
    </Canvas>
  );
}
