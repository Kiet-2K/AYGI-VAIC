import type { ScreenBounds } from "@/lib/projection";
import { pcuOf } from "@/lib/sim/vehicleClasses";
import type { Vehicle } from "@/lib/sim/vehicle";
import type { DetectionBox } from "@/types/traffic";

/**
 * Detection adapter (Spec Part 8).
 *
 * Bridges the internal simulation to a YOLO-like detection payload. Because
 * vehicles are simulated we never run a real model in the browser; instead we
 * translate ground-truth state into the same shape a detector would emit. This
 * is deliberately the ONLY place that mints detection metadata, so a future
 * backend feed (real YOLO/OpenCV over WebSocket) can replace it wholesale
 * without touching the overlay renderer.
 */

const STOPPED_SPEED = 0.25;

/** Build a detection record from a vehicle and its projected screen bounds. */
export function toDetection(vehicle: Vehicle, bounds: ScreenBounds): DetectionBox {
  const stopped = vehicle.speed < STOPPED_SPEED;
  return {
    id: vehicle.id,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    // `waiting` retained for backward compatibility with the existing overlay.
    waiting: stopped,
    confidence: vehicle.confidence,
    trackId: vehicle.trackId,
    vehicleClass: vehicle.cls,
    laneId: vehicle.route.entryLaneId,
    direction: vehicle.route.direction,
    speed: vehicle.speed,
    pcu: pcuOf(vehicle.cls),
    stopped,
    wrongWay: vehicle.wrongWay,
    emergency: vehicle.emergency,
    licensePlate: vehicle.licensePlate,
    redLightViolation: vehicle.redLightViolation
  };
}
