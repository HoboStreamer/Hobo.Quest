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

const BODY_BACK_OFFSET = 0.08

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
    const pitch = this.player.viewPitch
    const feetY = renderPos.y - DEFAULT_MOVEMENT.capsuleHeight / 2
    // The camera pivots at the eyes; slide the body backward as the view
    // pitches down so looking down shows your chest and legs from above
    // instead of the inside of your own collar.
    const back = BODY_BACK_OFFSET + Math.max(0, -pitch) * 0.12
    this.avatar.update({
      dt,
      time,
      x: renderPos.x - Math.sin(yaw) * back,
      y: feetY,
      z: renderPos.z - Math.cos(yaw) * back,
      yaw,
      pitch: pitch * 0.3,
      speed,
      grounded: move.grounded,
      // The screen-space viewmodel represents the tool in first person; a
      // second copy in the body's hand would wave in front of the camera.
      itemDef: undefined,
      beamActive,
    })
  }

  dispose(): void {
    this.avatar.dispose()
  }
}
