/**
 * Placing lights.
 *
 * `light` was in the Tool union, on the toolbar and in the keybindings, but
 * `ViewportInteraction` had no case for it — so choosing the Light tool fell
 * through to selection behaviour and clicking did nothing. The tool existed
 * in every list except the one that mattered.
 */
import type { MapLightV2 } from '@hobo/content'
import { newId } from '../catalog.js'

export type LightType = MapLightV2['type']

export interface LightPlacement {
  type: LightType
  color: string
  intensity: number
  /** Where the click landed, and the surface normal there. */
  point: [number, number, number]
  normal: [number, number, number]
}

/** How far off a surface a new light sits, so it is not inside the wall. */
const OFFSET = 1.5

/**
 * A light for the given click, with defaults that make it visible
 * immediately. A light placed with a range of 0 or pointing into the surface
 * it was dropped on looks broken, and the user has no way to tell whether
 * placement worked at all.
 */
export function lightForPlacement(p: LightPlacement): MapLightV2 {
  const pos: [number, number, number] = [
    p.point[0] + p.normal[0] * OFFSET,
    p.point[1] + p.normal[1] * OFFSET,
    p.point[2] + p.normal[2] * OFFSET,
  ]
  const base = {
    id: newId('light'),
    type: p.type,
    pos,
    color: p.color,
    intensity: p.intensity,
  } satisfies Partial<MapLightV2> & { id: string; type: LightType; pos: [number, number, number] }

  switch (p.type) {
    case 'point':
      return { ...base, range: 18 }
    case 'spot':
      // Aimed back along the surface normal — at the thing you clicked.
      return {
        ...base,
        dir: [-p.normal[0], -p.normal[1], -p.normal[2]],
        range: 24,
        angle: Math.PI / 4,
        exponent: 2,
        shadows: true,
      }
    case 'directional':
      // A sun: direction matters, position does not, so it is placed high
      // enough to read as one in the viewport.
      return {
        ...base,
        pos: [pos[0], Math.max(pos[1], 12), pos[2]],
        dir: [-0.3, -1, -0.2],
        shadows: true,
      }
    case 'hemi':
      return { ...base, dir: [0, 1, 0], ground: '#2b2a26' }
    case 'rect':
      return { ...base, dir: [-p.normal[0], -p.normal[1], -p.normal[2]], size: [4, 2] }
  }
}
