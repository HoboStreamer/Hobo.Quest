import type { Vec3 } from './vec3.js'

/** Unit quaternion for orientations. Same mutable/out-param conventions as Vec3. */
export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w }
}

export function qcopy(out: Quat, a: Quat): Quat {
  out.x = a.x
  out.y = a.y
  out.z = a.z
  out.w = a.w
  return out
}

export function qidentity(out: Quat): Quat {
  out.x = 0
  out.y = 0
  out.z = 0
  out.w = 1
  return out
}

export function qfromAxisAngle(out: Quat, axis: Vec3, angle: number): Quat {
  const half = angle * 0.5
  const s = Math.sin(half)
  out.x = axis.x * s
  out.y = axis.y * s
  out.z = axis.z * s
  out.w = Math.cos(half)
  return out
}

export function qfromYaw(out: Quat, yaw: number): Quat {
  const half = yaw * 0.5
  out.x = 0
  out.y = Math.sin(half)
  out.z = 0
  out.w = Math.cos(half)
  return out
}

/** Quaternion from yaw (Y), pitch (X), roll (Z) — applied yaw·pitch·roll. */
export function qfromEuler(out: Quat, pitchX: number, yawY: number, rollZ: number): Quat {
  const cx = Math.cos(pitchX / 2)
  const sx = Math.sin(pitchX / 2)
  const cy = Math.cos(yawY / 2)
  const sy = Math.sin(yawY / 2)
  const cz = Math.cos(rollZ / 2)
  const sz = Math.sin(rollZ / 2)
  out.x = sx * cy * cz + cx * sy * sz
  out.y = cx * sy * cz - sx * cy * sz
  out.z = cx * cy * sz - sx * sy * cz
  out.w = cx * cy * cz + sx * sy * sz
  return out
}

/**
 * Decomposes a unit quaternion into yaw (Y), pitch (X), roll (Z) matching
 * qfromEuler's composition order (R = Ry * Rx * Rz). Used for world-angle
 * snapping (physgun Shift+E).
 */
export function qtoEulerYXZ(q: Quat, out: { pitch: number; yaw: number; roll: number }): void {
  const sinPitch = 2 * (q.w * q.x - q.y * q.z)
  out.pitch = Math.asin(Math.max(-1, Math.min(1, sinPitch)))
  out.yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y))
  out.roll = Math.atan2(2 * (q.x * q.y + q.w * q.z), 1 - 2 * (q.x * q.x + q.z * q.z))
}

export function qmul(out: Quat, a: Quat, b: Quat): Quat {
  const ax = a.x,
    ay = a.y,
    az = a.z,
    aw = a.w
  const bx = b.x,
    by = b.y,
    bz = b.z,
    bw = b.w
  out.x = aw * bx + ax * bw + ay * bz - az * by
  out.y = aw * by - ax * bz + ay * bw + az * bx
  out.z = aw * bz + ax * by - ay * bx + az * bw
  out.w = aw * bw - ax * bx - ay * by - az * bz
  return out
}

/** Rotates vector v by quaternion q into out. */
export function qrotateVec(out: Vec3, q: Quat, v: Vec3): Vec3 {
  // t = 2 * cross(q.xyz, v); out = v + q.w * t + cross(q.xyz, t)
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  out.x = v.x + q.w * tx + (q.y * tz - q.z * ty)
  out.y = v.y + q.w * ty + (q.z * tx - q.x * tz)
  out.z = v.z + q.w * tz + (q.x * ty - q.y * tx)
  return out
}

/** Rotates v by the INVERSE of unit quaternion q. */
export function qrotateVecInv(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const ix = -q.x
  const iy = -q.y
  const iz = -q.z
  const tx = 2 * (iy * v.z - iz * v.y)
  const ty = 2 * (iz * v.x - ix * v.z)
  const tz = 2 * (ix * v.y - iy * v.x)
  out.x = v.x + q.w * tx + (iy * tz - iz * ty)
  out.y = v.y + q.w * ty + (iz * tx - ix * tz)
  out.z = v.z + q.w * tz + (ix * ty - iy * tx)
  return out
}

export function qnormalize(out: Quat, a: Quat): Quat {
  const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w)
  if (len > 1e-8) {
    const inv = 1 / len
    out.x = a.x * inv
    out.y = a.y * inv
    out.z = a.z * inv
    out.w = a.w * inv
  }
  return out
}

export function qslerp(out: Quat, a: Quat, b: Quat, t: number): Quat {
  let cosom = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  let bx = b.x,
    by = b.y,
    bz = b.z,
    bw = b.w
  if (cosom < 0) {
    cosom = -cosom
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let scale0: number
  let scale1: number
  if (1 - cosom > 1e-6) {
    const omega = Math.acos(cosom)
    const sinom = Math.sin(omega)
    scale0 = Math.sin((1 - t) * omega) / sinom
    scale1 = Math.sin(t * omega) / sinom
  } else {
    scale0 = 1 - t
    scale1 = t
  }
  out.x = scale0 * a.x + scale1 * bx
  out.y = scale0 * a.y + scale1 * by
  out.z = scale0 * a.z + scale1 * bz
  out.w = scale0 * a.w + scale1 * bw
  return out
}
