import type { EditorDocument } from '../document/editorDocument.js'
import type { CommandHistory } from '../history/commandHistory.js'
import type { ModelCache } from './modelCache.js'
export interface UploadedAsset {
  url: string
  hash: string
  bytes: number
  mime: string
}
export interface AssetControllerOptions {
  doc: EditorDocument
  history: CommandHistory<EditorDocument>
  modelCache: ModelCache
  editorKey: () => string
  /** Re-register custom textures with the renderer after a change. */
  onAssetsChanged: () => void
  setMessage: (m: string) => void
}
/** Where a texture reference can appear in the document. */
export interface TextureUsage {
  count: number
  ids: string[]
}
/**
 * Every place a texture reference lives.
 *
 * The previous scan looked at terrain surfaces and `static.tex` only, so a
 * texture used exclusively by a painted box face or a per-face override
 * counted as unused — and "delete is refused while referenced" is worthless
 * if the reference count is wrong.
 */
export declare function collectTextureUsage(doc: EditorDocument): Map<string, TextureUsage>
export declare function collectModelUsage(doc: EditorDocument): Map<string, TextureUsage>
/** A filesystem-ish, collision-free texture name. */
export declare function sanitizeTextureName(raw: string, taken: (name: string) => boolean): string
export declare class AssetController {
  private readonly opts
  constructor(opts: AssetControllerOptions)
  /** POST raw bytes to the content-addressed store. */
  private upload
  textureUsage(): Map<string, TextureUsage>
  modelUsage(): Map<string, TextureUsage>
  importTexture(file: File): Promise<string | null>
  /**
   * Import a GLB. Bounds are DERIVED by instantiating it once through the
   * cache, which also warms it — placing the model afterwards needs no second
   * parse — rather than asking the user for numbers they cannot know.
   */
  importModel(file: File): Promise<string | null>
  deleteTexture(name: string): boolean
  deleteModel(id: string): boolean
  /**
   * Rename a texture and EVERY reference to it, atomically.
   *
   * References are `custom:<name>` strings scattered through terrain and
   * static surfaces, so renaming the entry alone would leave every user of it
   * pointing at a texture that no longer exists. One history entry, and undo
   * restores all of it.
   */
  renameTexture(from: string, to: string): boolean
}
//# sourceMappingURL=assetController.d.ts.map
