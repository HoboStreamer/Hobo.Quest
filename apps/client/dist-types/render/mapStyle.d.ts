import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Light } from '@babylonjs/core/Lights/light.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { FaceStyle, MapLight, MapTextureEntry, WorldShape } from '@hobo/content'
/**
 * Shared surface-styling + lighting for editor AND game: custom texture
 * registry (server-hosted or embedded), Hammer-style per-face materials on
 * box statics, and editor-placed map lights (all five Babylon light types,
 * optional shadow generators). Both scenes call the same functions so what
 * you see in the editor is what ships in game.
 */
export interface CustomTexInfo {
  url: string
  /** World meters covered by one texture tile (default 2). */
  scale?: number
}
export declare function registerCustomTextures(entries: MapTextureEntry[] | undefined): void
/** Resolve a texture reference ('red_brick' | 'custom:<name>' | 'none'). */
export declare function resolveTexInfo(name: string | undefined): CustomTexInfo | null
/** 'red_brick_diff_4k' → 'Red Brick' (display name, no prefixes/suffixes). */
export declare function prettyTexName(name: string): string
interface StyledBody {
  shape: WorldShape
  color: string
  tex?: string | undefined
  uv?: FaceStyle | undefined
  faces?: Record<string, FaceStyle> | undefined
}
/**
 * Apply the body's surface styling (texture/uv/per-face) to its mesh.
 * Plain-color bodies keep their shared cached material — zero cost.
 */
export declare function applyStaticStyle(scene: Scene, mesh: Mesh, s: StyledBody): void
/**
 * Terrain patch tiling: default keeps the classic ~4m tile; custom
 * textures honor their own meters-per-tile scale; uv overrides win.
 */
export declare function applyPatchTexture(
  tx: Texture,
  halfExtent: number,
  info: CustomTexInfo,
  uv?: FaceStyle,
): void
export declare const LIGHT_DEFAULTS: {
  color: string
  intensity: {
    point: number
    spot: number
    directional: number
    hemi: number
    rect: number
  }
  range: number
  angle: number
  exponent: number
  ground: string
  size: [number, number]
}
/** Instantiate ONE map light (editor uses this for live preview too). */
export declare function instantiateMapLight(scene: Scene, l: MapLight): Light | null
export {}
//# sourceMappingURL=mapStyle.d.ts.map
