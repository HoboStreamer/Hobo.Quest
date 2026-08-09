import type { Scene } from '@babylonjs/core/scene.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { ContentRegistry } from '@hobo/content'
import type { Appearance } from '@hobo/protocol'
import { defaultAppearance } from '@hobo/protocol'
import { AvatarAnimator } from './animator.js'
import { buildAvatarRig, type AvatarRig } from './rig.js'
import { createToolProp, toolPropKindFor, type ToolProp } from './toolProps.js'

/**
 * A complete animated player character: parametric rig + procedural
 * animator + held-item prop. Used identically for remote players, the
 * local first-person body (head hidden), and the customization preview.
 */

export interface AvatarUpdate {
  dt: number
  time: number
  x: number
  /** FEET height (capsule bottom). */
  y: number
  z: number
  yaw: number
  pitch: number
  speed: number
  grounded: boolean
  /** Equipped item def id (drives held prop + arm pose). */
  itemDef?: string | undefined
  beamActive?: boolean
}

export class Avatar {
  private rig: AvatarRig
  private animator: AvatarAnimator
  private toolProp: ToolProp | null = null
  private toolItemDef: string | undefined
  private headVisible = true

  constructor(
    private readonly scene: Scene,
    private readonly content: ContentRegistry,
    private appearance: Appearance,
    private readonly name: string,
  ) {
    this.rig = buildAvatarRig(scene, appearance, name)
    this.animator = new AvatarAnimator(this.rig.joints)
  }

  static appearanceOrDefault(a: Appearance | undefined): Appearance {
    return a ?? defaultAppearance()
  }

  get eyeHeight(): number {
    return this.rig.eyeHeight
  }

  get rootPosition(): Vector3 {
    return this.rig.joints.root.position
  }

  /** Rebuilds the rig (customization preview edits). Preserves pose state loosely. */
  setAppearance(appearance: Appearance): void {
    this.appearance = appearance
    this.rig.dispose()
    this.toolProp?.dispose()
    this.toolProp = null
    this.toolItemDef = undefined
    this.rig = buildAvatarRig(this.scene, appearance, this.name)
    this.animator = new AvatarAnimator(this.rig.joints)
    this.rig.setHeadVisible(this.headVisible)
  }

  setHeadVisible(visible: boolean): void {
    this.headVisible = visible
    this.rig.setHeadVisible(visible)
  }

  triggerSwing(): void {
    this.animator.triggerSwing()
  }

  /** World position the physgun beam should start from (hand/muzzle). */
  beamOrigin(): Vector3 {
    const node = this.toolProp?.muzzle ?? this.rig.joints.handR
    return node.getAbsolutePosition()
  }

  update(u: AvatarUpdate): void {
    const j = this.rig.joints
    j.root.position.set(u.x, u.y, u.z)
    j.root.rotation.y = u.yaw

    if (u.itemDef !== this.toolItemDef) {
      this.toolItemDef = u.itemDef
      this.toolProp?.dispose()
      this.toolProp = null
      const def = u.itemDef ? this.content.item(u.itemDef) : undefined
      const kind = toolPropKindFor(u.itemDef, def?.tool?.kind)
      if (kind) {
        this.toolProp = createToolProp(this.scene, kind, this.name)
        this.toolProp.root.parent = j.handR
        // Grip: +Z of the tool points along the forearm (hand's -Y), so a
        // raised arm aims the tool forward instead of leaving it glued flat
        // to the wrist.
        this.toolProp.root.position.set(0, -0.1, 0.04)
        this.toolProp.root.rotation.set(Math.PI / 2, 0, 0)
        this.toolProp.root.scaling.setAll(0.9)
      }
    }

    const def = u.itemDef ? this.content.item(u.itemDef) : undefined
    this.animator.update({
      dt: u.dt,
      time: u.time,
      speed: u.speed,
      grounded: u.grounded,
      pitch: u.pitch,
      tool: def?.tool?.kind ?? null,
      beamActive: u.beamActive ?? false,
    })
  }

  dispose(): void {
    this.toolProp?.dispose()
    this.rig.dispose()
  }
}
