import { z } from 'zod'
import { WorldShapeSchema } from './item.js'

/**
 * Static world definition: the level geometry both sides instantiate
 * identically (server for authority, client for rendering + prediction),
 * plus initial dynamic spawns the server creates on first boot only
 * (afterwards the persistent store is the source of truth).
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()])
const finiteVec3 = vec3.refine((v) => v.every(Number.isFinite), 'must be finite')

/**
 * Canonical authored colour: lower-case six-digit hex. One definition shared
 * by every schema that carries a colour, so a value cannot be accepted by one
 * layer of the stack and rejected — or silently dropped — by another.
 */
export const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'must be #rrggbb lower-case hex')

/**
 * Editor-placed light. Covers every Babylon punctual/ambient light type:
 * point, spot (angle + exponent), directional (sun-like), hemispheric
 * (ambient dome with ground colour) and rectangular area lights.
 *
 * This is the ONE definition. The map wire used to validate lights as
 * `z.record(z.string(), z.unknown())` beside a hand-written interface of the
 * same name, so an authored light was checked nowhere and reached Babylon
 * malformed.
 */
export const MapLightSchema = z.object({
  /** Stable document id (selection, collab locks, live reconciliation). */
  id: z.string().min(1).max(64),
  type: z.enum(['point', 'spot', 'directional', 'hemi', 'rect']),
  pos: finiteVec3,
  /** Direction for spot/directional/hemi/rect (unit-ish vector). */
  dir: finiteVec3.optional(),
  color: HexColorSchema.optional(),
  specular: HexColorSchema.optional(),
  intensity: z.number().min(0).max(1000).optional(),
  /** Reach in metres (point/spot). */
  range: z.number().min(0).max(100_000).optional(),
  /** Spot cone angle in radians. */
  angle: z
    .number()
    .min(0)
    .max(Math.PI * 2)
    .optional(),
  /** Spot decay exponent. */
  exponent: z.number().min(0).max(1000).optional(),
  /** Hemispheric ground (bounce) colour. */
  ground: HexColorSchema.optional(),
  /** Rect area light [width, height] in metres. */
  size: z
    .tuple([z.number(), z.number()])
    .refine((v) => v.every((n) => Number.isFinite(n) && n > 0), 'rect size must be finite and > 0')
    .optional(),
  shadows: z.boolean().optional(),
})
export type MapLight = z.infer<typeof MapLightSchema>

/**
 * Hammer-style face/surface styling: texture + tint + UV transform.
 * On a box static these can be applied per face (keys '0'..'5', Babylon
 * face order); on any shape a single style applies to the whole surface.
 */
export const FaceStyleSchema = z.object({
  tex: z.string().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .optional(),
  /** Texture scale (tiles across the surface); 0/absent = auto. */
  sx: z.number().optional(),
  sy: z.number().optional(),
  /** Texture shift (UV offset, 0..1 wraps). */
  ox: z.number().optional(),
  oy: z.number().optional(),
  /** Texture rotation in radians. */
  rot: z.number().optional(),
})
export type FaceStyle = z.infer<typeof FaceStyleSchema>

export const StaticBodySchema = z.object({
  /** Stable editor/document id (selection, collab locks). */
  id: z.string().optional(),
  shape: WorldShapeSchema,
  pos: vec3,
  /** Yaw rotation; ignored when `rot` is present. */
  yaw: z.number().default(0),
  /** Full [pitchX, yawY, rollZ] euler rotation (surf ramps, tilted geometry). */
  rot: vec3.optional(),
  /**
   * Canonical scale, applied on top of the shape's authored dimensions.
   * Absent means [1,1,1]. Scale and dimensions are deliberately SEPARATE:
   * the inspector edits them independently, and `effectiveShape()` is the one
   * place that combines them so rendering and physics cannot drift apart.
   */
  scale: vec3.optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  /** Optional tiling texture (client rendering only; by asset basename). */
  tex: z.string().optional(),
  /** Optional client-side decoration kind (roofs, doors, fountain...). */
  decor: z.string().optional(),
  /** Imported model id (MapFile.models): client renders the glb, the shape
   *  above stays the physics proxy collider. */
  model: z.string().optional(),
  /** Whole-surface UV/texture transform (face-edit tool). */
  uv: FaceStyleSchema.optional(),
  /** Per-face overrides for box statics (face index '0'..'5'). */
  faces: z.record(z.string(), FaceStyleSchema).optional(),
})

export const ResourceNodeSpawnSchema = z.object({
  /** Resource node type id (see ResourceNodeTypeSchema). */
  node: z.string(),
  /** Ground position; the node type defines body shape/offset. */
  pos: vec3,
})

export const PropSpawnSchema = z.object({
  item: z.string(),
  pos: vec3,
  yaw: z.number().default(0),
})

export const ZoneDefSchema = z.object({
  /**
   * Stable zone id. Dashes are permitted so the map editor can mint ids in the
   * same `<kind>-<n>` shape it uses for every other document object.
   */
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  /** Axis-aligned box zone; richer volumes later. */
  min: vec3,
  max: vec3,
  /** Declarative rule flags — systems consult these; never `if (city)`. */
  rules: z.object({
    pvp: z.boolean().default(true),
    build: z.boolean().default(true),
    physgun: z.boolean().default(true),
  }),
})

export const WorldDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Ground plane half-extent, meters. */
  groundHalfExtent: z.number().positive(),
  spawnPoint: vec3,
  spawnYaw: z.number().default(0),
  /** Blank-slate world: terrain is a flat floor (map editor builds the rest). */
  flatTerrain: z.boolean().default(false),
  statics: z.array(StaticBodySchema),
  resourceNodes: z.array(ResourceNodeSpawnSchema),
  initialProps: z.array(PropSpawnSchema),
  zones: z.array(ZoneDefSchema),
})

export type WorldDef = z.infer<typeof WorldDefSchema>
export type ZoneDef = z.infer<typeof ZoneDefSchema>
export type StaticBody = z.infer<typeof StaticBodySchema>

/**
 * The shape a static ACTUALLY occupies: authored dimensions × canonical
 * scale. Client meshes, client prediction physics and server physics all go
 * through this, so a scaled object can never render at one size and collide
 * at another.
 */
export function effectiveShape(body: Pick<StaticBody, 'shape' | 'scale'>): StaticBody['shape'] {
  const s = body.scale
  if (!s || (s[0] === 1 && s[1] === 1 && s[2] === 1)) return body.shape
  const shape = body.shape
  if (shape.type === 'box')
    return {
      ...shape,
      size: [shape.size[0] * s[0], shape.size[1] * s[1], shape.size[2] * s[2]],
    }
  if (shape.type === 'cylinder')
    return {
      ...shape,
      radius: shape.radius * Math.max(Math.abs(s[0]), Math.abs(s[2])),
      height: shape.height * s[1],
    }
  return {
    ...shape,
    radius: shape.radius * Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])),
  }
}
