import { type PhysicsWorld } from '@hobo/physics'
import type { ContentRegistry } from '@hobo/content'
import type { Connection } from '../net/connection.js'
import type { EntityView } from '../render/entityView.js'
import type { ClientState } from '../state/clientState.js'
import type { InputAction, InputTracker } from '../input/inputTracker.js'
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
  private readonly input
  physgunActive: boolean
  /** Hold-E rotate mode while carrying (mouse steers the prop, not the view). */
  rotating: boolean
  /** Cosmetic hook: a swing was sent (viewmodel + body animation). */
  onSwing: (() => void) | null
  private lastSwingMs
  private pendingRotate
  private gridOn
  constructor(
    physics: PhysicsWorld,
    player: LocalPlayer,
    view: EntityView,
    state: ClientState,
    content: ContentRegistry,
    connection: Connection,
    input: InputTracker,
  )
  equippedToolKind(): 'physgun' | 'axe' | 'pickaxe' | 'hammer' | null
  /** What the crosshair points at right now (client-side, UX only). */
  aim(): AimTarget | null
  handle(action: InputAction): void
  private endCarry
  /** Called once per fixed tick: flush coalesced rotate + grid-lock state. */
  flushTick(): void
  onWheel(delta: number): void
  onHotbarChanged(): void
  private swing
}
//# sourceMappingURL=interactionController.d.ts.map
