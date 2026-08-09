import { type Appearance, type ClientMessage, type ServerMessage } from '@hobo/protocol'
/**
 * WebSocket connection to the dedicated server. Message handling is a
 * callback so the network layer stays independent of game/state code.
 */
export declare class Connection {
  private ws
  onMessage: ((msg: ServerMessage) => void) | null
  onClose: (() => void) | null
  connect(url: string, token: string, name: string, appearance: Appearance): Promise<void>
  send(msg: ClientMessage): void
  get open(): boolean
}
/** Persistent anonymous identity (interim auth — see ADR-0004). */
export declare function getIdentity(): {
  token: string
  name: string | null
}
export declare function saveName(name: string): void
export declare function gameSocketUrl(): string
//# sourceMappingURL=connection.d.ts.map
