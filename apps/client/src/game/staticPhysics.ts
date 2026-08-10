import { buildTerrainGrid, type ContentRegistry } from '@hobo/content'
import { CollisionLayer, type BodyId, type PhysicsWorld } from '@hobo/physics'
import { qfromEuler, qfromYaw, quat, vec3 } from '@hobo/shared'

/**
 * Mirrors the server's static collision geometry into the client physics
 * world so movement prediction sweeps hit the same surfaces. Both sides
 * build from the same world definition — divergence here would cause
 * constant mispredictions, so keep this in lockstep with GameWorld.
 */
export function buildStaticPhysics(physics: PhysicsWorld, content: ContentRegistry): void {
  const world = content.world
  physics.addBody({
    shape: { type: 'box', size: [world.groundHalfExtent * 2, 1, world.groundHalfExtent * 2] },
    motion: 'static',
    pos: vec3(0, -2.0, 0),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  })
  const grid = buildTerrainGrid(world)
  lastTerrainBody = physics.addBody({
    shape: { type: 'trimesh', positions: grid.positions, indices: grid.indices },
    motion: 'static',
    pos: vec3(0, 0, 0),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  })
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
    physics.addBody({
      shape:
        s.shape.type === 'box'
          ? { type: 'box', size: s.shape.size }
          : s.shape.type === 'cylinder'
            ? { type: 'cylinder', radius: s.shape.radius, height: s.shape.height }
            : { type: 'sphere', radius: s.shape.radius },
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
  const grid = buildTerrainGrid(content.world)
  lastTerrainBody = physics.addBody({
    shape: { type: 'trimesh', positions: grid.positions, indices: grid.indices },
    motion: 'static',
    pos: vec3(0, 0, 0),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  })
}
