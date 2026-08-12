/**
 * The editor's authoring palettes and shared ids.
 *
 * Pure data: what the Mesh and Entity tools can place, which stock textures
 * exist, and how resource nodes are represented in the viewport. Kept out of
 * main.ts so adding a placeable is a data edit, not surgery on boot().
 */
import type { StaticBody } from '@hobo/content'
export type Tool = 'terrain' | 'paint' | 'entity' | 'mesh' | 'select' | 'face' | 'light'
export declare const newId: (prefix: string) => string
export interface Placeable {
  name: string
  kind: 'static' | 'node' | 'spawn' | 'model' | 'prop' | 'patch'
  shape?: StaticBody['shape']
  color?: string
  tex?: string
  decor?: string
  node?: string
  modelId?: string
}
/** Mesh tool: primitive shapes the user builds everything from (plus
 *  imported glb models, appended at runtime). No prefab world props —
 *  buildings, ramps and furniture are authored, not picked. */
export declare const PLACEABLES: Placeable[]
/** Entity tool: gameplay spawns — not geometry. */
export declare const ENTITY_DEFS: Placeable[]
export declare const TEXTURES: string[]
/** Visual stand-ins for resource nodes (matched loosely to the game's). */
export declare const NODE_LOOKS: Record<
  string,
  {
    color: string
    shape: StaticBody['shape']
  }
>
//# sourceMappingURL=catalog.d.ts.map
