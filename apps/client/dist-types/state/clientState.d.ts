import type { ServerMessage, WireEntity, WireInventory } from '@hobo/protocol'
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
  disconnected: undefined
  [key: string]: unknown
}
export declare class ClientState {
  readonly events: TypedEmitter<ClientStateEvents>
  readonly entities: Map<string, WireEntity>
  myEntityId: string
  tickRate: number
  snapshotRate: number
  serverTick: number
  ack: number
  inventory: WireInventory | null
  activeHotbar: number
  craftJobs: {
    recipe: string
    readyTick: number
  }[]
  /** entityId -> holder player entityId, for beam/highlight rendering. */
  readonly heldBy: Map<string, string>
  apply(msg: ServerMessage): void
  countOf(defId: string): number
}
//# sourceMappingURL=clientState.d.ts.map
