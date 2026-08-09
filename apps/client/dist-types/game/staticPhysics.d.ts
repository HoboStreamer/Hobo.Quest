import type { ContentRegistry } from '@hobo/content'
import { type PhysicsWorld } from '@hobo/physics'
/**
 * Mirrors the server's static collision geometry into the client physics
 * world so movement prediction sweeps hit the same surfaces. Both sides
 * build from the same world definition — divergence here would cause
 * constant mispredictions, so keep this in lockstep with GameWorld.
 */
export declare function buildStaticPhysics(physics: PhysicsWorld, content: ContentRegistry): void
//# sourceMappingURL=staticPhysics.d.ts.map
