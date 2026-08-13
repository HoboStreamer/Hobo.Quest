import { type PhysicsWorld } from '@hobo/physics'
import { type ContentRegistry } from '@hobo/content'
import type { Connection } from '../net/connection.js'
import type { EntityView } from '../render/entityView.js'
import type { ClientState } from '../state/clientState.js'
import type { InputAction, InputTracker } from '../input/inputTracker.js'
import type { LocalPlayer } from './localPlayer.js'
import type { WeaponSettings } from '../weapons/registry.js'
export interface AimTarget {
  entityId: string
  kind: 'prop' | 'resource' | 'player' | 'npc'
  def: string | undefined
  frozen: boolean
  point: {
    x: number
    y: number
    z: number
  }
  /** Surface normal at the hit (rigging tool takes joint axes from it). */
  normal: {
    x: number
    y: number
    z: number
  }
}
/** First endpoint picked with the rigging tool (awaiting the second). */
export interface RiggingPick {
  entityId: string
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
  private readonly weaponSettings
  physgunActive: boolean
  /** Hold-E rotate mode while carrying (mouse steers the prop, not the view). */
  rotating: boolean
  /** Cosmetic hook: a swing was sent (viewmodel + body animation). */
  onSwing: (() => void) | null
  /** True when the last 'use' this client sent targeted another player. */
  lastTargetWasPlayer: boolean
  /** Hook: player pressed E on a trading post (entity id passed along). */
  onShopOpen: ((targetId: string) => void) | null
  /** Rigging tool: first selected endpoint (highlight + prompt read this). */
  riggingFirst: RiggingPick | null
  /** Ghost preview pose supplier (wired by main; null = no valid ghost). */
  placementPose:
    | (() => {
        x: number
        y: number
        z: number
        yaw: number
      } | null)
    | null
  /** Wheel rotates the placement ghost while a placeable is equipped. */
  onPlacementRotate: ((delta: number) => void) | null
  private lastSwingMs
  private lastFireMs
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
    weaponSettings: WeaponSettings,
  )
  /** Chassis entity id currently driven (server-authoritative). */
  drivingId(): string | null
  equippedToolKind(): 'physgun' | 'axe' | 'pickaxe' | 'rigging' | null
  /** What the crosshair points at right now (client-side, UX only). */
  aim(): AimTarget | null
  /**
   * Where the beam visually ends right now: first surface (world or prop)
   * under the crosshair, else max range. The beam always fires — hitting
   * nothing is not an error, it just shines (GMod).
   */
  beamTarget(out: { x: number; y: number; z: number }): void
  handle(action: InputAction): void
  private endCarry
  /** Called once per fixed tick: flush coalesced rotate + grid-lock state. */
  flushTick(): void
  onWheel(delta: number): void
  onHotbarChanged(): void
  /**
   * Rigging tool LMB: first click marks an endpoint, second click sends the
   * constraint request built from the equipment-panel settings. The server
   * re-validates everything (points, ownership, skill, materials, zone).
   */
  private riggingPick
  private swing
  /** Standing in water (thirst refill by drinking). */
  standingInWater(): boolean
}
//# sourceMappingURL=interactionController.d.ts.map
