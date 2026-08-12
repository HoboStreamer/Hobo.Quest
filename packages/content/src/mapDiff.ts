/**
 * Stable-id diff between two map documents.
 *
 * Live map apply used to be "rebuild everything" (terrain) or "spawn anything
 * that has no live counterpart nearby" (nodes/props) or nothing at all
 * (statics, lights, zones). The first is wasteful — retinting a terrain tore
 * down and rebuilt its collision — the second is a proximity heuristic
 * pretending to be identity, and the third meant the editor's Save button
 * claimed to be live while half the map was not.
 *
 * With ids on every object the answer is exact: what appeared, what went, and
 * what changed. This is pure and engine-free so the server, the game client
 * and the editor all reconcile from the same computation, and a conflict
 * summary can be rendered from the same result.
 */
import type { MapFileV2 } from './mapFileV2.js'

export interface KindDiff<T> {
  added: T[]
  removed: T[]
  /** Objects present in both whose canonical value differs. */
  changed: { id: string; before: T; after: T; keys: string[] }[]
}

export interface MapDiff {
  terrains: KindDiff<MapFileV2['terrains'][number]>
  statics: KindDiff<MapFileV2['statics'][number]>
  nodes: KindDiff<MapFileV2['nodes'][number]>
  props: KindDiff<MapFileV2['props'][number]>
  lights: KindDiff<MapFileV2['lights'][number]>
  zones: KindDiff<MapFileV2['zones'][number]>
  models: KindDiff<MapFileV2['models'][number]>
  /** Spawn is a single value, so it is a before/after rather than a set. */
  spawn: {
    changed: boolean
    before: { pos?: [number, number, number]; yaw?: number }
    after: { pos?: [number, number, number]; yaw?: number }
  }
  /** True when nothing at all differs — the "repeated identical save" case. */
  empty: boolean
}

/** Deep value equality with key order ignored, matching the canonical wire. */
function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v))
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k]
      if (val === undefined) continue
      out[k] = sortValue(val)
    }
    return out
  }
  return v
}

/** Top-level keys whose values differ — lets a consumer skip work it can. */
function differingKeys(before: object, after: object): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: string[] = []
  for (const k of keys) {
    const a = (before as Record<string, unknown>)[k]
    const b = (after as Record<string, unknown>)[k]
    if (!sameValue(a, b)) out.push(k)
  }
  return out.sort()
}

function diffKind<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): KindDiff<T> {
  const byIdBefore = new Map(before.map((o) => [o.id, o]))
  const byIdAfter = new Map(after.map((o) => [o.id, o]))
  const diff: KindDiff<T> = { added: [], removed: [], changed: [] }
  for (const o of after) {
    const prev = byIdBefore.get(o.id)
    if (!prev) {
      diff.added.push(o)
      continue
    }
    // Array position is not identity, so a reorder is not a change.
    if (sameValue(prev, o)) continue
    diff.changed.push({ id: o.id, before: prev, after: o, keys: differingKeys(prev, o) })
  }
  for (const o of before) if (!byIdAfter.has(o.id)) diff.removed.push(o)
  return diff
}

const emptyKind = <T>(d: KindDiff<T>): boolean =>
  d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0

export function diffMapFileV2(previous: MapFileV2, next: MapFileV2): MapDiff {
  const spawnBefore = {
    ...(previous.spawn ? { pos: previous.spawn } : {}),
    ...(previous.spawnYaw !== undefined ? { yaw: previous.spawnYaw } : {}),
  }
  const spawnAfter = {
    ...(next.spawn ? { pos: next.spawn } : {}),
    ...(next.spawnYaw !== undefined ? { yaw: next.spawnYaw } : {}),
  }
  const diff: Omit<MapDiff, 'empty'> = {
    terrains: diffKind(previous.terrains, next.terrains),
    statics: diffKind(previous.statics, next.statics),
    nodes: diffKind(previous.nodes, next.nodes),
    props: diffKind(previous.props, next.props),
    lights: diffKind(previous.lights, next.lights),
    zones: diffKind(previous.zones, next.zones),
    models: diffKind(previous.models, next.models),
    spawn: {
      changed: !sameValue(spawnBefore, spawnAfter),
      before: spawnBefore,
      after: spawnAfter,
    },
  }
  return {
    ...diff,
    empty:
      !diff.spawn.changed &&
      emptyKind(diff.terrains) &&
      emptyKind(diff.statics) &&
      emptyKind(diff.nodes) &&
      emptyKind(diff.props) &&
      emptyKind(diff.lights) &&
      emptyKind(diff.zones) &&
      emptyKind(diff.models),
  }
}

/**
 * Which changed terrains need their COLLISION rebuilt, as opposed to only
 * their appearance. Retinting a surface must not tear down a heightfield
 * body: physics and rendering are separate costs and only one of them moved.
 */
const COLLISION_KEYS = new Set(['pos', 'rot', 'scale', 'heights', 'halfExtent', 'sub'])

export function affectsCollision(keys: readonly string[]): boolean {
  return keys.some((k) => COLLISION_KEYS.has(k))
}

/** A short human summary, for the revision-conflict dialog. */
export function describeDiff(diff: MapDiff): string[] {
  const lines: string[] = []
  const kinds = [
    ['terrain', diff.terrains],
    ['static', diff.statics],
    ['resource node', diff.nodes],
    ['prop', diff.props],
    ['light', diff.lights],
    ['zone', diff.zones],
    ['model', diff.models],
  ] as const
  for (const [name, d] of kinds) {
    const parts: string[] = []
    if (d.added.length) parts.push(`${d.added.length} added`)
    if (d.removed.length) parts.push(`${d.removed.length} removed`)
    if (d.changed.length) parts.push(`${d.changed.length} changed`)
    if (parts.length) lines.push(`${name}: ${parts.join(', ')}`)
  }
  if (diff.spawn.changed) lines.push('spawn point moved')
  return lines
}
