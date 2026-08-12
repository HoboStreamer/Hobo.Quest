/**
 * MapFile v2 — modular terrain, canonical transforms, validated on the way in.
 *
 * v1 had a MANDATORY top-level heightfield (`halfExtent` / `sub` / `heights` /
 * `mix`) that every map carried whether it wanted one or not. That single
 * privileged object leaked everywhere: `terrain:main` as a special selection
 * id, `mainSelected`, `mainconvert`, a "sunken" heights fill of -6 to fake
 * deletion, and an invisible collision plane that never really went away.
 *
 * In v2 there is no main terrain. `terrains[]` holds ordinary terrain objects,
 * every one with a stable id and a canonical transform, and a brand-new map is
 * genuinely empty.
 */
import { z } from 'zod'
import { FaceStyleSchema, StaticBodySchema, type FaceStyle } from './schema/world.js'
import {
  decodeHeights,
  encodeHeights,
  type MapFile,
  type MapLight,
  type MapTextureEntry,
} from './mapFile.js'
import type { MapOverride, TerrainPatchData } from './terrain.js'
import {
  MAX_PAINT_LAYERS,
  PAINT_CHANNELS,
  migrateLegacyMix,
  type SurfaceMaterialData,
} from './surface.js'

const vec3 = z.tuple([z.number(), z.number(), z.number()])
const finiteVec3 = vec3.refine((v) => v.every(Number.isFinite), 'must be finite')
/** Scale may be negative (mirroring) but never zero — that collapses a body. */
const scaleVec3 = vec3.refine(
  (v) => v.every((n) => Number.isFinite(n) && Math.abs(n) > 1e-4),
  'scale components must be finite and non-zero',
)

/**
 * Canonical authored colour: lower-case six-digit hex. One definition, used by
 * every schema that carries a tint, so a colour cannot be valid in one layer of
 * the stack and silently dropped by another.
 */
export const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'must be #rrggbb lower-case hex')

export const SurfaceStyleSchemaV2 = z.object({
  tex: z.string().max(120).optional(),
  color: HexColorSchema.optional(),
  uv: FaceStyleSchema.optional(),
})

export const PaintLayerSchemaV2 = z.object({
  id: z.string().min(1).max(64),
  /** Texture ref, or the sentinel 'none' for a plain-colour layer. */
  tex: z.string().min(1).max(120),
  /**
   * Tint multiplied into the layer; with `tex: 'none'` it IS the paint.
   * Absent means untinted (white) — see `surface.ts`. This MUST be validated
   * here: the v2 schema is the canonical wire, and a property the schema does
   * not know about is stripped on parse, silently discarding authored tint.
   */
  color: HexColorSchema.optional(),
  scale: z.number().positive().max(4096).optional(),
  channel: z.enum(PAINT_CHANNELS),
  hidden: z.boolean().optional(),
})

export const SurfacePaintSchemaV2 = z.object({
  layers: z.array(PaintLayerSchemaV2).max(MAX_PAINT_LAYERS),
  mask: z.string().max(16_000_000).optional(),
})

export const SurfaceMaterialSchemaV2 = z.object({
  base: SurfaceStyleSchemaV2,
  paint: SurfacePaintSchemaV2.optional(),
})

/** A terrain object: a local heightfield plus a world transform. */
export const TerrainObjectSchemaV2 = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(80).optional(),
  pos: finiteVec3,
  /** Euler [x, y, z] radians. */
  rot: finiteVec3.optional(),
  scale: scaleVec3.optional(),
  /** Half-width of the local grid, metres. */
  halfExtent: z.number().positive().max(4096),
  /** Grid subdivisions; (sub+1)^2 height samples. */
  sub: z.number().int().positive().max(512),
  /** base64 Float32 heights, little-endian. */
  heights: z.string(),
  surface: SurfaceMaterialSchemaV2.optional(),
})

export const MapFileV2Schema = z.object({
  v: z.literal(2),
  /** Monotonic per-save revision; the server stamps the canonical hash. */
  revision: z.string().max(128).optional(),
  terrains: z.array(TerrainObjectSchemaV2).max(4096),
  statics: z.array(StaticBodySchema).max(20_000),
  nodes: z
    .array(z.object({ id: z.string().optional(), node: z.string(), pos: finiteVec3 }))
    .max(20_000)
    .default([]),
  props: z
    .array(
      z.object({
        id: z.string().optional(),
        item: z.string(),
        pos: finiteVec3,
        yaw: z.number().optional(),
      }),
    )
    .max(20_000)
    .default([]),
  lights: z.array(z.record(z.string(), z.unknown())).max(256).default([]),
  models: z
    .array(z.object({ id: z.string(), name: z.string(), glb: z.string(), bounds: vec3 }))
    .max(512)
    .default([]),
  textures: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        dataUrl: z.string().optional(),
        url: z.string().optional(),
        scale: z.number().positive().optional(),
      }),
    )
    .max(512)
    .default([]),
  spawn: finiteVec3.optional(),
  spawnYaw: z.number().optional(),
})

