import '@babylonjs/core/Rendering/outlineRenderer.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { ContentRegistry } from '@hobo/content'
import type { Appearance } from '@hobo/protocol'
import { defaultAppearance } from '@hobo/protocol'
import { AvatarAnimator } from './animator.js'
import { buildAvatarRig, type AvatarRig } from './rig.js'
import { createHeldItemNode, type HeldItemNode } from '../heldItem.js'

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
  /** Stance: 0 stand, 1 crouch, 2 prone. */
  stance?: number
  /** Equipped item def id (drives held prop + arm pose). */
  itemDef?: string | undefined
  beamActive?: boolean
}

const HURT_OVERLAY = new Color3(0.9, 0.12, 0.08)

export class Avatar {
  private rig: AvatarRig
  private animator: AvatarAnimator
  private toolProp: HeldItemNode | null = null
  private toolItemDef: string | undefined
  private headVisible = true
  private armsVisible = true

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
    this.rig.setArmsVisible(this.armsVisible)
  }

  setHeadVisible(visible: boolean): void {
    this.headVisible = visible
    this.rig.setHeadVisible(visible)
  }

  setArmsVisible(visible: boolean): void {
    this.armsVisible = visible
    this.rig.setArmsVisible(visible)
  }

  triggerFlinch(): void {
    this.animator.triggerFlinch()
  }

  private hurtTimer: ReturnType<typeof setTimeout> | null = null

  /** Red overlay pulse when this avatar takes damage. */
  flashHurt(strength: number): void {
    for (const mesh of this.rig.joints.root.getChildMeshes()) {
      mesh.renderOverlay = true
      mesh.overlayColor = HURT_OVERLAY
      mesh.overlayAlpha = strength
    }
    if (this.hurtTimer) clearTimeout(this.hurtTimer)
    this.hurtTimer = setTimeout(() => {
      for (const mesh of this.rig.joints.root.getChildMeshes()) mesh.renderOverlay = false
    }, 220)
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
      if (u.itemDef) {
        this.toolProp = createHeldItemNode(this.scene, this.content, u.itemDef, this.name)
        if (this.toolProp) {
          this.toolProp.root.parent = j.handR
          // Grip: +Z of the tool points along the forearm (hand's -Y), so a
          // raised arm aims the tool forward instead of leaving it glued
          // flat to the wrist.
          this.toolProp.root.position.set(0, -0.1, 0.04)
          this.toolProp.root.rotation.set(Math.PI / 2, 0, 0)
          this.toolProp.root.scaling.scaleInPlace(0.9)
        }
      }
    }

    const def = u.itemDef ? this.content.item(u.itemDef) : undefined
    this.animator.update({
      dt: u.dt,
      time: u.time,
      speed: u.speed,
      grounded: u.grounded,
      pitch: u.pitch,
      stance: u.stance ?? 0,
      tool: def?.tool?.kind ?? null,
      beamActive: u.beamActive ?? false,
    })
  }

  dispose(): void {
    this.toolProp?.dispose()
    this.rig.dispose()
  }
}
