import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
export declare class IconFactory {
  private readonly scene
  private readonly content
  onReady: (() => void) | null
  private readonly cache
  private readonly queued
  private chain
  constructor(scene: Scene, content: ContentRegistry)
  iconFor(defId: string): string
  private generate
}
//# sourceMappingURL=iconFactory.d.ts.map
