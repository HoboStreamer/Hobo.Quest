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
import { PAINT_CHANNELS, type PaintChannel } from '@hobo/content'

export const MASK_SIZE = 512

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

export class PaintMask {
  readonly texture: DynamicTexture
  private readonly ctx: CanvasRenderingContext2D
  /** Pending stroke bounds, accumulated so one stroke = one undo entry. */
  private strokeBox: { x0: number; y0: number; x1: number; y1: number } | null = null
  private strokeBefore: MaskPatch | null = null

  constructor(
    scene: Scene,
    name: string,
    readonly size = MASK_SIZE,
  ) {
    this.texture = new DynamicTexture(name, size, scene, false)
    this.ctx = this.texture.getContext() as unknown as CanvasRenderingContext2D
    // Fully transparent: nothing painted, base texture shows everywhere.
    this.ctx.clearRect(0, 0, size, size)
    this.texture.update()
  }

  /** Replace the mask contents from a loaded image. */
  drawImage(img: CanvasImageSource): void {
    this.ctx.clearRect(0, 0, this.size, this.size)
    this.ctx.drawImage(img, 0, 0, this.size, this.size)
    this.texture.update()
  }

  toDataURL(): string {
    return (this.ctx.canvas as HTMLCanvasElement).toDataURL('image/png')
  }

  async toBlob(): Promise<Blob | null> {
    const canvas = this.ctx.canvas as HTMLCanvasElement
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
  }

  beginStroke(): void {
    this.strokeBox = null
    this.strokeBefore = null
  }

  /**
   * Stamp the brush into one channel. Channels are edited independently, so
   * painting layer B never erases layer A and the base is never touched.
   */
  stamp(channel: PaintChannel, s: BrushStamp): void {
    const ci = PAINT_CHANNELS.indexOf(channel)
    if (ci < 0) return
    const r = Math.max(1, Math.ceil(s.radius))
    const x0 = Math.max(0, Math.floor(s.u - r))
    const y0 = Math.max(0, Math.floor(s.v - r))
    const x1 = Math.min(this.size, Math.ceil(s.u + r))
    const y1 = Math.min(this.size, Math.ceil(s.v + r))
    if (x1 <= x0 || y1 <= y0) return

    const w = x1 - x0
    const h = y1 - y0
    const img = this.ctx.getImageData(x0, y0, w, h)
    if (!this.strokeBefore) {
      this.strokeBefore = { x: x0, y: y0, w, h, data: new Uint8ClampedArray(img.data) }
      this.strokeBox = { x0, y0, x1, y1 }
    } else if (this.strokeBox) {
      // Widen the recorded region so the whole stroke is one undoable patch.
      this.strokeBox.x0 = Math.min(this.strokeBox.x0, x0)
      this.strokeBox.y0 = Math.min(this.strokeBox.y0, y0)
      this.strokeBox.x1 = Math.max(this.strokeBox.x1, x1)
      this.strokeBox.y1 = Math.max(this.strokeBox.y1, y1)
    }

    const data = img.data
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x0 + x - s.u
        const dy = y0 + y - s.v
        const d = Math.hypot(dx, dy)
        if (d > s.radius) continue
        const fall = Math.cos((d / s.radius) * Math.PI * 0.5) ** (2 * Math.max(0.05, s.feather))
        const delta = s.strength * fall * 255
        const idx = (y * w + x) * 4 + ci
        const cur = data[idx] ?? 0
        data[idx] = s.erase ? Math.max(0, cur - delta) : Math.min(255, cur + delta)
        // Keep alpha non-zero for RGB channels, or canvas premultiplication
        // silently discards the colour data we just wrote.
        if (ci !== 3) data[(y * w + x) * 4 + 3] = Math.max(data[(y * w + x) * 4 + 3] ?? 0, 1)
      }
    }
    this.ctx.putImageData(img, x0, y0)
    this.texture.update()
  }

  /**
   * Close the stroke and return the before/after patches for one history
   * entry, or null when the stroke changed nothing.
   */
  endStroke(): { before: MaskPatch; after: MaskPatch } | null {
    const box = this.strokeBox
    const first = this.strokeBefore
    this.strokeBox = null
    this.strokeBefore = null
    if (!box || !first) return null
    const w = box.x1 - box.x0
    const h = box.y1 - box.y0
    const after: MaskPatch = {
      x: box.x0,
      y: box.y0,
      w,
      h,
      data: new Uint8ClampedArray(this.ctx.getImageData(box.x0, box.y0, w, h).data),
    }
    // The "before" patch only covers the first stamp; widen it by re-reading
    // the surrounding pixels and pasting the original stamp region back in.
    const before: MaskPatch = {
      x: box.x0,
      y: box.y0,
      w,
      h,
      data: new Uint8ClampedArray(after.data),
    }
    for (let y = 0; y < first.h; y++) {
      for (let x = 0; x < first.w; x++) {
        const src = (y * first.w + x) * 4
        const dstX = first.x + x - box.x0
        const dstY = first.y + y - box.y0
        const dst = (dstY * w + dstX) * 4
        for (let c = 0; c < 4; c++) before.data[dst + c] = first.data[src + c]!
      }
    }
    return { before, after }
  }

  /** Apply a stored patch (undo/redo). */
  applyPatch(patch: MaskPatch): void {
    const img = this.ctx.createImageData(patch.w, patch.h)
    img.data.set(patch.data)
    this.ctx.putImageData(img, patch.x, patch.y)
    this.texture.update()
  }

  /** Zero one channel — "clear layer mask" in the layer manager. */
  clearChannel(channel: PaintChannel): void {
    const ci = PAINT_CHANNELS.indexOf(channel)
    if (ci < 0) return
    const img = this.ctx.getImageData(0, 0, this.size, this.size)
    for (let i = ci; i < img.data.length; i += 4) img.data[i] = 0
    this.ctx.putImageData(img, 0, 0)
    this.texture.update()
  }

  dispose(): void {
    this.texture.dispose()
  }
}

export const patchBytes = (p: MaskPatch): number => p.data.length
