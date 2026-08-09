/**
 * Minimal allocation-conscious 3D vector math.
 *
 * Mutable plain objects with explicit out-parameters in hot-path helpers so
 * simulation code can avoid per-tick allocations. Not tied to any renderer.
 */
export interface Vec3 {
  x: number
  y: number
  z: number
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z }
}

export function v3copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x
  out.y = a.y
  out.z = a.z
  return out
}

export function v3set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x
  out.y = y
  out.z = z
  return out
}

export function v3add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x
  out.y = a.y + b.y
  out.z = a.z + b.z
  return out
}

export function v3sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x
  out.y = a.y - b.y
  out.z = a.z - b.z
  return out
}

export function v3scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s
  out.y = a.y * s
  out.z = a.z * s
  return out
}

/** out = a + b * s — the fundamental integration step. */
export function v3addScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s
  out.y = a.y + b.y * s
  out.z = a.z + b.z * s
  return out
}

export function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function v3cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y
  const y = a.z * b.x - a.x * b.z
  const z = a.x * b.y - a.y * b.x
  out.x = x
  out.y = y
  out.z = z
  return out
}

export function v3lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z
}

export function v3length(a: Vec3): number {
  return Math.sqrt(v3lengthSq(a))
}

export function v3distSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

export function v3dist(a: Vec3, b: Vec3): number {
  return Math.sqrt(v3distSq(a, b))
}

/** Normalizes in place; leaves zero vectors untouched. Returns previous length. */
export function v3normalize(out: Vec3, a: Vec3): number {
  const len = v3length(a)
  if (len > 1e-8) {
    const inv = 1 / len
    out.x = a.x * inv
    out.y = a.y * inv
    out.z = a.z * inv
  } else {
    out.x = a.x
    out.y = a.y
    out.z = a.z
  }
  return len
}

export function v3lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t
  out.y = a.y + (b.y - a.y) * t
  out.z = a.z + (b.z - a.z) * t
  return out
}

export function v3equalsApprox(a: Vec3, b: Vec3, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps
}
