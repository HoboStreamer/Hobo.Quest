import {
  buildPatchGrid,
  buildTerrainGrid,
  getMapOverride,
  type ContentRegistry,
  type StaticBody,
  type TerrainPatchData,
  type WorldDef,
  effectiveShape,
  scalePatchPositions,
} from '@hobo/content'
import { CollisionLayer, type BodyId, type PhysicsWorld } from '@hobo/physics'
import { qfromEuler, qfromYaw, quat, vec3 } from '@hobo/shared'

/**
 * Mirrors the server's static collision geometry into the client physics
 * world so movement prediction sweeps hit the same surfaces. Both sides
 * build from the same world definition — divergence here would cause
 * constant mispredictions, so keep this in lockstep with GameWorld.
 */
/**
 * Terrain-patch trimeshes, keyed by stable id and kept in lockstep with the
 * server's `MapTerrainLayer` — including its signature, so both sides decide
 * to rebuild for exactly the same reasons. Divergence here means the player
 * mispredicts against ground the server disagrees about.
 */
const patchBodies = new Map<string, { body: BodyId; signature: string }>()

/** Same fields the server's signature covers; appearance is excluded. */
const patchSignature = (patch: TerrainPatchData): string =>
  JSON.stringify([
    patch.origin,
    patch.rot ?? null,
    patch.scale ?? null,
    patch.halfExtent,
    patch.sub,
    hashHeights(patch.heights),
  ])

function hashHeights(heights: Float32Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < heights.length; i++) {
    h ^= Math.round((heights[i] ?? 0) * 1000)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function addPatchBody(physics: PhysicsWorld, patch: TerrainPatchData): BodyId {
  const grid = buildPatchGrid(patch.halfExtent, patch.sub, patch.heights)
  return physics.addBody({
    shape: {
      type: 'trimesh',
      positions: scalePatchPositions(grid.positions, patch.scale),
      indices: grid.indices,
    },
    motion: 'static',
    pos: vec3(patch.origin[0], patch.origin[1], patch.origin[2]),
    rot: patch.rot ? qfromEuler(quat(), patch.rot[0], patch.rot[1], patch.rot[2]) : quat(),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  })
}

/** Reconcile prediction terrain collision, touching only what changed. */
export function reconcilePatchPhysics(physics: PhysicsWorld): void {
  const next = new Map<string, TerrainPatchData>()
  for (const patch of getMapOverride()?.terrains ?? []) if (patch.id) next.set(patch.id, patch)

  for (const [id, entry] of patchBodies) {
    const after = next.get(id)
    if (after && patchSignature(after) === entry.signature) continue
    physics.removeBody(entry.body)
    patchBodies.delete(id)
  }
  for (const [id, patch] of next) {
    if (patchBodies.has(id)) continue
    patchBodies.set(id, { body: addPatchBody(physics, patch), signature: patchSignature(patch) })
  }
}

/** How many terrain colliders prediction currently holds (tests). */
export const patchBodyCount = (): number => patchBodies.size

export function buildStaticPhysics(physics: PhysicsWorld, content: ContentRegistry): void {
  const world = content.world
  physics.addBody({
    shape: { type: 'box', size: [world.groundHalfExtent * 2, 1, world.groundHalfExtent * 2] },
    motion: 'static',
    pos: vec3(0, -2.0, 0),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  })
  reconcilePatchPhysics(physics)
  lastTerrainBody = buildWorldTerrainBody(physics, world)
  // Invisible boundary walls (must match the server exactly).
  const b = world.groundHalfExtent + 0.5
  const wallLen = b * 2 + 4
  for (const [px, pz, sx, sz] of [
    [0, b, wallLen, 1],
    [0, -b, wallLen, 1],
    [b, 0, 1, wallLen],
    [-b, 0, 1, wallLen],
  ] as const) {
    physics.addBody({
      shape: { type: 'box', size: [sx, 30, sz] },
      motion: 'static',
      pos: vec3(px, 10, pz),
      layer: CollisionLayer.Static,
      collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
    })
  }
  for (const s of world.statics) addStaticBody(physics, s)
  reconcileMapStaticPhysics(physics)
}

function addStaticBody(physics: PhysicsWorld, s: StaticBody): BodyId {
  // Same helper the server uses — scaled render and scaled collision or
  // neither, never one without the other.
  const shape = effectiveShape(s)
  return physics.addBody({
    shape:
      shape.type === 'box'
        ? { type: 'box', size: shape.size }
        : shape.type === 'cylinder'
          ? { type: 'cylinder', radius: shape.radius, height: shape.height }
          : { type: 'sphere', radius: shape.radius },
    motion: 'static',
    pos: vec3(s.pos[0], s.pos[1], s.pos[2]),
    rot: s.rot ? qfromEuler(quat(), s.rot[0], s.rot[1], s.rot[2]) : qfromYaw(quat(), s.yaw),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  })
}

/**
 * Prediction collision for the MAP's statics, keyed by stable id exactly like
 * the server's. Merged into base content it could never be replaced, so a
 * live save added collision the client never removed; rebuilt wholesale it
 * churned every collider whenever one texture changed.
 */
const mapStaticBodies = new Map<string, { body: BodyId; signature: string }>()

/** Only what collision depends on — appearance is excluded. */
const staticCollisionSignature = (s: StaticBody): string =>
  JSON.stringify([s.pos, s.rot ?? null, s.yaw, s.scale ?? null, s.shape])

export function reconcileMapStaticPhysics(physics: PhysicsWorld): void {
  const next = new Map<string, StaticBody>()
  for (const s of getMapOverride()?.statics ?? []) if (s.id) next.set(s.id, s)

  for (const [id, entry] of mapStaticBodies) {
    const after = next.get(id)
    if (after && staticCollisionSignature(after) === entry.signature) continue
    physics.removeBody(entry.body)
    mapStaticBodies.delete(id)
  }
  for (const [id, s] of next) {
    if (mapStaticBodies.has(id)) continue
    mapStaticBodies.set(id, {
      body: addStaticBody(physics, s),
      signature: staticCollisionSignature(s),
    })
  }
}

export const mapStaticBodyCount = (): number => mapStaticBodies.size

let lastTerrainBody: BodyId | null = null

/** Live map edit: swap the prediction terrain body for the new grid. */
export function rebuildTerrainPhysics(physics: PhysicsWorld, content: ContentRegistry): void {
  if (lastTerrainBody !== null) physics.removeBody(lastTerrainBody)
  reconcilePatchPhysics(physics)
  lastTerrainBody = buildWorldTerrainBody(physics, content.world)
  reconcileMapStaticPhysics(physics)
}

/**
 * The BASE WORLD's procedural terrain collider — the client-prediction twin of the
 * server body, and it must appear and disappear on exactly the same rule.
 *
 * Not built when a map is loaded: the map's own terrain objects ARE the
 * ground, and this grid resampled them onto a world-sized trimesh — a second
 * floor at every authored height, and for a map with NO terrain a flat sheet
 * at y = 0 that nothing rendered but everything stood on. A blank map must
 * genuinely have nothing to stand on.
 */
function buildWorldTerrainBody(physics: PhysicsWorld, world: WorldDef): BodyId | null {
  if (getMapOverride()) return null
  const grid = buildTerrainGrid(world)
  return physics.addBody({
    shape: { type: 'trimesh', positions: grid.positions, indices: grid.indices },
    motion: 'static',
    pos: vec3(0, 0, 0),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  })
}
