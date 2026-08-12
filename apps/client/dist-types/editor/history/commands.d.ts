/**
 * The editor's commands, expressed against `EditorDocument`.
 *
 * These replace the `UndoOp` union and its 400-line `applyOp` switch. That
 * design stored Babylon `Mesh` references and live object references in undo
 * entries, so undoing a delete restored an object the meshes no longer knew
 * about, and every new feature meant a new variant plus a new branch that had
 * to remember to rebuild meshes, re-ground props and fix selection.
 *
 * A command here captures STABLE IDS and PLAIN VALUES — never a mesh, never a
 * live reference, never an array index. Applying one mutates the document;
 * views follow through the change feed on their own. Undo is therefore an
 * exact inverse by construction rather than by remembering to write the
 * mirror-image branch.
 */
import { compositeCommand, type EditorCommand } from './commandHistory.js'
import type { EditorDocument, EditorObject, EditorObjectKind } from '../document/editorDocument.js'
import type { EditorTransform } from '../viewport/transformMath.js'
import type { MaskPatch } from '../materials/paintMask.js'
export type DocCommand = EditorCommand<EditorDocument>
/** Create an object. Undo removes it; redo restores the same id and value. */
export declare function addObject(
  kind: EditorObjectKind,
  object: EditorObject,
  label?: string,
): DocCommand
/**
 * Delete an object. The full value is captured so undo restores it under the
 * SAME id — which is what keeps a delete/undo cycle from orphaning history
 * entries, locks or selection that referred to it.
 */
export declare function removeObject(
  doc: EditorDocument,
  id: string,
  label?: string,
): DocCommand | null
export declare function removeObjects(
  doc: EditorDocument,
  ids: readonly string[],
  label?: string,
): DocCommand | null
export declare function addObjects(
  entries: readonly {
    kind: EditorObjectKind
    object: EditorObject
  }[],
  label?: string,
): DocCommand | null
/**
 * Set properties on one object. Both sides are captured as whole values
 * because a partial patch cannot express "this key was absent before" —
 * which is exactly what undoing "give it a scale" has to restore.
 */
export declare function setProperties(
  doc: EditorDocument,
  id: string,
  patch: Record<string, unknown>,
  label?: string,
): DocCommand | null
/** Swap an object's whole value. */
export declare function replaceObject(
  doc: EditorDocument,
  id: string,
  after: EditorObject,
  label?: string,
): DocCommand | null
export declare function setPropertiesMany(
  doc: EditorDocument,
  ids: readonly string[],
  patch: Record<string, unknown>,
  label?: string,
): DocCommand | null
/**
 * Move/rotate/scale a set of objects. ONE entry per gesture: a gizmo drag
 * produces hundreds of intermediate poses and exactly one command.
 *
 * Coalescing folds a later transform of the SAME ids into this one, so a
 * numeric scrub is a single entry too — keeping the original `before`, which
 * is what makes one undo return to where the scrub started.
 */
export declare function transformObjects(
  ids: readonly string[],
  before: readonly EditorTransform[],
  after: readonly EditorTransform[],
  label?: string,
): DocCommand
/**
 * A terrain sculpt stroke, stored as the CHANGED RECTANGLE of the
 * heightfield rather than the whole field.
 *
 * A 512×512 terrain is a megabyte of Float32 per snapshot; storing two of
 * those per brush dab exhausts any sane history budget in seconds. A dab
 * touches a handful of samples, so that is what is kept.
 */
export interface HeightPatch {
  /** Column/row of the rectangle's top-left sample. */
  x: number
  y: number
  w: number
  h: number
  before: Float32Array
  after: Float32Array
}
/** Compute the minimal changed rectangle between two height fields. */
export declare function heightDelta(
  before: Float32Array,
  after: Float32Array,
  stride: number,
): HeightPatch | null
export declare function applyHeightPatch(
  target: Float32Array,
  stride: number,
  patch: HeightPatch,
  which: 'before' | 'after',
): void
/**
 * One terrain stroke. The heights live in the view's working buffer (decoded
 * Float32) as well as the document (base64), so the command is given both a
 * writer for the live buffer and the document id to re-encode.
 */
export declare function terrainSculpt(
  id: string,
  patch: HeightPatch,
  stride: number,
  write: (id: string, apply: (heights: Float32Array) => void) => void,
  label?: string,
): DocCommand
/** One paint stroke, as the mask's changed rectangle. */
export declare function paintStroke(
  id: string,
  surfaceId: string,
  before: MaskPatch,
  after: MaskPatch,
  write: (id: string, surfaceId: string, patch: MaskPatch) => void,
  label?: string,
): DocCommand
export { compositeCommand }
/**
 * Turn an inspector edit into a command. Vector components arrive as
 * `pos[1]`, and nested rule flags as `rules.pvp`, so both are written back
 * into a whole-object replacement — which is also what makes undo restore an
 * absent key rather than a zeroed one.
 */
export declare function buildPropertyCommand(
  doc: EditorDocument,
  ids: readonly string[],
  key: string,
  value: unknown,
): {
  execute: (d: EditorDocument) => void
  undo: (d: EditorDocument) => void
}
//# sourceMappingURL=commands.d.ts.map
