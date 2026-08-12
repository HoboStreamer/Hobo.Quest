/**
 * Placing lights.
 *
 * `light` was in the Tool union, on the toolbar and in the keybindings, but
 * `ViewportInteraction` had no case for it — so choosing the Light tool fell
 * through to selection behaviour and clicking did nothing. The tool existed
 * in every list except the one that mattered.
 */
import type { MapLightV2 } from '@hobo/content'
export type LightType = MapLightV2['type']
export interface LightPlacement {
  type: LightType
  color: string
  intensity: number
  /** Where the click landed, and the surface normal there. */
  point: [number, number, number]
  normal: [number, number, number]
}
/**
 * A light for the given click, with defaults that make it visible
 * immediately. A light placed with a range of 0 or pointing into the surface
 * it was dropped on looks broken, and the user has no way to tell whether
 * placement worked at all.
 */
export declare function lightForPlacement(p: LightPlacement): MapLightV2
//# sourceMappingURL=lightTool.d.ts.map
