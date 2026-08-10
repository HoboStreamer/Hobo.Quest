import type { Server } from 'node:http'
import { WebSocketServer } from 'ws'
import type { Logger } from '@hobo/shared'
import type { EditorAuth } from './httpServer.js'
export interface EditorHub {
  wss: WebSocketServer
  broadcastSaved(): void
}
export declare function attachEditorWs(http: Server, auth: EditorAuth, log: Logger): EditorHub
//# sourceMappingURL=editorWs.d.ts.map
