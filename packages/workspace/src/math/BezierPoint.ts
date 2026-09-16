/**
 * A single anchor with absolute in/out bezier handles (local space).
 */
export interface BezierPoint {
  x: number;
  y: number;
  /** Incoming handle (absolute). Equal to (x,y) for a corner. */
  inX: number;
  inY: number;
  /** Outgoing handle (absolute). Equal to (x,y) for a corner. */
  outX: number;
  outY: number;
  /**
   * The two handles move independently (AE: a vertex whose direction lines
   * were split with Alt / Convert Vertex). Absent = smooth: dragging one handle
   * turns the other to stay opposite. Optional so every stored path — and
   * every point literal in the codebase — reads as it always did.
   */
  broken?: boolean;
  /**
   * RotoBezier tension, 0..1 (AE's Info panel shows it as %). Only read while
   * the outline's RotoBezier flag is on; absent = the default 1/3.
   */
  tension?: number;
}

export function corner(x: number, y: number): BezierPoint {
  return { x, y, inX: x, inY: y, outX: x, outY: y };
}

export function smooth(x: number, y: number, inX: number, inY: number, outX: number, outY: number): BezierPoint {
  return { x, y, inX, inY, outX, outY };
}
