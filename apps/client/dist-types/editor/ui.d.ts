/**
 * Editor UI widgets: drag-scrubbable number inputs (Blender-style) and a
 * thumbnail texture picker that replaces bare <select> dropdowns. Pure DOM
 * — no Babylon dependencies.
 */
/**
 * Blender/Unity-style numeric input: click-drag left/right scrubs the
 * value (Shift = fine), plain click focuses for typing, and ←/→/↑/↓ step
 * while focused. Dispatches 'input' during scrub and 'change' on release.
 */
export declare function makeScrubbable(input: HTMLInputElement): void
/** Make every number input under `root` scrubbable (idempotent). */
export declare function scrubAllNumbers(root: ParentNode): void
export interface TexOption {
  value: string
  label: string
  /** Thumbnail URL; null renders a flat color swatch. */
  thumb: string | null
}
export interface TexPicker {
  /** Re-read options (after uploads/renames) and sync the button. */
  refresh(): void
  /** Update the button after external `select.value = …` writes. */
  sync(): void
}
/**
 * Thumbnail dropdown bound to a hidden <select>: selecting a tile writes
 * select.value and fires 'change', so existing handlers keep working.
 */
export declare function createTexPicker(
  sel: HTMLSelectElement,
  getOptions: () => TexOption[],
): TexPicker
/**
 * Downscale an uploaded image to a web-friendly texture (≤2048px, JPEG).
 * Keeps 4k source files usable without shipping 10MB+ to every player.
 */
export declare function downscaleImage(
  file: File,
  maxDim?: number,
): Promise<{
  blob: Blob
  ext: 'jpg'
  width: number
  height: number
}>
//# sourceMappingURL=ui.d.ts.map
