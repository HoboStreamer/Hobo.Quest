import '@babylonjs/core/Rendering/outlineRenderer.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
import { type BodyId, type PhysicsWorld } from '@hobo/physics'
import type { ServerSnapshot } from '@hobo/protocol'
import type { ClientState } from '../state/clientState.js'
import { Avatar } from './avatar/avatar.js'
export declare class EntityView {
  private readonly scene
  private readonly physics
  private readonly content
  private readonly state
  private readonly visuals
  private readonly entityByBody
  /** EMA of (serverTime - localTime) for the interpolation clock. */
  private clockOffset
  private lastUpdateTime
  constructor(scene: Scene, physics: PhysicsWorld, content: ContentRegistry, state: ClientState)
  entityIdForBody(bodyId: BodyId): string | undefined
  avatarFor(entityId: string): Avatar | null
  private add
  /** Static capsule matching the server's player body (short + lifted). */
  private addPlayerBody
  private remove
  /** Authoritative pin: freeze/settle transforms, resource depletion state. */
  private applyAuthoritative
  /** Feed a snapshot into interpolation buffers. */
  onSnapshot(snap: ServerSnapshot, localTime: number): void
  /** Per-frame: interpolate meshes/avatars toward buffered samples. */
  update(localTime: number): void
  /**
   * World position of a grab point given in an entity's local space (beam
   * endpoints stick to the touched spot, not the prop center).
   */
  grabPointOf(id: string, local: [number, number, number] | undefined): Vector3 | null
  positionOf(id: string): Vector3 | null
}
//# sourceMappingURL=entityView.d.ts.map
