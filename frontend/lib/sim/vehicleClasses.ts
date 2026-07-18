/**
 * Vehicle classification & PCU table (Spec Part 7).
 *
 * Each class carries its own physical envelope and dynamics so the
 * car-following model and the PCU-weighted controller behave differently for a
 * scooter than for a heavy truck. PCU (Passenger Car Unit) values are the
 * standard way to express mixed-traffic load as an equivalent number of cars;
 * they are intentionally kept in one editable table.
 */

export type VehicleClass =
  | "MOTORBIKE"
  | "CAR"
  | "BUS"
  | "TRUCK"
  | "HEAVY_TRUCK"
  | "AMBULANCE"
  | "FIRE_TRUCK"
  | "POLICE"
  | "MILITARY";

export interface VehicleClassSpec {
  /** Body length along the direction of travel (world units, ~metres). */
  length: number;
  /** Body width across the direction of travel. */
  width: number;
  /** Body height (visual only). */
  height: number;
  /** Top speed (units/s). */
  maxSpeed: number;
  /** Comfortable acceleration (units/s^2). */
  maxAccel: number;
  /** Comfortable braking deceleration, positive magnitude (units/s^2). */
  comfortBrake: number;
  /** Minimum standstill gap to the leader (units). */
  minGap: number;
  /** Passenger-car-equivalent load. */
  pcu: number;
  /** Base mesh colour. */
  color: string;
  /** Priority vehicle: triggers signal preemption when approaching (Spec Part 4+). */
  emergency?: boolean;
}

/**
 * Tunable class table. Values are chosen so heavier vehicles are longer,
 * slower to accelerate, and weaker at braking, and so their PCU rises with
 * footprint — a bus/truck loads the queue far more than a motorbike.
 */
export const VEHICLE_CLASSES: Record<VehicleClass, VehicleClassSpec> = {
  MOTORBIKE: {
    length: 1.9,
    width: 0.8,
    height: 1.1,
    maxSpeed: 8.5,
    maxAccel: 3.4,
    comfortBrake: 4.2,
    minGap: 1.1,
    pcu: 0.3,
    color: "#f472b6"
  },
  CAR: {
    length: 3.4,
    width: 1.6,
    height: 1.3,
    maxSpeed: 7.5,
    maxAccel: 2.6,
    comfortBrake: 3.4,
    minGap: 1.8,
    pcu: 1,
    color: "#60a5fa"
  },
  BUS: {
    length: 7.2,
    width: 2.3,
    height: 2.6,
    maxSpeed: 5.6,
    maxAccel: 1.4,
    comfortBrake: 2.4,
    minGap: 2.6,
    pcu: 2.5,
    color: "#facc15"
  },
  TRUCK: {
    length: 6.4,
    width: 2.2,
    height: 2.5,
    maxSpeed: 5.8,
    maxAccel: 1.5,
    comfortBrake: 2.5,
    minGap: 2.5,
    pcu: 2.2,
    color: "#fb923c"
  },
  HEAVY_TRUCK: {
    length: 9.0,
    width: 2.4,
    height: 2.8,
    maxSpeed: 5.0,
    maxAccel: 1.1,
    comfortBrake: 2.1,
    minGap: 3.0,
    pcu: 3.5,
    color: "#f43f5e"
  },
  // --- Emergency / priority vehicles (Spec Part 4+) ---
  // They accelerate a little harder and run a touch faster than their civilian
  // equivalents, and are flagged `emergency` so the engine preempts the signal
  // for their movement. Colours are chosen to read as siren vehicles.
  AMBULANCE: {
    length: 4.6,
    width: 1.9,
    height: 2.1,
    maxSpeed: 8.0,
    maxAccel: 3.0,
    comfortBrake: 4.0,
    minGap: 2.0,
    pcu: 1.6,
    color: "#f8fafc",
    emergency: true
  },
  FIRE_TRUCK: {
    length: 8.2,
    width: 2.4,
    height: 2.9,
    maxSpeed: 6.5,
    maxAccel: 2.0,
    comfortBrake: 3.0,
    minGap: 2.6,
    pcu: 3.0,
    color: "#dc2626",
    emergency: true
  },
  POLICE: {
    length: 3.6,
    width: 1.7,
    height: 1.4,
    maxSpeed: 9.0,
    maxAccel: 3.4,
    comfortBrake: 4.2,
    minGap: 1.8,
    pcu: 1.0,
    color: "#1d4ed8",
    emergency: true
  },
  MILITARY: {
    length: 6.8,
    width: 2.3,
    height: 2.7,
    maxSpeed: 6.0,
    maxAccel: 1.8,
    comfortBrake: 2.6,
    minGap: 2.6,
    pcu: 2.6,
    color: "#3f6212",
    emergency: true
  }
};

/** All emergency/priority classes (used for spawn + preemption logic). */
export const EMERGENCY_CLASSES: VehicleClass[] = ["AMBULANCE", "FIRE_TRUCK", "POLICE", "MILITARY"];

/** Whether a class is a priority/emergency vehicle. */
export const isEmergencyClass = (cls: VehicleClass): boolean => VEHICLE_CLASSES[cls].emergency === true;

/** Spawn-mix weights (roughly Southeast-Asian intersection: bike-heavy). */
const SPAWN_WEIGHTS: [VehicleClass, number][] = [
  ["MOTORBIKE", 0.44],
  ["CAR", 0.36],
  ["BUS", 0.07],
  ["TRUCK", 0.09],
  ["HEAVY_TRUCK", 0.04]
];

/** Pick a class from the spawn mix. `rng` must return [0, 1). */
export function pickVehicleClass(rng: () => number): VehicleClass {
  const roll = rng();
  let cumulative = 0;
  for (const [cls, weight] of SPAWN_WEIGHTS) {
    cumulative += weight;
    if (roll < cumulative) return cls;
  }
  return "CAR";
}

/** Pick one of the four emergency classes uniformly. `rng` must return [0, 1). */
export function pickEmergencyClass(rng: () => number): VehicleClass {
  return EMERGENCY_CLASSES[Math.min(EMERGENCY_CLASSES.length - 1, Math.floor(rng() * EMERGENCY_CLASSES.length))];
}

export const pcuOf = (cls: VehicleClass): number => VEHICLE_CLASSES[cls].pcu;
