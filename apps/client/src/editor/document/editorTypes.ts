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
  MapLightV2,
  MapNodeV2,
  MapPropV2,
  StaticObjectV2,
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
  | { kind: 'place'; body?: StaticObjectV2; node?: MapNodeV2 }
  | { kind: 'delete'; body?: StaticObjectV2; node?: MapNodeV2 }
  | { kind: 'edit'; body: StaticObjectV2; before: StaticObjectV2; after: StaticObjectV2 }
  | {
      kind: 'nodemove'
      node: MapNodeV2
      before: [number, number, number]
      after: [number, number, number]
    }
  | { kind: 'patchadd'; patch: PatchState }
  | { kind: 'patchdelete'; patch: PatchState }
  | {
      kind: 'propedit'
      add: boolean
      prop: MapPropV2
    }
  | {
      kind: 'batch'
      items: { body: StaticObjectV2; before: StaticObjectV2; after: StaticObjectV2 }[]
    }
  | {
      kind: 'propmove'
      prop: MapPropV2
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
  | { kind: 'lightadd'; light: MapLightV2 }
  | { kind: 'lightdelete'; light: MapLightV2 }
  | { kind: 'lightedit'; light: MapLightV2; before: MapLightV2; after: MapLightV2 }
  | { kind: 'batchdelete'; bodies: StaticObjectV2[] }
  | { kind: 'group'; label: string; ops: UndoOp[] }
  | {
      kind: 'patchedit'
      id: string
      before: { origin: [number, number, number]; rot?: [number, number, number] }
      after: { origin: [number, number, number]; rot?: [number, number, number] }
    }
