import type { ContentRegistry } from '@hobo/content'
import { CollisionLayer, type PhysicsWorld } from '@hobo/physics'
import { qfromYaw, quat, vec3 } from '@hobo/shared'

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
    pos: vec3(0, -0.5, 0),
    layer: CollisionLayer.Static,
    collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
  })
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
      rot: qfromYaw(quat(), s.yaw),
      layer: CollisionLayer.Static,
      collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
    })
  }
}
