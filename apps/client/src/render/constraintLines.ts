import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateTube } from '@babylonjs/core/Meshes/Builders/tubeBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { ClientState } from '../state/clientState.js'
import type { EntityView } from './entityView.js'

/**
 * Persistent constraint visuals: ropes and springs render as updatable
 * tubes between their body-local anchors (following the interpolated prop
 * poses every frame). Rigid joints (weld/hinge/axis/slider/motor) get no
 * standing line — the props' own motion reads as the joint.
 */

const SEGMENTS = 10

interface LineMesh {
  tube: Mesh
  path: Vector3[]
}

export class ConstraintLineRenderer {
  private readonly lines = new Map<string, LineMesh>()
  private readonly ropeMat: StandardMaterial
  private readonly springMat: StandardMaterial

  constructor(
    private readonly scene: Scene,
    private readonly state: ClientState,
    private readonly view: EntityView,
  ) {
    this.ropeMat = new StandardMaterial('rope-line', scene)
    this.ropeMat.diffuseColor = new Color3(0.62, 0.5, 0.32)
    this.ropeMat.specularColor = Color3.Black()

    this.springMat = new StandardMaterial('spring-line', scene)
    this.springMat.diffuseColor = new Color3(0.55, 0.62, 0.7)
    this.springMat.emissiveColor = new Color3(0.08, 0.1, 0.12)
    this.springMat.specularColor = Color3.Black()
  }

  update(): void {
    for (const [id, line] of this.lines) {
      const c = this.state.constraints.get(id)
      if (!c || (c.kind !== 'rope' && c.kind !== 'spring')) {
        line.tube.dispose()
        this.lines.delete(id)
      }
    }
    for (const [id, c] of this.state.constraints) {
      if (c.kind !== 'rope' && c.kind !== 'spring') continue
      const pa = this.view.grabPointOf(c.a, c.anchorA)
      if (!pa) {
        this.hide(id)
        continue
      }
      _pa.copyFrom(pa)
      const pb = this.view.grabPointOf(c.b, c.anchorB)
      if (!pb) {
        this.hide(id)
        continue
      }
      _pb.copyFrom(pb)

      let line = this.lines.get(id)
      if (!line) {
        const path = Array.from({ length: SEGMENTS + 1 }, () => new Vector3())
        fillPath(path, _pa, _pb, c.kind === 'rope' ? (c.length ?? 0) : 0)
        const tube = CreateTube(
          `constraint:${id}`,
          { path, radius: c.kind === 'rope' ? 0.022 : 0.032, tessellation: 5, updatable: true },
          this.scene,
        )
        tube.isPickable = false
        tube.material = c.kind === 'rope' ? this.ropeMat : this.springMat
        line = { tube, path }
        this.lines.set(id, line)
      } else {
        line.tube.setEnabled(true)
        fillPath(line.path, _pa, _pb, c.kind === 'rope' ? (c.length ?? 0) : 0)
        CreateTube(`constraint:${id}`, { path: line.path, instance: line.tube })
      }
    }
  }

  private hide(id: string): void {
    this.lines.get(id)?.tube.setEnabled(false)
  }

  dispose(): void {
    for (const line of this.lines.values()) line.tube.dispose()
    this.lines.clear()
    this.ropeMat.dispose()
    this.springMat.dispose()
  }
}

/** Straight run with rope droop: slack (rest length beyond the current gap)
 * hangs as a parabolic sag, so a loose tether visibly dangles. */
function fillPath(path: Vector3[], a: Vector3, b: Vector3, restLength: number): void {
  const dist = Vector3.Distance(a, b)
  const slack = Math.max(0, restLength - dist)
  const sag = slack * 0.45
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS
    const p = path[i] as Vector3
    p.x = a.x + (b.x - a.x) * t
    p.y = a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t)
    p.z = a.z + (b.z - a.z) * t
  }
}

const _pa = new Vector3()
const _pb = new Vector3()
