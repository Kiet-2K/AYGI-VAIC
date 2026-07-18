import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { projectWorldBoundingBox } from "@/lib/projection";

function cameraAtOrigin() {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

describe("projectWorldBoundingBox", () => {
  it("returns a screen box for an object in front of the camera", () => {
    const result = projectWorldBoundingBox(
      new Matrix4().makeTranslation(0, 0, -8),
      new Vector3(2, 2, 4),
      cameraAtOrigin(),
      { width: 1280, height: 720 }
    );

    expect(result).not.toBeNull();
    expect(result?.x).toBeGreaterThan(0);
    expect(result?.width).toBeGreaterThan(20);
  });

  it("does not create a box for an object behind the camera", () => {
    const result = projectWorldBoundingBox(
      new Matrix4().makeTranslation(0, 0, 8),
      new Vector3(2, 2, 4),
      cameraAtOrigin(),
      { width: 1280, height: 720 }
    );

    expect(result).toBeNull();
  });
});
