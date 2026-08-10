import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import '@babylonjs/loaders/OBJ/objFileLoader.js'
import type { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js'
import type { ContentRegistry } from '@hobo/content'
import { createHeldItemNode, type HeldItemNode } from './heldItem.js'

/**
 * First-person viewmodel: the equipped tool rendered at the camera with
 * smooth sway (mouse lag), movement bob, and equip/swing motions. The
 * physgun uses the imported OBJ + texture; other tools use the procedural
 * props. Purely cosmetic — no gameplay reads anything from here.
 */
export class Viewmodel {
  private readonly rig: TransformNode
  private physgunMeshes: AbstractMesh[] = []
  private toolProp: HeldItemNode | null = null
  private currentItem: string | null = null
  private physgunLoaded = false

  // Motion state
  private swayYaw = 0
  private swayPitch = 0
  private bobPhase = 0
  private equipT = 1
  private swingT = 0

  constructor(
    private readonly scene: Scene,
    private readonly content: ContentRegistry,
    camera: UniversalCamera,
  ) {
    this.rig = new TransformNode('viewmodel', scene)
    this.rig.parent = camera
    this.rig.position.set(0.28, -0.32, 0.72)
    // The imported OBJ is kept behind a debug flag while its orientation and
    // material are tuned; the procedural physgun matches the art style.
    if (new URLSearchParams(location.search).has('vmobj')) void this.loadPhysgun()
  }

  private async loadPhysgun(): Promise<void> {
    try {
      const result = await SceneLoader.ImportMeshAsync('', '/assets/', 'physgun.obj', this.scene)
      const mat = new StandardMaterial('physgun-vm', this.scene)
      mat.diffuseTexture = new Texture('/assets/physgun_tex.png', this.scene)
      mat.specularColor = new Color3(0.15, 0.15, 0.15)
      mat.emissiveColor = new Color3(0.25, 0.28, 0.32)
      mat.backFaceCulling = false

      // Normalize: the source model is offset and ~3.7 units long.
      const holder = new TransformNode('physgun-holder', this.scene)
      holder.parent = this.rig
      let min = new Vector3(Infinity, Infinity, Infinity)
      let max = new Vector3(-Infinity, -Infinity, -Infinity)
      for (const m of result.meshes) {
        // World matrices are not up to date right after import — force them,
        // or the bounding box (and thus the normalization scale) is garbage.
        m.computeWorldMatrix(true)
        const b = m.getBoundingInfo()
        b.update(m.getWorldMatrix())
        min = Vector3.Minimize(min, b.boundingBox.minimumWorld)
        max = Vector3.Maximize(max, b.boundingBox.maximumWorld)
      }
      const size = max.subtract(min)
      const scale = 0.3 / Math.max(size.x, size.y, size.z)
      const center = min.add(max).scale(0.5)
      for (const m of result.meshes) {
        m.material = mat
        m.parent = holder
        m.isPickable = false
        this.physgunMeshes.push(m)
      }
      console.log(
        `[vm] physgun size=${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)} scale=${scale.toFixed(4)} center=${center.x.toFixed(2)},${center.y.toFixed(2)},${center.z.toFixed(2)}`,
      )
      holder.scaling.setAll(scale)
      holder.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
      // Long axis (z) points forward; nudge grip downward into frame.
      // Orientation is empirically tuned (see ?vmrot= debug param).
      const vmrot = Number(new URLSearchParams(location.search).get('vmrot') ?? '180')
      holder.rotation.y = (vmrot * Math.PI) / 180
      this.physgunLoaded = true
      this.setPhysgunVisible(this.currentItem === 'physgun')
    } catch (err) {
      console.warn('physgun viewmodel failed to load, using fallback', err)
      this.physgunLoaded = false
    }
  }

  private setPhysgunVisible(visible: boolean): void {
    for (const m of this.physgunMeshes) m.isVisible = visible
  }

  triggerSwing(): void {
    this.swingT = 0.32
  }

  /** Per-frame update. mouseDx/Dy are this frame's look deltas (radians). */
  update(dt: number, speed: number, grounded: boolean, mouseDx: number, mouseDy: number): void {
    // Equip transition + swing timers
    this.equipT = Math.min(1, this.equipT + dt * 4)
    if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt)

    // Sway: lag behind the view with exponential decay.
    this.swayYaw += (mouseDx * 0.6 - this.swayYaw) * Math.min(1, dt * 10)
    this.swayPitch += (mouseDy * 0.6 - this.swayPitch) * Math.min(1, dt * 10)

    // Bob while moving on the ground.
    if (grounded && speed > 0.3) this.bobPhase += dt * Math.min(speed, 8) * 1.6
    const bobAmp = grounded ? Math.min(speed / 7.2, 1) * 0.012 : 0
    const bobY = Math.abs(Math.sin(this.bobPhase)) * -bobAmp
    const bobX = Math.sin(this.bobPhase * 0.5) * bobAmp * 0.6

    const equipDip = (1 - this.equipT) * -0.25
    const swing = this.swingT > 0 ? Math.sin((this.swingT / 0.32) * Math.PI) : 0

    this.rig.position.set(
      0.26 + bobX - this.swayYaw * 0.15,
      -0.26 + bobY + equipDip - swing * 0.1,
      0.55,
    )
    this.rig.rotation.set(
      -this.swayPitch * 0.8 + swing * 0.9 + (1 - this.equipT) * 0.6,
      Math.PI + this.swayYaw * 0.8,
      0,
    )
  }

  /** Switch displayed tool when the equipped item changes. */
  setItem(itemDef: string | null): void {
    if (itemDef === this.currentItem) return
    this.currentItem = itemDef
    this.equipT = 0

    this.toolProp?.dispose()
    this.toolProp = null
    const def = itemDef ? this.content.item(itemDef) : undefined
    const isPhysgun = def?.tool?.kind === 'physgun'
    this.setPhysgunVisible(isPhysgun && this.physgunLoaded)

    if ((!isPhysgun || !this.physgunLoaded) && itemDef) {
      this.toolProp = createHeldItemNode(this.scene, this.content, itemDef, 'vm')
      if (this.toolProp) {
        this.toolProp.root.parent = this.rig
        const isTool = def?.tool !== undefined
        this.toolProp.root.position.set(0, isTool ? -0.06 : -0.12, isTool ? -0.08 : 0)
        this.toolProp.root.scaling.scaleInPlace(isTool ? 1.05 : 0.9)
        // Viewmodels sit in the scene's shadow side; self-illuminate them a
        // touch so their shapes read instead of silhouetting to black.
        for (const child of this.toolProp.root.getChildMeshes()) {
          const mesh = child as Mesh
          const mat = mesh.material
          if (mat && 'diffuseColor' in mat && 'emissiveColor' in mat) {
            const clone = (mat as StandardMaterial).clone(`${mat.name}:vm`)
            clone.emissiveColor = (mat as StandardMaterial).diffuseColor.scale(0.45)
            mesh.material = clone
          }
        }
      }
    }
  }

  /** World-space beam origin (approximate muzzle). */
  beamOrigin(): Vector3 {
    const node = this.toolProp?.muzzle ?? this.rig
    return node.getAbsolutePosition()
  }
}
