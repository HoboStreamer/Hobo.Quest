/**
 * Everything between the document and the server: save, revision conflicts,
 * remote adoption, drafts and asset uploads.
 *
 * Kept out of the composition root because it is the one part with real
 * sequencing — upload masks, then serialise, then If-Match, then interpret
 * the status — and because "did this overwrite someone else's work?" is
 * worth being able to read in one place.
 */
import { canonicalizeMapFile, type MapFileV2 } from '@hobo/content'
import type { EditorDocument } from '../document/editorDocument.js'
import type { CommandHistory } from '../history/commandHistory.js'
import type { PaintMask } from '../materials/paintMask.js'
export interface SaveControllerOptions {
  doc: EditorDocument
  history: CommandHistory<EditorDocument>
  bootRevision: string
  /** Adopt a whole remote/imported/restored document. */
  onAdopt: (map: MapFileV2) => void
  /** The live paint mask for a terrain, if it has one. */
  maskOf: (id: string) => PaintMask | null
  setMessage: (m: string) => void
}
export interface SaveController {
  save: () => Promise<void>
  pollRemote: () => Promise<void>
  isDirty: () => boolean
  revision: () => string
  serialize: () => MapFileV2
  exportMap: () => void
  importMap: (file: File) => Promise<void>
  conflict: () => {
    open: boolean
    summary: string[]
  }
  resolveConflict: (choice: 'theirs' | 'mine' | 'export') => void
  restoreDraftIfAny: () => Promise<void>
  onChange: (fn: () => void) => void
}
export declare function createSaveController(opts: SaveControllerOptions): SaveController
export { canonicalizeMapFile }
//# sourceMappingURL=saveController.d.ts.map
