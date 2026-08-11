/**
 * Co-editors drawn in the viewport as floating eyeballs with name labels.
 *
 * Purely presentational: it owns the meshes and the "N co-editors online"
 * label, and knows nothing about locks, selection or the document. Peer
 * meshes are never pickable, so they cannot be selected or block a click —
 * `EditorPicker` also refuses them because nothing claims ownership of them.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js'
import type { Scene } from '@babylonjs/core/scene.js'

interface PeerAvatar {
  root: TransformNode
  label: Mesh
}

/** A camera-facing name plate. */
function makeLabel(scene: Scene, text: string): Mesh {
  const tex = new DynamicTexture(`lbl:${text}`, { width: 256, height: 64 }, scene, false)
  const ctx = tex.getContext() as CanvasRenderingContext2D
  ctx.font = 'bold 34px system-ui'
  ctx.textAlign = 'center'
  ctx.fillStyle = '#7fd0ff'
  ctx.fillText(text.slice(0, 14), 128, 44)
  tex.update()
  tex.hasAlpha = true
  const plane = new Mesh('lblp', scene)
  const vd = new VertexData()
  vd.positions = [-1, -0.25, 0, 1, -0.25, 0, 1, 0.25, 0, -1, 0.25, 0]
  vd.indices = [0, 1, 2, 0, 2, 3]
  vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1]
  vd.applyToMesh(plane)
  const m = new StandardMaterial('lblm', scene)
  m.diffuseTexture = tex
  m.emissiveColor = new Color3(1, 1, 1)
  m.disableLighting = true
  m.backFaceCulling = false
  plane.material = m
  plane.billboardMode = Mesh.BILLBOARDMODE_ALL
  return plane
}

export class PeerAvatars {
  private readonly avatars = new Map<number, PeerAvatar>()

  constructor(
    private readonly scene: Scene,
    private readonly labelEl: HTMLElement,
  ) {}

  get count(): number {
    return this.avatars.size
  }

  /** Create or move a peer's avatar. */
  update(id: number, name: string, pos: number[], yaw: number, pitch: number): void {
    let avatar = this.avatars.get(id)
    if (!avatar) {
      avatar = this.create(id, name)
      this.avatars.set(id, avatar)
      this.refreshLabel()
    }
    avatar.root.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0)
    avatar.root.rotation.set(pitch, yaw, 0)
  }

  remove(id: number): void {
    const avatar = this.avatars.get(id)
    if (!avatar) return
    avatar.root.dispose(false, true)
    this.avatars.delete(id)
    this.refreshLabel()
  }

  private refreshLabel(): void {
    const n = this.avatars.size
    this.labelEl.textContent = n > 0 ? `👁 ${n} co-editor${n > 1 ? 's' : ''} online` : ''
  }

  private create(id: number, name: string): PeerAvatar {
    const scene = this.scene
    const root = new TransformNode(`peer:${id}`, scene)
    const eye = CreateSphere(`peer:${id}:eye`, { diameter: 0.9, segments: 12 }, scene)
    eye.parent = root
    const em = new StandardMaterial(`peer:${id}:m`, scene)
    em.diffuseColor = new Color3(0.95, 0.95, 0.98)
    em.emissiveColor = new Color3(0.25, 0.25, 0.28)
    eye.material = em
    const iris = CreateCylinder(
      `peer:${id}:iris`,
      { diameter: 0.34, height: 0.04, tessellation: 16 },
      scene,
    )
    iris.parent = root
    iris.rotation.x = Math.PI / 2
    iris.position.z = 0.44
    const im = new StandardMaterial(`peer:${id}:im`, scene)
    im.diffuseColor = new Color3(0.1, 0.35, 0.7)
    im.emissiveColor = new Color3(0.05, 0.2, 0.45)
    iris.material = im
    const label = makeLabel(scene, name)
    label.parent = root
    label.position.y = 0.85
    // Never pickable: a co-editor must not absorb a selection click.
    for (const m of [eye, iris, label]) m.isPickable = false
    return { root, label }
  }
}
