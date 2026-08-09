import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
import { type Appearance } from '@hobo/protocol'
/**
 * Pre-join character customization: a live 3D preview of the parametric
 * avatar in the world plaza with full appearance controls. Resolves with
 * the chosen name + appearance (persisted to localStorage).
 */
export declare function customizeScreen(
  scene: Scene,
  content: ContentRegistry,
  uiRoot: HTMLElement,
  savedName: string | null,
): Promise<{
  name: string
  appearance: Appearance
}>
//# sourceMappingURL=customizeScreen.d.ts.map
