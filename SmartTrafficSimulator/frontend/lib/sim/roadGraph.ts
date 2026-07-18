import type { Direction } from "@/types/traffic";

/**
 * Road graph & lane system (Spec Part 1).
 *
 * Coordinate convention (ground plane, y is up and always 0 here):
 *   +x = east, -x = west, +z = south, -z = north.
 *   A `Direction` names the HEADING of travel:
 *     north = heading -z, south = heading +z, east = heading +x, west = heading -x.
 *
 * Right-hand traffic: a driver keeps to the right relative to travel.
 *   Facing north (-z) right is +x  -> northbound lane sits at x = +LANE_OFFSET.
 *   Facing south (+z) right is -x  -> southbound lane sits at x = -LANE_OFFSET.
 *   Facing east  (+x) right is +z  -> eastbound  lane sits at z = +LANE_OFFSET.
 *   Facing west  (-x) right is -z  -> westbound  lane sits at z = -LANE_OFFSET.
 *
 * Each heading therefore owns one continuous lane line that spans the whole map;
 * the intersection square splits it into an INBOUND approach and an OUTBOUND exit.
 */

export type Turn = "LEFT" | "STRAIGHT" | "RIGHT";
export type LaneKind = "INBOUND" | "OUTBOUND";

export interface Vec2 {
  x: number;
  z: number;
}

export const LANE_OFFSET = 2;
/**
 * Inner left-turn pocket offset (Spec Part 1 / Task E). Left turns queue in a
 * dedicated lane closer to the road centreline than the through/right lane, so
 * the two phase groups (NS_LEFT vs NS_STRAIGHT_RIGHT) never block each other in
 * a single shared queue. This is the fix for the throughput deadlock where a
 * green left-turner sat trapped behind a red-stopped straight vehicle.
 */
export const LEFT_LANE_OFFSET = 0.7;
export const INTERSECTION_HALF = 6;
/** Length of each inbound/outbound arm from the box edge to the spawn/despawn point. */
export const APPROACH_LENGTH = 40;
/** Default lane speed limit in world-units / second. */
export const DEFAULT_SPEED_LIMIT = 7;

/** Unit heading vector for each travel direction. */
export const HEADING: Record<Direction, Vec2> = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 }
};

export interface Lane {
  id: string;
  kind: LaneKind;
  direction: Direction;
  /** Centerline as [start, end] in the ground plane. */
  centerline: [Vec2, Vec2];
  /** Stop-line point (INBOUND lanes only). */
  stopLine: Vec2 | null;
  /** Posted speed limit. */
  speedLimit: number;
  /** Turns a vehicle may take from this lane (INBOUND lanes only). */
  allowedTurns: Turn[];
  /** Expected direction-of-travel unit vector (used by wrong-way detection). */
  expected: Vec2;
}

export interface PathSample {
  x: number;
  z: number;
  /** Unit tangent (direction of travel) at the sampled progress. */
  tangentX: number;
  tangentZ: number;
}

export interface Path {
  points: Vec2[];
  /** Cumulative arc length; cumulative[i] is the distance from the path start to points[i]. */
  cumulative: number[];
  length: number;
}

export interface Route {
  id: string;
  direction: Direction;
  turn: Turn;
  entryLaneId: string;
  exitLaneId: string;
  path: Path;
  /** Arc length at which the front bumper reaches the painted stop line. */
  stopProgress: number;
  /** Conflict zones this route occupies inside the box (filled by conflictBox module). */
  conflictZones: string[];
}

// ---------------------------------------------------------------------------
// Vector helpers (plain {x,z}; the sim layer stays free of three.js/React).
// ---------------------------------------------------------------------------

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

function normalize(v: Vec2): Vec2 {
  const length = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / length, z: v.z / length };
}

/** Yaw for a three.js mesh, matching the project's existing atan2(x, z) convention. */
export function yawFromTangent(tangentX: number, tangentZ: number): number {
  return Math.atan2(tangentX, tangentZ);
}

// ---------------------------------------------------------------------------
// Path construction: straight segments + quadratic Bézier turns (Spec Part 1).
// ---------------------------------------------------------------------------

type Segment =
  | { type: "line"; a: Vec2; b: Vec2 }
  | { type: "quad"; a: Vec2; control: Vec2; b: Vec2 };

const QUAD_SEGMENTS = 18;

function quadPoint(a: Vec2, c: Vec2, b: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  const w0 = mt * mt;
  const w1 = 2 * mt * t;
  const w2 = t * t;
  return {
    x: w0 * a.x + w1 * c.x + w2 * b.x,
    z: w0 * a.z + w1 * c.z + w2 * b.z
  };
}

/**
 * A turn's Bézier control point is the intersection of the entry and exit lane
 * lines, which makes the curve leave and arrive exactly tangent to each lane.
 * The lines are always axis-aligned here, so the intersection is trivial.
 */
