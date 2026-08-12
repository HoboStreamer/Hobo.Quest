/**
 * What an editor object IS, independent of how it is drawn.
 *
 * Kind metadata (label, icon, whether it can be transformed) and the
 * canonical transform get/set live here, over `EditorDocument`. Everything
 * that used to ask a Babylon mesh where an object was — the gizmo, the
 * inspector, the transform session, the Outliner — asks the document instead,
 * so a mesh being rebuilt cannot move anything.
 *
 * No Babylon imports: this is document logic. The projection lives in
 * `viewport/editorViewRegistry.ts`.
 */
import type { MapLightV2 } from '@hobo/content'
import { SPAWN_OBJECT_ID } from '@hobo/content'
import type { EditorDocument, EditorObject, EditorObjectKind } from './editorDocument.js'
import { eulerOf, transformFromEuler, type EditorTransform } from '../viewport/transformMath.js'

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

export const KIND_INFO: Record<EditorObjectKind, KindInfo> = {
  terrain: {
    label: 'Terrain',
    group: 'Terrain',
    icon: '⛰',
    transformable: true,
    rotatable: true,
    scalable: true,
  },
  static: {
    label: 'Geometry',
    group: 'Geometry',
    icon: '⬛',
    transformable: true,
    rotatable: true,
    scalable: true,
  },
  node: {
    label: 'Resource node',
    group: 'Gameplay',
    icon: '🌳',
    transformable: true,
    rotatable: false,
    scalable: false,
  },
  prop: {
    label: 'Prop',
    group: 'Gameplay',
    icon: '📦',
    transformable: true,
    rotatable: true,
    scalable: false,
  },
  light: {
    label: 'Light',
    group: 'Lights',
    icon: '💡',
    transformable: true,
    rotatable: true,
    scalable: false,
  },
  zone: {
    label: 'Zone',
    group: 'Zones',
    icon: '🟦',
    transformable: true,
    rotatable: false,
    scalable: true,
  },
  spawn: {
    label: 'Spawn point',
    group: 'Gameplay',
    icon: '🚩',
    transformable: true,
    rotatable: true,
    scalable: false,
  },
}

/** Author-facing name for the Outliner and the inspector title. */
export function displayName(kind: EditorObjectKind, object: EditorObject): string {
  const named = object as { name?: string }
  if (named.name) return named.name
  switch (kind) {
    case 'terrain':
      return `Terrain ${object.id}`
    case 'static': {
      const s = object as { shape: { type: string }; decor?: string; model?: string }
      if (s.model) return `Model ${object.id}`
      return `${s.decor ?? s.shape.type} ${object.id}`
    }
    case 'node':
      return (object as { node: string }).node
    case 'prop':
      return (object as { item: string }).item
    case 'light':
      return `${(object as MapLightV2).type} light`
    case 'spawn':
      return 'Spawn point'
    default:
      return object.id
  }
}

/** Rotation as a quaternion for a light's `dir` vector, and back. */
export function quatFromDir(dir: readonly number[] | undefined): [number, number, number, number] {
  if (!dir) return [0, 0, 0, 1]
  // Shortest rotation taking -Y (the beam axis) onto `dir`.
  const [x, y, z] = dir as [number, number, number]
  const len = Math.hypot(x, y, z) || 1
  const tx = x / len
  const ty = y / len
  const tz = z / len
  // from = (0,-1,0)
  const dot = -ty
  if (dot > 0.999999) return [0, 0, 0, 1]
  if (dot < -0.999999) return [1, 0, 0, 0] // 180° about X
  // cross(from, to)
  const cx = -1 * tz - 0 * ty
  const cy = 0 * tx - 0 * tz
  const cz = 0 * ty - -1 * tx
  const w = 1 + dot
  const n = Math.hypot(cx, cy, cz, w) || 1
  return [cx / n, cy / n, cz / n, w / n]
}

