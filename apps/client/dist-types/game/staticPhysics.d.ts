import { type ContentRegistry } from '@hobo/content'
import { type PhysicsWorld } from '@hobo/physics'
export declare function buildStaticPhysics(physics: PhysicsWorld, content: ContentRegistry): void
/**
 * Prediction collision for the MAP's statics, kept in its own replaceable
 * layer exactly like the server's. Merged into base content it could never be
 * replaced, so a live save added collision the client never removed.
 */
export declare function rebuildMapStaticPhysics(physics: PhysicsWorld): void
/** Live map edit: swap the prediction terrain body for the new grid. */
export declare function rebuildTerrainPhysics(physics: PhysicsWorld, content: ContentRegistry): void
//# sourceMappingURL=staticPhysics.d.ts.map