export type MapFileV2 = z.infer<typeof MapFileV2Schema>
export type TerrainObjectV2 = z.infer<typeof TerrainObjectSchemaV2>

/** A brand-new map: genuinely empty, no starter island, no hidden ground. */
export function emptyMapV2(): MapFileV2 {
  return {
    v: 2,
    terrains: [],
    statics: [],
    nodes: [],
    props: [],
    lights: [],
    models: [],
    textures: [],
  }
}

/** Deterministic ids so a v1 map migrates to the SAME v2 ids every time. */
const legacyId = (kind: string, index: number): string => `${kind}-v1-${index}`
export const MAIN_TERRAIN_MIGRATED_ID = 'terrain-v1-main'

/**
 * v1 → v2. The privileged top-level heightfield becomes ONE ordinary terrain
 * object with a deterministic id; the old splat becomes paint layers with the
 * channel weights preserved, so an old map looks the same after migration.
 *
 * A v1 main terrain that was "deleted" by sinking every height below the
 * waterline is dropped rather than carried over as an invisible collider.
 */
export function migrateV1ToV2(v1: MapFile): MapFileV2 {
  const out = emptyMapV2()
  let layerSeq = 0
  const mkLayerId = (): string => `pl-v1-${layerSeq++}`

  const mainHeights = decodeHeights(v1.heights)
  const mainIsGone = mainHeights.every((h) => h <= -4.5)
  if (!mainIsGone) {
    out.terrains.push({
      id: MAIN_TERRAIN_MIGRATED_ID,
      name: 'Ground',
      pos: [0, 0, 0],
      halfExtent: v1.halfExtent,
      sub: v1.sub,
      heights: v1.heights,
      surface: {
        base: {},
        ...(v1.mix ? { paint: migrateLegacyMix(v1.mix, mkLayerId)! } : {}),
      },
    })
  }

  ;(v1.terrains ?? []).forEach((t, i) => {
    const base = {
      ...(t.tex && t.tex !== 'none' ? { tex: t.tex } : {}),
      ...(t.color ? { color: t.color } : {}),
      ...(t.uv ? { uv: t.uv } : {}),
    }
    out.terrains.push({
      id: t.id || legacyId('terrain', i),
      pos: t.origin,
      ...(t.rot ? { rot: t.rot } : {}),
      ...(t.scale ? { scale: t.scale } : {}),
      halfExtent: t.halfExtent,
      sub: t.sub,
      heights: t.heights,
      surface: t.surface ?? {
        base,
        ...(t.mix ? { paint: migrateLegacyMix(t.mix, mkLayerId)! } : {}),
      },
    })
  })

  out.statics = (v1.statics ?? []).map((b, i) => ({ ...b, id: b.id ?? legacyId('s', i) }))
  out.nodes = (v1.nodes ?? []).map((n, i) => ({ ...n, id: n.id ?? legacyId('n', i) }))
  out.props = (v1.props ?? []).map((p, i) => ({ ...p, id: p.id ?? legacyId('pr', i) }))
  out.lights = (v1.lights ?? []) as unknown as MapFileV2['lights']
  out.models = v1.models ?? []
  out.textures = (v1.textures ?? []) as MapTextureEntry[]
  if (v1.spawn) out.spawn = v1.spawn
  if (v1.spawnYaw !== undefined) out.spawnYaw = v1.spawnYaw
  return out
}

export type ParsedMap =
  { ok: true; map: MapFileV2; migrated: boolean } | { ok: false; issues: string[] }

/** Parse any accepted map version into v2, or report why it was rejected. */
export function parseMapFile(raw: unknown): ParsedMap {
  if (raw === null || typeof raw !== 'object') return { ok: false, issues: ['not an object'] }
  const version = (raw as { v?: unknown }).v
  if (version === 2) {
    const r = MapFileV2Schema.safeParse(raw)
    if (!r.success) return { ok: false, issues: r.error.issues.map(describeIssue) }
    const extra = validateMapFile(r.data)
    if (extra.length > 0) return { ok: false, issues: extra }
    return { ok: true, map: r.data, migrated: false }
  }
  if (version === 1) {
    const migrated = migrateV1ToV2(raw as MapFile)
    const r = MapFileV2Schema.safeParse(migrated)
    if (!r.success) return { ok: false, issues: r.error.issues.map(describeIssue) }
    return { ok: true, map: r.data, migrated: true }
  }
  return { ok: false, issues: [`unsupported map version ${String(version)}`] }
}

const describeIssue = (i: z.ZodIssue): string => `${i.path.join('.') || '(root)'}: ${i.message}`

/**
 * Cross-field checks the schema cannot express: duplicate ids, height counts
 * that disagree with the declared resolution, dangling asset references.
 */
