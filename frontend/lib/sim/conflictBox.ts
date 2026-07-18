import { INTERSECTION_HALF, ROUTE_LIST, sampleAt, type Route } from "@/lib/sim/roadGraph";

/**
 * Conflict box / reservation system (Spec Part 3).
 *
 * The intersection square is partitioned into a small uniform grid of conflict
 * zones. Each route pre-computes the set of zones its path crosses. Before a
 * vehicle may enter the box it must reserve every zone on its route; a zone can
 * be held by only one vehicle at a time, so conflicting routes (straight vs
 * crossing left-turn, etc.) are serialised automatically. A zone is released
 * only when the whole vehicle body has cleared it, preventing mid-box locking.
 */

/** Grid resolution across the intersection box (GRID x GRID zones). */
const GRID = 3;
const CELL = (INTERSECTION_HALF * 2) / GRID;

/** Map a world point inside the box to a zone id, or null if outside the box. */
export function zoneAt(x: number, z: number): string | null {
  if (x < -INTERSECTION_HALF || x > INTERSECTION_HALF || z < -INTERSECTION_HALF || z > INTERSECTION_HALF) {
    return null;
  }
  const cx = Math.min(GRID - 1, Math.floor((x + INTERSECTION_HALF) / CELL));
  const cz = Math.min(GRID - 1, Math.floor((z + INTERSECTION_HALF) / CELL));
  return `z_${cx}_${cz}`;
}

/**
 * Sample a route's path densely and collect every conflict zone it touches,
 * in the order first encountered. Sampling step is a fraction of the cell so we
 * never skip a zone the path clips through.
 */
export function computeRouteZones(route: Route): string[] {
  const zones: string[] = [];
  const step = CELL / 4;
  for (let progress = 0; progress <= route.path.length; progress += step) {
    const sample = sampleAt(route.path, progress);
    const zone = zoneAt(sample.x, sample.z);
    if (zone && !zones.includes(zone)) zones.push(zone);
  }
  return zones;
}

/** Populate `route.conflictZones` for every route in the graph (idempotent). */
export function initRouteConflictZones(): void {
  for (const route of ROUTE_LIST) {
    if (route.conflictZones.length === 0) {
      route.conflictZones = computeRouteZones(route);
    }
  }
}

/** Two routes conflict if their zone sets intersect. */
export function routesConflict(a: Route, b: Route): boolean {
  return a.conflictZones.some((zone) => b.conflictZones.includes(zone));
}

/**
 * Tracks which vehicle currently owns each conflict zone. Reservation is
 * all-or-nothing: a vehicle either grabs every zone it needs or none.
 */
export class ConflictRegistry {
  /** zone id -> owning vehicle id. */
  private readonly owners = new Map<string, string>();

  /** True if every zone in `zones` is free or already owned by `vehicleId`. */
  canReserve(zones: string[], vehicleId: string): boolean {
    for (const zone of zones) {
      const owner = this.owners.get(zone);
      if (owner !== undefined && owner !== vehicleId) return false;
    }
    return true;
  }

  /** Reserve all zones for a vehicle. Assumes canReserve() was checked. */
  reserve(zones: string[], vehicleId: string): void {
    for (const zone of zones) this.owners.set(zone, vehicleId);
  }

  /** Release exactly the given zones if owned by this vehicle. */
  release(zones: string[], vehicleId: string): void {
    for (const zone of zones) {
      if (this.owners.get(zone) === vehicleId) this.owners.delete(zone);
    }
  }

  /** Release every zone held by a vehicle (used on despawn). */
  releaseAll(vehicleId: string): void {
    for (const [zone, owner] of this.owners) {
      if (owner === vehicleId) this.owners.delete(zone);
    }
  }

  /** Whether any zone is currently reserved (box non-empty). */
  get occupied(): boolean {
    return this.owners.size > 0;
  }

  clear(): void {
    this.owners.clear();
  }
}
