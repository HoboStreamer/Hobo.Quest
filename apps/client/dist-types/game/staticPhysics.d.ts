import { type ContentRegistry } from '@hobo/content'
import { type PhysicsWorld } from '@hobo/physics'
/** Reconcile prediction terrain collision, touching only what changed. */
export declare function reconcilePatchPhysics(physics: PhysicsWorld): void
/** How many terrain colliders prediction currently holds (tests). */
export declare const patchBodyCount: () => number
export declare function buildStaticPhysics(physics: PhysicsWorld, content: ContentRegistry): void
export declare function reconcileMapStaticPhysics(physics: PhysicsWorld): void
export declare const mapStaticBodyCount: () => number
/** Live map edit: swap the prediction terrain body for the new grid. */
export declare function rebuildTerrainPhysics(physics: PhysicsWorld, content: ContentRegistry): void
//# sourceMappingURL=staticPhysics.d.ts.map
