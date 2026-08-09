import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
import { DEFAULT_MOVEMENT } from '@hobo/gameplay'
import type { Appearance } from '@hobo/protocol'
import type { LocalPlayer } from '../game/localPlayer.js'
import type { ClientState } from '../state/clientState.js'
import { Avatar } from './avatar/avatar.js'

/**
 * DayZ-style body awareness: the local player's own avatar rendered from
 * the first-person camera — look down and you see your torso, arms and
 * legs, animated by the PREDICTED movement state (so it feels immediate,
 * not snapshot-delayed). The head is hidden, and the body sits slightly
 * behind the true eye so the chest never clips the near plane.
 */

const BODY_BACK_OFFSET = 0.14

export class FirstPersonBody {
  private readonly avatar: Avatar

  constructor(
    scene: Scene,
    content: ContentRegistry,
    appearance: Appearance,
    private readonly player: LocalPlayer,
    private readonly state: ClientState,
  ) {
    this.avatar = new Avatar(scene, content, appearance, 'fp-body')
    this.avatar.setHeadVisible(false)
  }

  setAppearance(appearance: Appearance): void {
    this.avatar.setAppearance(appearance)
    this.avatar.setHeadVisible(false)
  }

  triggerSwing(): void {
    this.avatar.triggerSwing()
  }

  beamOrigin() {
    return this.avatar.beamOrigin()
  }

  update(
    dt: number,
    time: number,
    renderPos: { x: number; y: number; z: number },
    beamActive: boolean,
  ): void {
    const move = this.player.move
    const speed = Math.hypot(move.vel.x, move.vel.z)
    const yaw = this.player.viewYaw
    const feetY = renderPos.y - DEFAULT_MOVEMENT.capsuleHeight / 2
    this.avatar.update({
      dt,
      time,
      x: renderPos.x - Math.sin(yaw) * BODY_BACK_OFFSET,
      y: feetY,
      z: renderPos.z - Math.cos(yaw) * BODY_BACK_OFFSET,
      yaw,
      pitch: this.player.viewPitch,
      speed,
      grounded: move.grounded,
      itemDef: this.state.activeItemDef() ?? undefined,
      beamActive,
    })
  }

  dispose(): void {
    this.avatar.dispose()
  }
}
