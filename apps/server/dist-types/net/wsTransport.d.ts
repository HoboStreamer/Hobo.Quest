import type { Server } from 'node:http'
import { WebSocketServer } from 'ws'
import type { Logger } from '@hobo/shared'
import type { GameServer } from '../game/gameServer.js'
export declare function attachWebSocket(
  http: Server,
  game: GameServer,
  log: Logger,
): WebSocketServer
//# sourceMappingURL=wsTransport.d.ts.map
