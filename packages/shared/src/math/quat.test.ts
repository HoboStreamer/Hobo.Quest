import { describe, expect, it } from 'vitest'
import { qfromEuler, qtoEulerYXZ, quat } from './quat.js'

describe('qtoEulerYXZ', () => {
  it('roundtrips qfromEuler for angles inside gimbal-safe range', () => {
    const out = { pitch: 0, yaw: 0, roll: 0 }
    const q = quat()
    for (const pitch of [-1.2, -0.4, 0, 0.7, 1.3]) {
      for (const yaw of [-3, -1.1, 0, 0.6, 2.8]) {
        for (const roll of [-2.9, -0.8, 0, 1.4, 3]) {
          qfromEuler(q, pitch, yaw, roll)
          qtoEulerYXZ(q, out)
          expect(out.pitch).toBeCloseTo(pitch, 5)
          expect(out.yaw).toBeCloseTo(yaw, 5)
          expect(out.roll).toBeCloseTo(roll, 5)
        }
      }
    }
  })
})
