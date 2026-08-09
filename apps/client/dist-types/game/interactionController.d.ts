import { type PhysicsWorld } from '@hobo/physics'
import type { ContentRegistry } from '@hobo/content'
import type { Connection } from '../net/connection.js'
import type { EntityView } from '../render/entityView.js'
import type { ClientState } from '../state/clientState.js'
import type { InputAction } from '../input/inputTracker.js'
import type { LocalPlayer } from './localPlayer.js'
export interface AimTarget {
  entityId: string
  kind: 'prop' | 'resource'
  def: string | undefined
  frozen: boolean
  point: {
    x: number
    y: number
    z: number
  }
}
export declare class InteractionController {
  private readonly physics
  private readonly player
  private readonly view
  private readonly state
  private readonly content
  private readonly connection
  physgunActive: boolean
  private lastSwingMs
  private pendingRotate
  constructor(
    physics: PhysicsWorld,
    player: LocalPlayer,
    view: EntityView,
    state: ClientState,
    content: ContentRegistry,
    connection: Connection,
  )
  equippedToolKind(): 'physgun' | 'axe' | 'pickaxe' | 'hammer' | null
  /** What the crosshair points at right now (client-side, UX only). */
  aim(): AimTarget | null
  handle(action: InputAction): void
  /** Called once per fixed tick: flush coalesced rotation intent. */
  flushTick(): void
  onWheel(delta: number): void
  onHotbarChanged(): void
  private swing
  private tryPlace
}
//# sourceMappingURL=interactionController.d.ts.map