export function dirFromQuat(
  q: readonly [number, number, number, number],
): [number, number, number] {
  // Rotate (0,-1,0) by q.
  const [x, y, z, w] = q
  const vx = 0
  const vy = -1
  const vz = 0
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

const NEAR_ZERO = 1e-4

/**
 * The canonical transform of any document object.
 *
 * Every kind stores its pose differently on the wire — statics have
 * pos/yaw/rot/scale, terrains pos/rot/scale, nodes just a ground position,
 * lights a position and a direction vector, zones a min/max box — and the
 * gizmo should not know or care. This is the one translation.
 */
export function transformOf(doc: EditorDocument, id: string): EditorTransform | null {
  const kind = doc.typeOf(id)
  if (kind === null) return null
  const o = doc.get(id)
  if (!o) return null
  switch (kind) {
    case 'spawn': {
      const s = o as { pos: [number, number, number]; yaw: number }
      return transformFromEuler([...s.pos], [0, s.yaw, 0])
    }
    case 'terrain': {
      const t = o as { pos: [number, number, number]; rot?: number[]; scale?: number[] }
      return transformFromEuler(
        [...t.pos],
        (t.rot as [number, number, number]) ?? [0, 0, 0],
        (t.scale as [number, number, number]) ?? [1, 1, 1],
      )
    }
    case 'static': {
      const b = o as {
        pos: [number, number, number]
        yaw: number
        rot?: number[]
        scale?: number[]
      }
      return transformFromEuler(
        [...b.pos],
        (b.rot as [number, number, number]) ?? [0, b.yaw, 0],
        (b.scale as [number, number, number]) ?? [1, 1, 1],
      )
    }
    case 'node':
      return transformFromEuler([...(o as { pos: [number, number, number] }).pos], [0, 0, 0])
    case 'prop': {
      const p = o as { pos: [number, number, number]; yaw?: number }
      return transformFromEuler([...p.pos], [0, p.yaw ?? 0, 0])
    }
    case 'light': {
      const l = o as MapLightV2
      return { position: [...l.pos], rotation: quatFromDir(l.dir), scale: [1, 1, 1] }
    }
    case 'zone': {
      // A zone's gizmo drives its CENTRE; scale drives its half-extent, so
      // dragging a scale handle resizes the volume rather than stretching a
      // mesh that lies about where the rules apply.
      const z = o as { min: [number, number, number]; max: [number, number, number] }
      const centre: [number, number, number] = [
        (z.min[0] + z.max[0]) / 2,
        (z.min[1] + z.max[1]) / 2,
        (z.min[2] + z.max[2]) / 2,
      ]
      const half: [number, number, number] = [
        Math.max(NEAR_ZERO, (z.max[0] - z.min[0]) / 2),
        Math.max(NEAR_ZERO, (z.max[1] - z.min[1]) / 2),
        Math.max(NEAR_ZERO, (z.max[2] - z.min[2]) / 2),
      ]
      return { position: centre, rotation: [0, 0, 0, 1], scale: half }
    }
  }
}

/** Ground sampler, so nodes and props stay on the terrain when moved. */
export type GroundSampler = (x: number, z: number) => number

/**
 * Write a transform back into the document. Produces exactly the wire shape
 * each kind expects, dropping identity rotation/scale so a canonical save
 * does not gain noise on every drag.
 */
export function setTransform(doc: EditorDocument, id: string, t: EditorTransform): void {
  const kind = doc.typeOf(id)
  if (kind === null) return
  const e = eulerOf(t)
  const pos: [number, number, number] = [t.position[0]!, t.position[1]!, t.position[2]!]
  const rotated = Math.abs(e[0]) > NEAR_ZERO || Math.abs(e[2]) > NEAR_ZERO
  const scaled = t.scale.some((v) => Math.abs(v - 1) > NEAR_ZERO)
  const scale: [number, number, number] = [t.scale[0]!, t.scale[1]!, t.scale[2]!]

  switch (kind) {
    case 'spawn':
      doc.update(id, { pos, yaw: e[1] })
      return
    case 'terrain':
      doc.update(id, {
        pos,
        rot:
          Math.abs(e[0]) > NEAR_ZERO || Math.abs(e[1]) > NEAR_ZERO || Math.abs(e[2]) > NEAR_ZERO
            ? ([e[0], e[1], e[2]] as [number, number, number])
            : undefined,
        scale: scaled ? scale : undefined,
      })
      return
    case 'static':
      doc.update(id, {
        pos,
        yaw: e[1],
        rot: rotated ? ([e[0], e[1], e[2]] as [number, number, number]) : undefined,
        scale: scaled ? scale : undefined,
      })
      return
    case 'node':
      // Nodes sit ON the ground; only their footprint is authored.
      doc.update(id, { pos: [pos[0], 0, pos[2]] })
      return
    case 'prop':
      doc.update(id, { pos: [pos[0], 1, pos[2]], yaw: e[1] })
      return
    case 'light': {
      const l = doc.get(id, 'light')
      doc.update(id, {
        pos,
        ...(l && l.type !== 'point' ? { dir: dirFromQuat(t.rotation) } : {}),
      })
      return
    }
    case 'zone': {
      const half: [number, number, number] = [
        Math.max(NEAR_ZERO, Math.abs(scale[0])),
        Math.max(NEAR_ZERO, Math.abs(scale[1])),
        Math.max(NEAR_ZERO, Math.abs(scale[2])),
      ]
      doc.update(id, {
        min: [pos[0] - half[0], pos[1] - half[1], pos[2] - half[2]],
        max: [pos[0] + half[0], pos[1] + half[1], pos[2] + half[2]],
      })
      return
    }
  }
}

/** Ids that a gizmo may currently move. */
export function transformableIds(doc: EditorDocument, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const k = doc.typeOf(id)
    return k !== null && KIND_INFO[k].transformable
  })
}

export { SPAWN_OBJECT_ID }