function turnControlPoint(entry: Vec2, entryHeading: Vec2, exit: Vec2): Vec2 {
  // entryHeading is axis-aligned: it either fixes x (vertical line) or z (horizontal line).
  if (Math.abs(entryHeading.x) < 1e-6) {
    // Entry travels along z -> entry line is x = entry.x; exit line is z = exit.z.
    return { x: entry.x, z: exit.z };
  }
  // Entry travels along x -> entry line is z = entry.z; exit line is x = exit.x.
  return { x: exit.x, z: entry.z };
}

function buildPath(segments: Segment[]): Path {
  const points: Vec2[] = [];
  const pushPoint = (p: Vec2) => {
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.z - p.z) < 1e-9) return;
    points.push(p);
  };

  for (const segment of segments) {
    if (segment.type === "line") {
      pushPoint(segment.a);
      pushPoint(segment.b);
    } else {
      for (let i = 0; i <= QUAD_SEGMENTS; i += 1) {
        pushPoint(quadPoint(segment.a, segment.control, segment.b, i / QUAD_SEGMENTS));
      }
    }
  }

  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
  }

  return { points, cumulative, length: cumulative[cumulative.length - 1] };
}

/** Sample world position + unit tangent at an arc-length `progress` along the path. */
export function sampleAt(path: Path, progress: number): PathSample {
  const clamped = Math.max(0, Math.min(path.length, progress));
  const { points, cumulative } = path;

  // Linear scan is fine: paths have a few dozen points and this is called per vehicle.
  let index = 1;
  while (index < cumulative.length - 1 && cumulative[index] < clamped) index += 1;

  const segmentStart = cumulative[index - 1];
  const segmentLength = cumulative[index] - segmentStart || 1;
  const t = (clamped - segmentStart) / segmentLength;

  const a = points[index - 1];
  const b = points[index];
  const tangent = normalize(sub(b, a));

  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    tangentX: tangent.x,
    tangentZ: tangent.z
  };
}

// ---------------------------------------------------------------------------
// Lane geometry.
// ---------------------------------------------------------------------------

/** Point where a heading's lane crosses the intersection edge (its stop line). */
const ENTRY: Record<Direction, Vec2> = {
  north: { x: LANE_OFFSET, z: INTERSECTION_HALF },
  south: { x: -LANE_OFFSET, z: -INTERSECTION_HALF },
  east: { x: -INTERSECTION_HALF, z: LANE_OFFSET },
  west: { x: INTERSECTION_HALF, z: -LANE_OFFSET }
};

/** Point where a heading's lane leaves the intersection edge on the far side. */
const EXIT: Record<Direction, Vec2> = {
  north: { x: LANE_OFFSET, z: -INTERSECTION_HALF },
  south: { x: -LANE_OFFSET, z: INTERSECTION_HALF },
  east: { x: INTERSECTION_HALF, z: LANE_OFFSET },
  west: { x: -INTERSECTION_HALF, z: -LANE_OFFSET }
};

/** Far spawn point of an inbound approach. */
const SPAWN: Record<Direction, Vec2> = {
  north: { x: LANE_OFFSET, z: APPROACH_LENGTH },
  south: { x: -LANE_OFFSET, z: -APPROACH_LENGTH },
  east: { x: -APPROACH_LENGTH, z: LANE_OFFSET },
  west: { x: APPROACH_LENGTH, z: -LANE_OFFSET }
};

/** Far despawn point of an outbound exit. */
const DESPAWN: Record<Direction, Vec2> = {
  north: { x: LANE_OFFSET, z: -APPROACH_LENGTH },
  south: { x: -LANE_OFFSET, z: APPROACH_LENGTH },
  east: { x: APPROACH_LENGTH, z: LANE_OFFSET },
  west: { x: -APPROACH_LENGTH, z: -LANE_OFFSET }
};

/**
 * Left-turn pocket geometry: same arm as the through lane but shifted inboard to
 * {@link LEFT_LANE_OFFSET} so left-turners queue in their own lane. Only the
 * lateral coordinate (x for NS arms, z for EW arms) moves; the longitudinal span
 * is unchanged, so stopProgress matches the through lane.
 */
const LEFT_ENTRY: Record<Direction, Vec2> = {
  north: { x: LEFT_LANE_OFFSET, z: INTERSECTION_HALF },
  south: { x: -LEFT_LANE_OFFSET, z: -INTERSECTION_HALF },
  east: { x: -INTERSECTION_HALF, z: LEFT_LANE_OFFSET },
  west: { x: INTERSECTION_HALF, z: -LEFT_LANE_OFFSET }
};

