/**
 * Editor-side document types.
 *
 * `PatchState` is a terrain object as the editor holds it in memory (heights
 * decoded, surface attached). `UndoOp` is the LEGACY mutation union: it is
 * bridged into CommandHistory as commands and shrinks as each mutation moves
 * to a real command. New work should add a command, not a variant here.
 */
import type {
  FaceStyle,
  MapLight,
  MapNodeSpawn,
  StaticBody,
  SurfaceMaterialData,
} from '@hobo/content'
import type { MaskPatch } from '../materials/paintMask.js'

export interface PatchState {
  id: string
  origin: [number, number, number]
  halfExtent: number
  sub: number
  heights: Float32Array
  rot?: [number, number, number]
  /** Canonical scale (X/Z footprint, Y height displacement). */
  scale?: [number, number, number]
  tex?: string
  color?: string
  /** Legacy three-way splat; migrated into `surface.paint` on first use. */
  mix?: string
  uv?: FaceStyle
  /** Base style + paint layers (the v2 surface model). */
  surface?: SurfaceMaterialData
}

export type UndoOp =
  | { kind: 'terrain'; target: string; before: Float32Array; after: Float32Array }
  | { kind: 'paint'; before: ImageData; after: ImageData }
  | { kind: 'place'; body?: StaticBody; node?: MapNodeSpawn }
  | { kind: 'delete'; body?: StaticBody; node?: MapNodeSpawn }
  | { kind: 'edit'; body: StaticBody; before: StaticBody; after: StaticBody }
  | {
      kind: 'nodemove'
      node: MapNodeSpawn
      before: [number, number, number]
      after: [number, number, number]
    }
  | { kind: 'patchadd'; patch: PatchState }
  | { kind: 'patchdelete'; patch: PatchState }
  | {
      kind: 'propedit'
      add: boolean
      prop: { item: string; pos: [number, number, number]; yaw?: number }
    }
  | { kind: 'batch'; items: { body: StaticBody; before: StaticBody; after: StaticBody }[] }
  | {
      kind: 'propmove'
      prop: { id?: string; item: string; pos: [number, number, number]; yaw?: number }
      before: [number, number, number]
      after: [number, number, number]
    }
  | {
      kind: 'spawnedit'
      before: [number, number, number] | null
      after: [number, number, number] | null
    }
  | {
      kind: 'patchprop'
      patch: PatchState
      before: { tex?: string; color?: string; uv?: FaceStyle }
      after: { tex?: string; color?: string; uv?: FaceStyle }
    }
  | { kind: 'maskpaint'; patchId: string; before: MaskPatch; after: MaskPatch }
  | { kind: 'lightadd'; light: MapLight }
  | { kind: 'lightdelete'; light: MapLight }
  | { kind: 'lightedit'; light: MapLight; before: MapLight; after: MapLight }
  | { kind: 'batchdelete'; bodies: StaticBody[] }
  | { kind: 'group'; label: string; ops: UndoOp[] }
  | { kind: 'mainconvert'; prev: Float32Array; patch: PatchState | null }
  | {
      kind: 'patchedit'
      id: string
      before: { origin: [number, number, number]; rot?: [number, number, number] }
      after: { origin: [number, number, number]; rot?: [number, number, number] }
    }
