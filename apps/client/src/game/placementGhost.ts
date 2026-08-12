import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { CollisionLayer, type PhysicsWorld } from '@hobo/physics'
import { ZoneIndex, type ZoneRules } from '@hobo/gameplay'
import { getMapOverride, terrainHeight, type ContentRegistry, type WorldShape } from '@hobo/content'
import { v3addScaled, vec3 } from '@hobo/shared'
import { meshForShape } from '../render/sceneSetup.js'

/**
 * Placement preview: a translucent ghost of the equipped placeable item,
 * following the crosshair onto world surfaces. Green = the server should
 * accept; red = zone forbids building here. Purely client-side comfort —
 * the placement itself goes through the `place` message and the server
 * re-validates everything.
 */

export interface GhostPose {
  x: number
  y: number
  z: number
  yaw: number
}

const _eye = vec3()
const _dir = vec3()
const _to = vec3()

export class PlacementGhost {
  private mesh: Mesh | null = null
  private meshDef: string | null = null
  private readonly okMat: StandardMaterial
  private readonly badMat: StandardMaterial
  private readonly zones: ZoneIndex
  /** Extra yaw applied by the player (wheel), relative to their facing. */
  private spin = 0
  /** Current pose when visible + buildable; null otherwise. */
  pose: GhostPose | null = null
  /** Pose is valid to send (zone allows building). */
  valid = false

  constructor(
    private readonly scene: Scene,
    private readonly physics: PhysicsWorld,
    private readonly content: ContentRegistry,
  ) {
    this.okMat = new StandardMaterial('ghost-ok', scene)
    this.okMat.diffuseColor = new Color3(0.35, 0.9, 0.45)
    this.okMat.emissiveColor = new Color3(0.1, 0.3, 0.12)
    this.okMat.alpha = 0.4
    this.badMat = new StandardMaterial('ghost-bad', scene)
    this.badMat.diffuseColor = new Color3(0.9, 0.3, 0.3)
    this.badMat.emissiveColor = new Color3(0.3, 0.08, 0.08)
    this.badMat.alpha = 0.4
    this.zones = new ZoneIndex(content.world.zones)
    this.zones.setMapZones(getMapOverride()?.zones ?? [])
  }

  /** Map edits can change zones live. */
  refreshZones(): void {
    this.zones.setMapZones(getMapOverride()?.zones ?? [])
  }

  rotate(delta: number): void {
    this.spin += delta
  }

  /**
   * Per-frame: shows the ghost for the equipped placeable def (or hides it
   * for null). Shift snaps position to the item's snapStep grid.
   */
  update(
    defId: string | null,
    eye: { x: number; y: number; z: number },
    viewDir: (out: typeof _dir) => void,
    playerYaw: number,
    snap: boolean,
  ): void {
    const def = defId ? this.content.item(defId) : undefined
    if (!def?.placeable || !def.world) {
      this.hide()
      return
    }
    _eye.x = eye.x
    _eye.y = eye.y
    _eye.z = eye.z
    viewDir(_dir)
    const range = def.placeable.maxRange
    v3addScaled(_to, _eye, _dir, range)
    const hit = this.physics.raycast(_eye, _to, CollisionLayer.Static | CollisionLayer.Prop)
    const point = hit ? { ...hit.point } : { ..._to }
    if (!hit) {
      // Nothing under the crosshair: rest the ghost on the terrain.
      point.y = terrainHeight(this.content.world, point.x, point.z)
    }
    const lift = shapeHalfHeight(def.world.shape)
    let x = point.x
    let z = point.z
    let y = point.y + lift
    const step = def.placeable.snapStep
    if (snap && step > 0) {
      x = Math.round(x / step) * step
      z = Math.round(z / step) * step
      y = Math.round(y / step) * step + 0.001
    }
    const yaw = playerYaw + this.spin
    const rules: ZoneRules = this.zones.rulesAt(vec3(x, y, z))
    this.valid = rules.build
    this.pose = { x, y, z, yaw }

    if (this.meshDef !== defId) {
      this.hide()
      this.mesh = meshForShape(this.scene, `ghost:${defId}`, def.world.shape, def.world.color)
      this.mesh.isPickable = false
      this.meshDef = defId
    }
    if (this.mesh) {
      this.mesh.setEnabled(true)
      this.mesh.position.set(x, y, z)
      if (this.mesh.rotationQuaternion) this.mesh.rotationQuaternion = null
      this.mesh.rotation.set(0, yaw, 0)
      this.mesh.material = this.valid ? this.okMat : this.badMat
    }
  }

  hide(): void {
    this.mesh?.dispose()
    this.mesh = null
    this.meshDef = null
    this.pose = null
    this.valid = false
  }
}

function shapeHalfHeight(shape: WorldShape): number {
  switch (shape.type) {
    case 'box':
      return shape.size[1] / 2
    case 'cylinder':
      return shape.height / 2
    case 'sphere':
      return shape.radius
  }
}
