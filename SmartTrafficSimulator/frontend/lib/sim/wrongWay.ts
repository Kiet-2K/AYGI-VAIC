import { HEADING } from "@/lib/sim/roadGraph";
import type { Vehicle } from "@/lib/sim/vehicle";

/**
 * Wrong-way detection (Spec Part 9).
 *
 * Compares a vehicle's actual travel vector against the expected direction of
 * its entry lane. A flag is raised only when the deviation is sustained, to
 * avoid false positives from the transient heading swing during a legal turn:
 *   - angle vs expected lane heading > 90° (dot product < 0),
 *   - persists across >= MIN_FRAMES consecutive updates,
 *   - vehicle has travelled at least MIN_TRAVEL from spawn,
 *   - vehicle is NOT currently mid-turn on a legal LEFT/RIGHT route.
 *
 * In this simulation vehicles follow fixed legal routes, so wrong-way never
 * triggers organically — the check exists so injected/edge-case anomalies (and
 * a future real-YOLO feed) are surfaced with the same logic.
 */

const MIN_FRAMES = 8;
const MIN_TRAVEL = 3;

/**
 * Update a vehicle's wrong-way state in place. `moveX/moveZ` is the actual
 * displacement since the previous update (world plane).
 */
export function updateWrongWay(vehicle: Vehicle, moveX: number, moveZ: number): void {
  const travelled = vehicle.progress - vehicle.spawnProgress;
  const movementLength = Math.hypot(moveX, moveZ);

  // Not enough evidence yet: too little motion or too close to spawn.
  if (movementLength < 1e-4 || travelled < MIN_TRAVEL) {
    vehicle.wrongWayFrames = 0;
    vehicle.wrongWay = false;
    return;
  }

  const expected = HEADING[vehicle.route.direction];
  // Dot of normalised movement with the lane's expected heading.
  const dot = (moveX * expected.x + moveZ * expected.z) / movementLength;

  // While executing a legal turn the instantaneous heading legitimately diverges;
  // suppress the check on the curved portion of LEFT/RIGHT routes.
  const midTurn =
    vehicle.route.turn !== "STRAIGHT" &&
    vehicle.progress > vehicle.route.stopProgress &&
    vehicle.progress < vehicle.route.stopProgress + turnSpan(vehicle);

  if (dot < 0 && !midTurn) {
    vehicle.wrongWayFrames += 1;
  } else {
    vehicle.wrongWayFrames = 0;
  }

  vehicle.wrongWay = vehicle.wrongWayFrames >= MIN_FRAMES;
}

/** Approximate arc length of the turn portion inside the box. */
function turnSpan(vehicle: Vehicle): number {
  // The box crossing is a fixed geometric span; a generous constant covers it.
  return vehicle.route.path.length - vehicle.route.stopProgress;
}
