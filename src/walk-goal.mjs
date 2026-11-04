export function walkGoal ({ x, y, z }) {
  return { x: Math.floor(x), y: y == null ? null : Math.floor(y), z: Math.floor(z) }
}

export function walkArrived (position, target, goal, tolerance, yTolerance = 2) {
  if (!position || ![position.x, position.z].every(Number.isFinite)
      || (goal.y != null && !Number.isFinite(position.y))) return false
  if (tolerance != null) {
    return Math.hypot(position.x - target.x, position.z - target.z) <= tolerance
      && (goal.y == null || Math.abs(position.y - target.y) <= yTolerance)
  }
  return Math.floor(position.x) === goal.x && Math.floor(position.z) === goal.z
    && (goal.y == null || Math.floor(position.y) === goal.y)
}

export function walkDistance (a, b, includeY) {
  return Math.hypot(a.x - b.x, includeY ? a.y - b.y : 0, a.z - b.z)
}
