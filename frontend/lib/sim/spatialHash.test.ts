import { describe, expect, it } from "vitest";

import { SpatialHash } from "@/lib/sim/spatialHash";

describe("SpatialHash", () => {
  it("returns items in the same cell", () => {
    const hash = new SpatialHash<string>(5);
    hash.insert({ x: 1, z: 1 }, "a");
    hash.insert({ x: 2, z: 2 }, "b");
    expect(hash.nearby({ x: 1.5, z: 1.5 }).sort()).toEqual(["a", "b"]);
  });

  it("returns items in adjacent cells within the 3x3 block", () => {
    const hash = new SpatialHash<string>(5);
    hash.insert({ x: 1, z: 1 }, "a");
    hash.insert({ x: 6, z: 1 }, "b"); // next cell over in x
    expect(hash.nearby({ x: 1, z: 1 }).sort()).toEqual(["a", "b"]);
  });

  it("excludes items more than one cell away", () => {
    const hash = new SpatialHash<string>(5);
    hash.insert({ x: 1, z: 1 }, "a");
    hash.insert({ x: 20, z: 20 }, "far");
    expect(hash.nearby({ x: 1, z: 1 })).toEqual(["a"]);
  });

  it("clear empties the grid", () => {
    const hash = new SpatialHash<string>(5);
    hash.insert({ x: 1, z: 1 }, "a");
    hash.clear();
    expect(hash.nearby({ x: 1, z: 1 })).toEqual([]);
  });
});
