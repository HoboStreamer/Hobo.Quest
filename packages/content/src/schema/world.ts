import { z } from 'zod'
import { WorldShapeSchema } from './item.js'

/**
 * Static world definition: the level geometry both sides instantiate
 * identically (server for authority, client for rendering + prediction),
 * plus initial dynamic spawns the server creates on first boot only
 * (afterwards the persistent store is the source of truth).
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()])

export const StaticBodySchema = z.object({
  /** Stable editor/document id (selection, collab locks). */
  id: z.string().optional(),
  shape: WorldShapeSchema,
  pos: vec3,
  /** Yaw rotation; ignored when `rot` is present. */
  yaw: z.number().default(0),
  /** Full [pitchX, yawY, rollZ] euler rotation (surf ramps, tilted geometry). */
  rot: vec3.optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  /** Optional tiling texture (client rendering only; by asset basename). */
  tex: z.string().optional(),
  /** Optional client-side decoration kind (roofs, doors, fountain...). */
  decor: z.string().optional(),
  /** Imported model id (MapFile.models): client renders the glb, the shape
   *  above stays the physics proxy collider. */
  model: z.string().optional(),
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
  id: z.string().regex(/^[a-z0-9_]+$/),
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
