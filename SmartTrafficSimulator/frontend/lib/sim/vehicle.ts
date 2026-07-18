import type { Route } from "@/lib/sim/roadGraph";
import { sampleAt, yawFromTangent } from "@/lib/sim/roadGraph";
import type { VehicleClass } from "@/lib/sim/vehicleClasses";
import { VEHICLE_CLASSES } from "@/lib/sim/vehicleClasses";

/**
 * Vehicle physics & car-following (Spec Part 2).
 *
 * Longitudinal motion uses the Intelligent Driver Model (IDM), a well-known
 * time-continuous car-following model. Each vehicle owns its own physical
 * state and always moves by advancing `progress` (arc length) along its
 * immutable route path — never by mutating x/y independently. Position and yaw
 * are derived from the path tangent, guaranteeing vehicles stay in-lane and
 * turn along the Bézier curve.
 */

export type VehicleStatus = "DRIVING" | "FOLLOWING" | "WAITING_SIGNAL" | "WAITING_CONFLICT" | "CLEARING";

export interface Vehicle {
  id: string;
  trackId: number;
  cls: VehicleClass;
  route: Route;

  /** Arc-length position of the front bumper along the route path. */
  progress: number;
  speed: number;
  status: VehicleStatus;

  // Cached physical envelope (copied from the class table for quick access).
  length: number;
  width: number;
  maxSpeed: number;
  maxAccel: number;
  comfortBrake: number;
  minGap: number;

  // Derived render transform (world plane; y handled by the mesh).
  x: number;
  z: number;
  yaw: number;

  confidence: number;
  reactionTime: number;

  // Conflict-box bookkeeping (Spec Part 3): zones this vehicle currently holds.
  reservedZones: string[];
  hasReserved: boolean;

  // Wrong-way bookkeeping (Spec Part 9).
  wrongWayFrames: number;
  wrongWay: boolean;
  spawnProgress: number;

  /**
   * Real accumulated stopped/queued time (seconds) since this vehicle last
   * started waiting at the stop line. Reset to 0 once it clears the line. Feeds
   * the adaptive controller's true starvation metric (replaces the old faked
   * queue-size proxy).
   */
  waitTime: number;
  /** True for priority vehicles (ambulance / fire / police / military). */
  emergency: boolean;
  licensePlate: string;
  redLightViolation: boolean;
  /** Demo-only flag: bypasses the stop-line wall while preserving violation detection. */
  forceRedLightViolation: boolean;
}

/** IDM free-flow acceleration exponent. */
const IDM_DELTA = 4;

export interface VehicleInit {
  id: string;
  trackId: number;
  cls: VehicleClass;
  route: Route;
  confidence: number;
  reactionTime: number;
  emergency?: boolean;
  licensePlate?: string;
}

export function createVehicle(init: VehicleInit): Vehicle {
  const spec = VEHICLE_CLASSES[init.cls];
  const sample = sampleAt(init.route.path, 0);
  return {
    id: init.id,
    trackId: init.trackId,
    cls: init.cls,
    route: init.route,
    progress: 0,
    speed: 0,
    status: "DRIVING",
    length: spec.length,
    width: spec.width,
    maxSpeed: spec.maxSpeed,
    maxAccel: spec.maxAccel,
    comfortBrake: spec.comfortBrake,
    minGap: spec.minGap,
    x: sample.x,
    z: sample.z,
    yaw: yawFromTangent(sample.tangentX, sample.tangentZ),
    confidence: init.confidence,
    reactionTime: init.reactionTime,
    reservedZones: [],
    hasReserved: false,
    wrongWayFrames: 0,
    wrongWay: false,
    spawnProgress: 0,
    waitTime: 0,
    emergency: init.emergency ?? false,
    licensePlate: init.licensePlate ?? "00000",
    redLightViolation: false,
    forceRedLightViolation: false
  };
}

/**
 * IDM desired-gap term s*(v, Δv):
 *   s* = s0 + max(0, v·T + v·Δv / (2·sqrt(a·b)))
 * where s0=minGap, T=reaction time, a=maxAccel, b=comfortBrake, Δv=approach rate.
 */
export function desiredGap(
  speed: number,
  approachRate: number,
  minGap: number,
  reactionTime: number,
  maxAccel: number,
  comfortBrake: number
): number {
  const dynamic = speed * reactionTime + (speed * approachRate) / (2 * Math.sqrt(maxAccel * comfortBrake));
  return minGap + Math.max(0, dynamic);
}

/**
 * IDM acceleration.
 * @param gap   bumper-to-bumper distance to the obstacle ahead (leader or virtual).
 * @param leaderSpeed speed of the obstacle (0 for a stop line / stopped car).
 * @param hasObstacle when false, only the free-road term applies.
 */
export function idmAcceleration(
  vehicle: Pick<Vehicle, "speed" | "maxSpeed" | "maxAccel" | "comfortBrake" | "minGap" | "reactionTime">,
  gap: number,
  leaderSpeed: number,
  hasObstacle: boolean
): number {
  const { speed, maxSpeed, maxAccel, comfortBrake, minGap, reactionTime } = vehicle;
  const freeRoad = 1 - Math.pow(speed / maxSpeed, IDM_DELTA);

  let interaction = 0;
  if (hasObstacle) {
    const approachRate = speed - leaderSpeed;
    const star = desiredGap(speed, approachRate, minGap, reactionTime, maxAccel, comfortBrake);
    // Guard against divide-by-zero when the leader is bumper-to-bumper.
    const safeGap = Math.max(gap, 0.05);
    interaction = Math.pow(star / safeGap, 2);
  }

  return maxAccel * (freeRoad - interaction);
}

/**
 * Integrate one vehicle for `dt` seconds given the nearest constraining
 * obstacle ahead. `obstacleProgress` is the arc-length of the obstacle's
 * relevant edge (leader rear bumper, or stop line). Returns nothing; mutates.
 */
export function integrateVehicle(
  vehicle: Vehicle,
  dt: number,
  obstacle: { progress: number; speed: number } | null
): void {
  let gap = Number.POSITIVE_INFINITY;
  let leaderSpeed = 0;
  const hasObstacle = obstacle !== null;
  if (obstacle) {
    // Gap is measured front-bumper (this vehicle) to obstacle edge, minus our half?
    // progress tracks the front bumper, obstacle.progress is the obstacle's rear edge.
    gap = obstacle.progress - vehicle.progress;
    leaderSpeed = obstacle.speed;
  }

  const accel = idmAcceleration(vehicle, gap, leaderSpeed, hasObstacle);
  const clampedAccel = Math.max(-vehicle.comfortBrake * 2.5, Math.min(vehicle.maxAccel, accel));

  let nextSpeed = vehicle.speed + clampedAccel * dt;
  if (nextSpeed < 0) nextSpeed = 0;

  let nextProgress = vehicle.progress + nextSpeed * dt;

  // Hard safety clamp: never let the front bumper pass the obstacle edge.
  if (obstacle && nextProgress > obstacle.progress) {
    nextProgress = obstacle.progress;
    nextSpeed = Math.min(nextSpeed, leaderSpeed);
  }
  if (nextProgress < vehicle.progress) nextProgress = vehicle.progress;

  vehicle.progress = nextProgress;
  vehicle.speed = nextSpeed;

  const sample = sampleAt(vehicle.route.path, nextProgress);
  vehicle.x = sample.x;
  vehicle.z = sample.z;
  vehicle.yaw = yawFromTangent(sample.tangentX, sample.tangentZ);
}
