/**
 * The paintable RGBA coverage mask behind a layered surface.
 *
 * Each of the four channels is one paint layer's coverage, so a brush stroke
 * writes to a single channel and cannot disturb the others — or the base
 * texture, which lives outside the mask entirely.
 *
 * Undo stores the changed RECTANGLE, not a whole-canvas snapshot: a small
 * stroke on a 512² mask costs a few KB instead of a megabyte, which is what
 * keeps the history memory budget realistic for painting.
 */
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { type PaintChannel } from '@hobo/content'
export declare const MASK_SIZE = 512
export interface MaskPatch {
  x: number
  y: number
  w: number
  h: number
  data: Uint8ClampedArray
}
export interface BrushStamp {
  /** Mask-space centre and radius, in pixels. */
  u: number
  v: number
  radius: number
  /** 0..1 coverage added (or removed when erasing) at the brush core. */
  strength: number
  /** Falloff exponent; higher = harder edge. */
  feather: number
  erase: boolean
}
export declare class PaintMask {
  readonly size: number
  readonly texture: DynamicTexture
  private readonly ctx
  /** Pending stroke bounds, accumulated so one stroke = one undo entry. */
  private strokeBox
  private strokeBefore
  constructor(scene: Scene, name: string, size?: number)
  /** Replace the mask contents from a loaded image. */
  drawImage(img: CanvasImageSource): void
  toDataURL(): string
  toBlob(): Promise<Blob | null>
  beginStroke(): void
  /**
   * Stamp the brush into one channel. Channels are edited independently, so
   * painting layer B never erases layer A and the base is never touched.
   */
  stamp(channel: PaintChannel, s: BrushStamp): void
  /**
   * Close the stroke and return the before/after patches for one history
   * entry, or null when the stroke changed nothing.
   */
  endStroke(): {
    before: MaskPatch
    after: MaskPatch
  } | null
  /** Apply a stored patch (undo/redo). */
  applyPatch(patch: MaskPatch): void
  /** Zero one channel — "clear layer mask" in the layer manager. */
  clearChannel(channel: PaintChannel): void
  dispose(): void
}
export declare const patchBytes: (p: MaskPatch) => number
//# sourceMappingURL=paintMask.d.ts.map
