import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateTube } from '@babylonjs/core/Meshes/Builders/tubeBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'

/**
 * Physgun beam visuals, GMod-style: the beam leaves the muzzle ALONG THE
 * BARREL and bends toward the held point on a cubic Bezier — carrying a
 * prop off to the side visibly flexes the beam instead of pivoting a
 * straight stick. Idle (unlatched) beams are a dim, nearly-straight ray.
 * Tubes are updatable meshes: same point count every frame, zero realloc.
 */

export interface BeamState {
  from: Vector3
  to: Vector3
  /** Direction the beam LEAVES the muzzle (usually the view/barrel axis). */
  tangent?: Vector3
  /** A prop is latched: bright beam + flare; otherwise dim searching ray. */
  latched: boolean
}

const SEGMENTS = 24

interface BeamMeshes {
  tube: Mesh
  flare: Mesh
  path: Vector3[]
}

export class BeamRenderer {
  private readonly beams = new Map<string, BeamMeshes>()
  private readonly idleMat: StandardMaterial
  private readonly strongMat: StandardMaterial
  private readonly flareMat: StandardMaterial
  private time = 0

  constructor(private readonly scene: Scene) {
    this.idleMat = new StandardMaterial('beam-idle', scene)
    this.idleMat.emissiveColor = new Color3(0.22, 0.42, 0.65)
    this.idleMat.diffuseColor = new Color3(0.05, 0.1, 0.16)
    this.idleMat.alpha = 0.45
    this.idleMat.disableLighting = true

    this.strongMat = new StandardMaterial('beam-strong', scene)
    this.strongMat.emissiveColor = new Color3(0.55, 0.85, 1)
    this.strongMat.diffuseColor = new Color3(0.12, 0.25, 0.38)
    this.strongMat.alpha = 0.92
    this.strongMat.disableLighting = true

    this.flareMat = new StandardMaterial('beam-flare', scene)
    this.flareMat.emissiveColor = new Color3(0.7, 0.92, 1)
    this.flareMat.alpha = 0.85
    this.flareMat.disableLighting = true
  }

  /** Reconcile active beams: key -> beam state. */
  update(dt: number, active: Map<string, BeamState>): void {
    this.time += dt
    for (const [key, meshes] of this.beams) {
      if (!active.has(key)) {
        meshes.tube.dispose()
        meshes.flare.dispose()
        this.beams.delete(key)
      }
    }
    for (const [key, state] of active) {
      let meshes = this.beams.get(key)
      if (!meshes) {
        const path = Array.from({ length: SEGMENTS + 1 }, () => new Vector3())
        this.fillPath(path, state)
        const tube = CreateTube(
          `beam:${key}`,
          { path, radius: 0.02, tessellation: 6, updatable: true, cap: 2 },
          this.scene,
        )
        tube.isPickable = false
        const flare = CreateSphere(`beamflare:${key}`, { diameter: 1, segments: 6 }, this.scene)
        flare.isPickable = false
        flare.material = this.flareMat
        meshes = { tube, flare, path }
        this.beams.set(key, meshes)
      } else {
        this.fillPath(meshes.path, state)
        CreateTube(`beam:${key}`, {
          path: meshes.path,
          radius: state.latched ? 0.024 : 0.011,
          instance: meshes.tube,
        })
      }
      meshes.tube.material = state.latched ? this.strongMat : this.idleMat
      // Muzzle flare: the gun visibly energizes once something is held.
      meshes.flare.setEnabled(state.latched)
      if (state.latched) {
        meshes.flare.position.copyFrom(state.from)
        const s = 0.07 * (1 + Math.sin(this.time * 11) * 0.3)
        meshes.flare.scaling.set(s, s, s)
      }
    }
  }

  /**
   * Cubic Bezier from the muzzle: P0 at the tip, P1 pushed along the barrel
   * tangent (so the beam LEAVES straight out of the gun), P2 eased back
   * toward the target's approach, P3 at the grab point. Control lengths
   * scale with distance, giving a taut short beam and a lazy long arc.
   */
  private fillPath(path: Vector3[], state: BeamState): void {
    const { from, to, tangent } = state
    _dir.copyFrom(to).subtractInPlace(from)
    const dist = Math.max(_dir.length(), 0.01)
    _dir.scaleInPlace(1 / dist)
    _tan.copyFrom(tangent ?? _dir).normalize()
    const lead = Math.min(dist * 0.45, 3.2)
    _p1.copyFrom(from).addInPlace(_tan.scale(lead))
    // P2: pull back from the target along the chord for a smooth arrival,
    // with a slight sag so long beams droop like a loaded cable.
    _p2.copyFrom(to).subtractInPlace(_dir.scale(Math.min(dist * 0.3, 2.2)))
    _p2.y -= Math.min(dist * 0.04, 0.35)
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS
      const u = 1 - t
      const a = u * u * u
      const b = 3 * u * u * t
      const c = 3 * u * t * t
      const d = t * t * t
      const p = path[i] as Vector3
      p.x = a * from.x + b * _p1.x + c * _p2.x + d * to.x
      p.y = a * from.y + b * _p1.y + c * _p2.y + d * to.y
      p.z = a * from.z + b * _p1.z + c * _p2.z + d * to.z
    }
  }

  dispose(): void {
    for (const meshes of this.beams.values()) {
      meshes.tube.dispose()
      meshes.flare.dispose()
    }
    this.beams.clear()
    this.idleMat.dispose()
    this.strongMat.dispose()
    this.flareMat.dispose()
  }
}

const _dir = new Vector3()
const _tan = new Vector3()
const _p1 = new Vector3()
const _p2 = new Vector3()
