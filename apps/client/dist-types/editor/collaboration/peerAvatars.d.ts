import type { Scene } from '@babylonjs/core/scene.js'
export declare class PeerAvatars {
  private readonly scene
  private readonly labelEl
  private readonly avatars
  constructor(scene: Scene, labelEl: HTMLElement)
  get count(): number
  /** Create or move a peer's avatar. */
  update(id: number, name: string, pos: number[], yaw: number, pitch: number): void
  remove(id: number): void
  private refreshLabel
  private create
}
//# sourceMappingURL=peerAvatars.d.ts.map
