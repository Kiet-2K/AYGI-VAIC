import type { Vec2 } from "@/lib/sim/roadGraph";

/**
 * Uniform spatial hash grid (Spec Part 2) for O(1)-ish neighbour queries.
 *
 * Used both by the final overlap guard and by anything that needs "who is near
 * this point" without scanning every vehicle. Car-following itself keys off the
 * route/lane ordering, not this grid; the grid is the cheap broad-phase.
 */
export class SpatialHash<T> {
  private readonly cellSize: number;
  private readonly cells = new Map<string, T[]>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  private key(x: number, z: number): string {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    return `${cx},${cz}`;
  }

  clear(): void {
    this.cells.clear();
  }

  insert(position: Vec2, item: T): void {
    const key = this.key(position.x, position.z);
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(item);
    else this.cells.set(key, [item]);
  }

  /** All items within the 3x3 block of cells around `position`. */
  nearby(position: Vec2): T[] {
    const cx = Math.floor(position.x / this.cellSize);
    const cz = Math.floor(position.z / this.cellSize);
    const result: T[] = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const bucket = this.cells.get(`${cx + dx},${cz + dz}`);
        if (bucket) result.push(...bucket);
      }
    }
    return result;
  }
}
