import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'

/**
 * Physgun beam visuals. The beam always fires while the trigger is held —
 * a dim searching ray when nothing is latched, a bright thick beam plus a
 * muzzle flare once a prop is held (GMod). One beam per firing player.
 */

export interface BeamState {
  from: Vector3
  to: Vector3
  /** A prop is latched: bright beam + flare; otherwise dim searching ray. */
  latched: boolean
}

interface BeamMeshes {
  beam: Mesh
  flare: Mesh
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
        meshes.beam.dispose()
        meshes.flare.dispose()
        this.beams.delete(key)
      }
    }
    for (const [key, state] of active) {
      let meshes = this.beams.get(key)
      if (!meshes) {
        const beam = CreateBox(`beam:${key}`, { size: 1 }, this.scene)
        beam.isPickable = false
        const flare = CreateSphere(`beamflare:${key}`, { diameter: 1, segments: 6 }, this.scene)
        flare.isPickable = false
        flare.material = this.flareMat
        meshes = { beam, flare }
        this.beams.set(key, meshes)
      }
      const { from, to, latched } = state
      const mid = from.add(to).scale(0.5)
      const dir = to.subtract(from)
      const len = Math.max(dir.length(), 0.01)
      const pulse = 1 + Math.sin(this.time * 14) * 0.25
      const girth = latched ? 0.034 : 0.014
      meshes.beam.material = latched ? this.strongMat : this.idleMat
      meshes.beam.position.copyFrom(mid)
      meshes.beam.scaling.set(girth * pulse, girth * pulse, len)
      meshes.beam.lookAt(to)
      // Muzzle flare: the gun visibly energizes once something is held.
      meshes.flare.setEnabled(latched)
      if (latched) {
        meshes.flare.position.copyFrom(from)
        const s = 0.07 * (1 + Math.sin(this.time * 11) * 0.3)
        meshes.flare.scaling.set(s, s, s)
      }
    }
  }

  dispose(): void {
    for (const meshes of this.beams.values()) {
      meshes.beam.dispose()
      meshes.flare.dispose()
    }
    this.beams.clear()
    this.idleMat.dispose()
    this.strongMat.dispose()
    this.flareMat.dispose()
  }
}
