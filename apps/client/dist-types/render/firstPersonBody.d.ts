import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
import type { Appearance } from '@hobo/protocol'
import type { LocalPlayer } from '../game/localPlayer.js'
import type { ClientState } from '../state/clientState.js'
export declare class FirstPersonBody {
  private readonly player
  private readonly state
  private readonly avatar
  constructor(
    scene: Scene,
    content: ContentRegistry,
    appearance: Appearance,
    player: LocalPlayer,
    state: ClientState,
  )
  setAppearance(appearance: Appearance): void
  triggerSwing(): void
  beamOrigin(): import('@babylonjs/core').Vector3
  update(
    dt: number,
    time: number,
    renderPos: {
      x: number
      y: number
      z: number
    },
    beamActive: boolean,
  ): void
  dispose(): void
}
//# sourceMappingURL=firstPersonBody.d.ts.map
