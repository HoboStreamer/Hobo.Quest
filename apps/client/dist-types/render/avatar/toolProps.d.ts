import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
/**
 * Procedural third-person held-item props, attached to the avatar's right
 * hand. Deliberately chunky/readable at distance; the first-person
 * viewmodel is a separate, more detailed presentation.
 */
export type ToolPropKind = 'physgun' | 'axe' | 'pickaxe' | 'generic'
export interface ToolProp {
  root: TransformNode
  /** Beam origin for physgun-style tools. */
  muzzle: TransformNode
  dispose(): void
}
export declare function createToolProp(scene: Scene, kind: ToolPropKind, name: string): ToolProp
export declare function toolPropKindFor(
  itemDefId: string | undefined,
  toolKind: string | undefined,
): ToolPropKind | null
//# sourceMappingURL=toolProps.d.ts.map
