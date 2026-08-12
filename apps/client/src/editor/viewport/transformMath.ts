/**
 * Canonical transform maths for the editor.
 *
 * Every authored object — primitive static, imported model, terrain — has the
 * same transform shape: position, ORIENTATION AS A QUATERNION, and scale.
 * Euler triples are a display format only; accumulating rotations through
 * them is what produced drifting angles and gimbal surprises before.
 *
 * Group edits are expressed as ONE delta matrix applied to each member's
 * IMMUTABLE START transform:
 *
 *     newWorld = delta × startWorld
 *
 * Deriving from the start snapshot (rather than from the current, already
 * transformed state) is what makes a drag idempotent per frame and makes
 * cancel an exact restore.
 */
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'

export interface EditorTransform {
  position: [number, number, number]
  /** Orientation as a quaternion [x, y, z, w]. */
  rotation: [number, number, number, number]
  scale: [number, number, number]
}

export const IDENTITY_TRANSFORM: EditorTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
}

export const cloneTransform = (t: EditorTransform): EditorTransform => ({
  position: [...t.position],
  rotation: [...t.rotation],
  scale: [...t.scale],
})

/** Babylon uses YXZ order for its Euler helpers; match it exactly. */
export function transformFromEuler(
  position: [number, number, number],
  euler: [number, number, number],
  scale: [number, number, number] = [1, 1, 1],
): EditorTransform {
  const q = Quaternion.FromEulerAngles(euler[0], euler[1], euler[2])
  return { position: [...position], rotation: [q.x, q.y, q.z, q.w], scale: [...scale] }
}

/** Degrees for the inspector; radians/quaternions everywhere else. */
export function eulerOf(t: EditorTransform): [number, number, number] {
  const e = new Quaternion(
    t.rotation[0],
    t.rotation[1],
    t.rotation[2],
    t.rotation[3],
  ).toEulerAngles()
  return [e.x, e.y, e.z]
}

export function composeMatrix(t: EditorTransform): Matrix {
  return Matrix.Compose(
    new Vector3(t.scale[0], t.scale[1], t.scale[2]),
    new Quaternion(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]),
    new Vector3(t.position[0], t.position[1], t.position[2]),
  )
}

export function decomposeMatrix(m: Matrix): EditorTransform {
  const s = new Vector3()
  const q = new Quaternion()
  const p = new Vector3()
  m.decompose(s, q, p)
  return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z] }
}

/**
 * The delta that carries `from` onto `to`, i.e. `delta = to × from⁻¹`.
 * Used to turn "where the gizmo pivot started / is now" into the single
 * transform every selected object should receive.
 */
export function deltaBetween(from: EditorTransform, to: EditorTransform): Matrix {
  return composeMatrix(from).invert().multiply(composeMatrix(to))
}

/** Apply a world-space delta to a start transform. */
export function applyDelta(start: EditorTransform, delta: Matrix): EditorTransform {
  return decomposeMatrix(composeMatrix(start).multiply(delta))
}

/**
 * Apply one pivot delta to every member of a group, always from the members'
 * START transforms. Passing the same pivot pair twice yields the same result,
 * which is what stops a drag from compounding frame over frame.
 */
export function applyGroupDelta(
  starts: readonly EditorTransform[],
  pivotStart: EditorTransform,
  pivotNow: EditorTransform,
): EditorTransform[] {
  const delta = deltaBetween(pivotStart, pivotNow)
  return starts.map((s) => applyDelta(s, delta))
}

/** Centroid of a set of transforms — the default group pivot. */
export function centroidOf(items: readonly EditorTransform[]): [number, number, number] {
  if (items.length === 0) return [0, 0, 0]
  let x = 0
  let y = 0
  let z = 0
  for (const t of items) {
    x += t.position[0]
    y += t.position[1]
    z += t.position[2]
  }
  const n = items.length
  return [x / n, y / n, z / n]
}

/** Reject NaN/Infinity and non-positive scale before they reach the document. */
export function isFiniteTransform(t: EditorTransform): boolean {
  const nums = [...t.position, ...t.rotation, ...t.scale]
  if (!nums.every((n) => Number.isFinite(n))) return false
  return t.scale.every((s) => Math.abs(s) > 1e-6)
}

/** Snap a position to a grid; `step <= 0` disables snapping. */
export function snapPosition(p: [number, number, number], step: number): [number, number, number] {
  if (step <= 0) return [...p]
  return [
    Math.round(p[0] / step) * step,
    Math.round(p[1] / step) * step,
    Math.round(p[2] / step) * step,
  ]
}

/** Mixed-value detection for the multi-selection inspector. */
export function mixedComponents(items: readonly EditorTransform[]): {
  position: [boolean, boolean, boolean]
  scale: [boolean, boolean, boolean]
  rotation: boolean
} {
  const eps = 1e-4
  const first = items[0]
  if (!first || items.length === 1)
    return { position: [false, false, false], scale: [false, false, false], rotation: false }
  const diff = (get: (t: EditorTransform) => number): boolean =>
    items.some((t) => Math.abs(get(t) - get(first)) > eps)
  return {
    position: [diff((t) => t.position[0]), diff((t) => t.position[1]), diff((t) => t.position[2])],
    scale: [diff((t) => t.scale[0]), diff((t) => t.scale[1]), diff((t) => t.scale[2])],
    rotation: items.some((t) => t.rotation.some((v, i) => Math.abs(v - first.rotation[i]!) > eps)),
  }
}
