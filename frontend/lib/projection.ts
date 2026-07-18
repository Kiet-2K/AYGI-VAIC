import { Camera, Matrix4, Vector3 } from "three";

export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Project the eight local bounding-box corners through the active R3F camera. */
export function projectWorldBoundingBox(
  matrixWorld: Matrix4,
  dimensions: Vector3,
  camera: Camera,
  viewport: { width: number; height: number }
): ScreenBounds | null {
  const halfWidth = dimensions.x / 2;
  const halfLength = dimensions.z / 2;
  const localCorners = [
    [-halfWidth, 0, -halfLength],
    [halfWidth, 0, -halfLength],
    [-halfWidth, 0, halfLength],
    [halfWidth, 0, halfLength],
    [-halfWidth, dimensions.y, -halfLength],
    [halfWidth, dimensions.y, -halfLength],
    [-halfWidth, dimensions.y, halfLength],
    [halfWidth, dimensions.y, halfLength]
  ];

  const projected: Vector3[] = [];
  for (const [x, y, z] of localCorners) {
    const world = new Vector3(x, y, z).applyMatrix4(matrixWorld);
    const cameraSpace = world.clone().applyMatrix4(camera.matrixWorldInverse);
    if (cameraSpace.z >= 0) continue;
    projected.push(world.project(camera));
  }

  if (projected.length === 0) return null;

  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));

  if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) return null;

  const x = ((minX + 1) / 2) * viewport.width;
  const y = ((1 - maxY) / 2) * viewport.height;
  const width = ((maxX - minX) / 2) * viewport.width;
  const height = ((maxY - minY) / 2) * viewport.height;

  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}
