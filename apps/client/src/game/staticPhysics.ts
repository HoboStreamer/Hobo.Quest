import {
  buildPatchGrid,
  buildTerrainGrid,
  getMapOverride,
  type ContentRegistry,
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
let patchBodies: BodyId[] = []

/** Terrain-patch trimeshes — kept in lockstep with the server's. */
function buildPatchPhysics(physics: PhysicsWorld): void {
  for (const patch of getMapOverride()?.terrains ?? []) {
    const grid = buildPatchGrid(patch.halfExtent, patch.sub, patch.heights)
    patchBodies.push(
      physics.addBody({
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
      }),
    )
  }
}

export function buildStaticPhysics(physics: PhysicsWorld, content: ContentRegistry): void {
  const world = content.world
  physics.addBody({
    shape: { type: 'box', size: [world.groundHalfExtent * 2, 1, world.groundHalfExtent * 2] },
    motion: 'static',
    pos: vec3(0, -2.0, 0),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  })
  buildPatchPhysics(physics)
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
  for (const s of world.statics) {
    // Same helper the server uses — scaled render and scaled collision or
    // neither, never one without the other.
    const shape = effectiveShape(s)
    physics.addBody({
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
}

let lastTerrainBody: BodyId | null = null

/** Live map edit: swap the prediction terrain body for the new grid. */
export function rebuildTerrainPhysics(physics: PhysicsWorld, content: ContentRegistry): void {
  if (lastTerrainBody !== null) physics.removeBody(lastTerrainBody)
  for (const b of patchBodies) physics.removeBody(b)
  patchBodies = []
  buildPatchPhysics(physics)
  lastTerrainBody = buildWorldTerrainBody(physics, content.world)
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
