import { SPAWN_OBJECT_ID } from '@hobo/content'
import type { EditorDocument, EditorObject, EditorObjectKind } from './editorDocument.js'
import { type EditorTransform } from '../viewport/transformMath.js'
export interface KindInfo {
  label: string
  /** Outliner group heading. */
  group: string
  icon: string
  /** Whether the gizmo may move it. */
  transformable: boolean
  /** Whether rotation is meaningful (a resource node has no facing). */
  rotatable: boolean
  /** Whether non-uniform scale is meaningful. */
  scalable: boolean
}
export declare const KIND_INFO: Record<EditorObjectKind, KindInfo>
/** Author-facing name for the Outliner and the inspector title. */
export declare function displayName(kind: EditorObjectKind, object: EditorObject): string
/** Rotation as a quaternion for a light's `dir` vector, and back. */
export declare function quatFromDir(
  dir: readonly number[] | undefined,
): [number, number, number, number]
export declare function dirFromQuat(
  q: readonly [number, number, number, number],
): [number, number, number]
/**
 * The canonical transform of any document object.
 *
 * Every kind stores its pose differently on the wire — statics have
 * pos/yaw/rot/scale, terrains pos/rot/scale, nodes just a ground position,
 * lights a position and a direction vector, zones a min/max box — and the
 * gizmo should not know or care. This is the one translation.
 */
export declare function transformOf(doc: EditorDocument, id: string): EditorTransform | null
/** Ground sampler, so nodes and props stay on the terrain when moved. */
export type GroundSampler = (x: number, z: number) => number
/**
 * Write a transform back into the document. Produces exactly the wire shape
 * each kind expects, dropping identity rotation/scale so a canonical save
 * does not gain noise on every drag.
 */
export declare function setTransform(doc: EditorDocument, id: string, t: EditorTransform): void
/** Ids that a gizmo may currently move. */
export declare function transformableIds(doc: EditorDocument, ids: readonly string[]): string[]
export { SPAWN_OBJECT_ID }
//# sourceMappingURL=editorObject.d.ts.map
