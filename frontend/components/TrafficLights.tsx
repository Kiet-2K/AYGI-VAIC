import { useEffect, useMemo, useRef } from "react";
import { CanvasTexture, type Mesh } from "three";

import type { CountdownMap, Direction, DirectionCountdown, SignalColor, SignalMap } from "@/types/traffic";

const lightPositions: Record<Direction, [number, number, number]> = {
  north: [-5.2, 2.4, 6.5],
  south: [5.2, 2.4, -6.5],
  east: [6.5, 2.4, 5.2],
  west: [-6.5, 2.4, -5.2]
};

/** Yaw so each signal head's face (and its countdown board) turns toward the intersection centre. */
const headingYaw: Record<Direction, number> = {
  north: Math.PI,
  south: 0,
  east: -Math.PI / 2,
  west: Math.PI / 2
};

const BULB_COLORS: Record<SignalColor, string> = {
  RED: "#ff4d4d",
  YELLOW: "#ffd84d",
  GREEN: "#4dff88"
};

function SignalBulb({ color, active }: { color: SignalColor; active: boolean }) {
  return (
    <mesh frustumCulled>
      <sphereGeometry args={[0.23, 12, 12]} />
      <meshStandardMaterial
        color={active ? BULB_COLORS[color] : "#26313a"}
        emissive={active ? BULB_COLORS[color] : "#000000"}
        emissiveIntensity={active ? 2.5 : 0}
      />
    </mesh>
  );
}

/**
 * A digital countdown board mounted under each signal head. The number is drawn
 * into a 2D canvas and uploaded as a texture, so it stays crisp without pulling
 * in any extra 3D-text dependency. Colour follows the head's live signal.
 */
function CountdownBoard({ seconds, signal, visible }: { seconds: number; signal: SignalColor; visible: boolean }) {
  const meshRef = useRef<Mesh>(null);
  const canvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 128;
    return c;
  }, []);
  const texture = useMemo(() => new CanvasTexture(canvas), [canvas]);

  useEffect(() => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = "#04070d";
    ctx.fillRect(0, 0, 128, 128);
    // Blank until the AI serves (or commits to serve) this movement: the board
    // stays dark with no number so the counter "không hiện cho tới khi AI xử lí".
    if (visible) {
      ctx.fillStyle = BULB_COLORS[signal];
      ctx.font = "bold 88px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = BULB_COLORS[signal];
      ctx.shadowBlur = 16;
      // Cap at 99 so a runaway value can never overflow the two-digit board.
      ctx.fillText(String(Math.min(99, Math.max(0, Math.round(seconds)))), 64, 70);
    }
    texture.needsUpdate = true;
  }, [seconds, signal, visible, canvas, texture]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh ref={meshRef} position={[0, -0.95, 0.3]} frustumCulled>
      <planeGeometry args={[0.62, 0.62]} />
      <meshBasicMaterial map={texture} toneMapped={false} transparent />
    </mesh>
  );
}

function SignalHead({
  direction,
  signal,
  countdown
}: {
  direction: Direction;
  signal: SignalColor;
  countdown: DirectionCountdown;
}) {
  return (
    <group position={lightPositions[direction]} rotation={[0, headingYaw[direction], 0]}>
      <mesh position={[0, -1.15, 0]} frustumCulled>
        <cylinderGeometry args={[0.09, 0.13, 2.4, 8]} />
        <meshStandardMaterial color="#1b2632" />
      </mesh>
      <mesh frustumCulled>
        <boxGeometry args={[0.78, 1.78, 0.48]} />
        <meshStandardMaterial color="#111b25" roughness={0.65} />
      </mesh>
      <group position={[0, 0.55, 0.28]}>
        <SignalBulb color="RED" active={signal === "RED"} />
      </group>
      <group position={[0, 0, 0.28]}>
        <SignalBulb color="YELLOW" active={signal === "YELLOW"} />
      </group>
      <group position={[0, -0.55, 0.28]}>
        <SignalBulb color="GREEN" active={signal === "GREEN"} />
      </group>
      {/* Each head owns its own countdown; blank until the AI serves this movement. */}
      <CountdownBoard seconds={countdown.seconds} signal={countdown.color} visible={countdown.visible} />
    </group>
  );
}

export function TrafficLights({ signals, countdowns }: { signals: SignalMap; countdowns: CountdownMap }) {
  return (
    <group>
      {(Object.keys(lightPositions) as Direction[]).map((direction) => (
        <SignalHead
          key={direction}
          direction={direction}
          signal={signals[direction]}
          countdown={countdowns[direction]}
        />
      ))}
    </group>
  );
}