const LEFT_SPAWN: Record<Direction, Vec2> = {
  north: { x: LEFT_LANE_OFFSET, z: APPROACH_LENGTH },
  south: { x: -LEFT_LANE_OFFSET, z: -APPROACH_LENGTH },
  east: { x: -APPROACH_LENGTH, z: LEFT_LANE_OFFSET },
  west: { x: APPROACH_LENGTH, z: -LEFT_LANE_OFFSET }
};

/**
 * Right-hand-traffic turn table: from an entry heading, which heading you leave on.
 *   RIGHT is a quarter turn clockwise-in-travel; LEFT crosses oncoming traffic.
 */
const TURN_RESULT: Record<Direction, Record<Turn, Direction>> = {
  north: { STRAIGHT: "north", RIGHT: "east", LEFT: "west" },
  south: { STRAIGHT: "south", RIGHT: "west", LEFT: "east" },
  east: { STRAIGHT: "east", RIGHT: "south", LEFT: "north" },
  west: { STRAIGHT: "west", RIGHT: "north", LEFT: "south" }
};

const ALL_DIRECTIONS: Direction[] = ["north", "south", "east", "west"];
const ALL_TURNS: Turn[] = ["LEFT", "STRAIGHT", "RIGHT"];

export const LANES: Record<string, Lane> = {};
for (const direction of ALL_DIRECTIONS) {
  const heading = HEADING[direction];
  // Through/right lane: the outer inbound lane at LANE_OFFSET carries STRAIGHT + RIGHT.
  LANES[`${direction}_in`] = {
    id: `${direction}_in`,
    kind: "INBOUND",
    direction,
    centerline: [SPAWN[direction], ENTRY[direction]],
    stopLine: ENTRY[direction],
    speedLimit: DEFAULT_SPEED_LIMIT,
    allowedTurns: ["STRAIGHT", "RIGHT"],
    expected: heading
  };
  // Dedicated left-turn pocket (deadlock fix): its own inbound lane so left-turners
  // never queue behind red-stopped through traffic (and vice versa).
  LANES[`${direction}_left_in`] = {
    id: `${direction}_left_in`,
    kind: "INBOUND",
    direction,
    centerline: [LEFT_SPAWN[direction], LEFT_ENTRY[direction]],
    stopLine: LEFT_ENTRY[direction],
    speedLimit: DEFAULT_SPEED_LIMIT,
    allowedTurns: ["LEFT"],
    expected: heading
  };
  LANES[`${direction}_out`] = {
    id: `${direction}_out`,
    kind: "OUTBOUND",
    direction,
    centerline: [EXIT[direction], DESPAWN[direction]],
    stopLine: null,
    speedLimit: DEFAULT_SPEED_LIMIT,
    allowedTurns: [],
    expected: heading
  };
}

// ---------------------------------------------------------------------------
// Route construction: inbound approach -> turn curve -> outbound departure.
// ---------------------------------------------------------------------------

function buildRoute(direction: Direction, turn: Turn): Route {
  const exitDirection = TURN_RESULT[direction][turn];
  const exit = EXIT[exitDirection];
  const despawn = DESPAWN[exitDirection];
  // LEFT turns queue in the dedicated inner pocket lane; STRAIGHT/RIGHT use the
  // outer through lane. This is what decouples the two phase groups' queues.
  const isLeft = turn === "LEFT";
  const entry = isLeft ? LEFT_ENTRY[direction] : ENTRY[direction];
  const spawn = isLeft ? LEFT_SPAWN[direction] : SPAWN[direction];
  const entryLaneId = isLeft ? `${direction}_left_in` : `${direction}_in`;

  const segments: Segment[] = [];
  // Inbound approach (straight, along the lane) up to the stop line / box edge.
  segments.push({ type: "line", a: spawn, b: entry });
  // Turn (or straight-through) curve across the intersection box.
  if (turn === "STRAIGHT") {
    segments.push({ type: "line", a: entry, b: exit });
  } else {
    segments.push({ type: "quad", a: entry, control: turnControlPoint(entry, HEADING[direction], exit), b: exit });
  }
  // Outbound departure (straight, along the exit lane).
  segments.push({ type: "line", a: exit, b: despawn });

  const path = buildPath(segments);

  return {
    id: `${direction}_${turn}`,
    direction,
    turn,
    entryLaneId,
    exitLaneId: `${exitDirection}_out`,
    path,
    stopProgress: distance(spawn, entry),
    conflictZones: []
  };
}

export const ROUTES: Record<string, Route> = {};
export const ROUTE_LIST: Route[] = [];
for (const direction of ALL_DIRECTIONS) {
  for (const turn of ALL_TURNS) {
    const route = buildRoute(direction, turn);
    ROUTES[route.id] = route;
    ROUTE_LIST.push(route);
  }
}

/** All routes that enter from a given heading. */
export function routesForDirection(direction: Direction): Route[] {
  return ROUTE_LIST.filter((route) => route.direction === direction);
}