export function validateMapFile(map: MapFileV2): string[] {
  const issues: string[] = []
  const seen = new Set<string>()
  const claim = (id: string, what: string): void => {
    if (seen.has(id)) issues.push(`duplicate id "${id}" (${what})`)
    seen.add(id)
  }
  const textureNames = new Set(map.textures.map((t) => `custom:${t.name}`))
  const knownTexture = (ref: string): boolean =>
    ref === 'none' || !ref.startsWith('custom:') || textureNames.has(ref)

  for (const t of map.terrains) {
    claim(t.id, 'terrain')
    const expected = (t.sub + 1) * (t.sub + 1)
    let actual = 0
    try {
      actual = decodeHeights(t.heights).length
    } catch {
      issues.push(`terrain "${t.id}": heights are not decodable base64`)
      continue
    }
    if (actual !== expected)
      issues.push(
        `terrain "${t.id}": ${actual} height samples, expected ${expected} for sub=${t.sub}`,
      )
    const surf = t.surface
    if (!surf) continue
    if (surf.base.tex && !knownTexture(surf.base.tex))
      issues.push(`terrain "${t.id}": missing base texture "${surf.base.tex}"`)
    const channels = new Set<string>()
    for (const l of surf.paint?.layers ?? []) {
      if (channels.has(l.channel))
        issues.push(`terrain "${t.id}": two paint layers on channel ${l.channel}`)
      channels.add(l.channel)
      if (!knownTexture(l.tex)) issues.push(`terrain "${t.id}": missing paint texture "${l.tex}"`)
    }
    if ((surf.paint?.layers.length ?? 0) > 0 && !surf.paint?.mask)
      issues.push(`terrain "${t.id}": paint layers without a mask`)
  }
  const modelIds = new Set(map.models.map((m) => m.id))
  for (const b of map.statics) {
    if (b.id) claim(b.id, 'static')
    if (b.model && !modelIds.has(b.model))
      issues.push(`static "${b.id ?? '?'}": references missing model "${b.model}"`)
    if (b.tex && !knownTexture(b.tex))
      issues.push(`static "${b.id ?? '?'}": missing texture "${b.tex}"`)
  }
  for (const n of map.nodes) if (n.id) claim(n.id, 'node')
  for (const p of map.props) if (p.id) claim(p.id, 'prop')
  for (const l of map.lights) {
    const id = (l as { id?: string }).id
    if (id) claim(id, 'light')
  }
  return issues
}

/**
 * Canonical serialisation: stable key order and no undefined members, so the
 * same document always hashes to the same revision.
 */
export function canonicalizeMapFile(map: MapFileV2): string {
  return JSON.stringify(sortValue(map))
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

/** Convenience for building terrain heights in tests and new objects. */
export function blankHeights(sub: number): string {
  return encodeHeights(new Float32Array((sub + 1) * (sub + 1)))
}

/** Light type re-export so consumers do not reach into v1. */
export type { MapLight }

/**
 * Compile an authored v2 map into the runtime representation the game and
 * client physics consume.
 *
 * This is the ONE boundary between authoring and runtime. It replaces the
 * former `v2 → fake v1 → MapOverride` chain, which fabricated a sunken
 * heightfield purely so v1 consumers would parse. Ids, transforms, scale,
 * surfaces and paint all survive; nothing is invented.
 *
 * No Babylon imports here — @hobo/content stays engine-free so the server can
 * use it headless.
 */
export function compileMapFileV2(map: MapFileV2): MapOverride {
  return {
    terrains: map.terrains.map((t): TerrainPatchData => ({
      id: t.id,
      origin: t.pos,
      halfExtent: t.halfExtent,
      sub: t.sub,
      heights: decodeHeights(t.heights),
      ...(t.rot ? { rot: t.rot } : {}),
      ...(t.scale ? { scale: t.scale } : {}),
      ...(t.surface ? { surface: t.surface as SurfaceMaterialData } : {}),
      // Legacy renderers still read these; they mirror the surface base.
      ...(t.surface?.base.tex ? { tex: t.surface.base.tex } : {}),
      ...(t.surface?.base.color ? { color: t.surface.base.color } : {}),
      ...(t.surface?.base.uv ? { uv: t.surface.base.uv as FaceStyle } : {}),
    })),
    nodes: map.nodes.map((n) => ({ node: n.node, pos: n.pos, ...(n.id ? { id: n.id } : {}) })),
    props: map.props.map((p) => ({
      item: p.item,
      pos: p.pos,
      ...(p.id ? { id: p.id } : {}),
      ...(p.yaw !== undefined ? { yaw: p.yaw } : {}),
    })),
    ...(map.spawn ? { spawn: map.spawn } : {}),
    ...(map.spawnYaw !== undefined ? { spawnYaw: map.spawnYaw } : {}),
  }
}
