import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'

/**
 * Physgun beam visuals: a thin emissive strip stretched between a source
 * point (viewmodel muzzle / remote hand) and the held prop, with a slight
 * pulse. One beam per holding player, created/removed as heldBy changes.
 */
export class BeamRenderer {
  private readonly beams = new Map<string, Mesh>()
  private readonly mat: StandardMaterial
  private time = 0

  constructor(private readonly scene: Scene) {
    this.mat = new StandardMaterial('beam', scene)
    this.mat.emissiveColor = new Color3(0.35, 0.65, 0.95)
    this.mat.diffuseColor = new Color3(0.1, 0.2, 0.3)
    this.mat.alpha = 0.75
    this.mat.disableLighting = true
  }

  /** Reconcile active beams: key -> [from, to] world points. */
  update(dt: number, active: Map<string, [Vector3, Vector3]>): void {
    this.time += dt
    for (const [key, mesh] of this.beams) {
      if (!active.has(key)) {
        mesh.dispose()
        this.beams.delete(key)
      }
    }
    for (const [key, [from, to]] of active) {
      let mesh = this.beams.get(key)
      if (!mesh) {
        mesh = CreateBox(`beam:${key}`, { size: 1 }, this.scene)
        mesh.material = this.mat
        mesh.isPickable = false
        this.beams.set(key, mesh)
      }
      const mid = from.add(to).scale(0.5)
      const dir = to.subtract(from)
      const len = Math.max(dir.length(), 0.01)
      const pulse = 1 + Math.sin(this.time * 14) * 0.25
      mesh.position.copyFrom(mid)
      mesh.scaling.set(0.02 * pulse, 0.02 * pulse, len)
      mesh.lookAt(to)
    }
  }

  dispose(): void {
    for (const mesh of this.beams.values()) mesh.dispose()
    this.beams.clear()
    this.mat.dispose()
  }
}
