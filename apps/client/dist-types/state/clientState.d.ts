import type { ServerMessage, WireEntity, WireInventory, WireSkill } from '@hobo/protocol'
import { TypedEmitter } from '@hobo/shared'
/**
 * Replicated game state as this client knows it, decoupled from both the
 * network layer (which writes it) and rendering/UI (which read it via
 * events or polling). No Babylon types in here.
 */
export interface ClientStateEvents {
  welcome: {
    entityId: string
    tickRate: number
  }
  entityAdded: WireEntity
  entityRemoved: string
  entityUpdated: WireEntity
  inventory: {
    inv: WireInventory
    activeHotbar: number
  }
  craftJobs: {
    recipe: string
    readyTick: number
  }[]
  actionResult: {
    action: string
    ok: boolean
    error?: string
  }
  physgunBeam: {
    player: string
    target: string | null
  }
  skills: WireSkill[]
  levelUp: {
    skill: string
    level: number
  }
  weldState: {
    a: string
    b: string
    active: boolean
  }
  friendsChanged: {
    id: string
    name: string
  }[]
  stats: {
    hp: number
    hunger: number
    thirst: number
    stamina: number
    died?: boolean
  }
  timeSync: number
  container: {
    id: string
    size: number
    slots: {
      i: number
      def: string
      count: number
    }[]
  }
  announce: string
  fx: {
    kind: 'hurt' | 'death'
    id: string
  }
  disconnected: undefined
  [key: string]: unknown
}
export declare class ClientState {
  readonly events: TypedEmitter<ClientStateEvents>
  readonly entities: Map<string, WireEntity>
  myEntityId: string
  /** hobo.tools rank from welcome (owner/admin/moderator, null = player). */
  myRank: 'owner' | 'admin' | 'moderator' | null
  myPlayerId: string
  /** Player ids I trust with my props. */
  friends: {
    id: string
    name: string
  }[]
  tickRate: number
  snapshotRate: number
  serverTick: number
  ack: number
  inventory: WireInventory | null
  activeHotbar: number
  /** Mirrors the server's holster toggle (same deterministic rules). */
  holstered: boolean
  craftJobs: {
    recipe: string
    readyTick: number
  }[]
  skills: WireSkill[]
  /** entityId -> holder player entityId, for beam/highlight rendering. */
  readonly heldBy: Map<string, string>
  /** Holder entity id -> grab point in the held body's local space. */
  readonly heldGrab: Map<string, [number, number, number]>
  stats: {
    hp: number
    hunger: number
    thirst: number
    stamina: number
  }
  /** Shared world clock (fraction of the day cycle). */
  dayFraction: number
  apply(msg: ServerMessage): void
  countOf(defId: string): number
  /** Item def id in the active hotbar slot (null when holstered). */
  activeItemDef(): string | null
  skillLevel(id: string): number
  isFriend(playerId: string): boolean
  /** Online players (from replicated player entities with identity meta). */
  onlinePlayers(): {
    playerId: string
    name: string
    entityId: string
  }[]
}
//# sourceMappingURL=clientState.d.ts.map
