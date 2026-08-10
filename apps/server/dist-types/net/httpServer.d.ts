import { type Server } from 'node:http'
import type { Logger } from '@hobo/shared'
import type { ServerMetrics } from '../observability/metrics.js'
export interface EditorAuth {
  /** Shared-secret fallback. */
  key: string | null
  /** hobo.tools session endpoint; token validated there when configured. */
  hoboToolsUrl: string | null
}
export declare function createHttpServer(
  staticDir: string | null,
  metrics: ServerMetrics,
  log: Logger,
  mapPath?: string,
  editorAuth?: EditorAuth,
  onMapSaved?: (body: string) => void,
  listCharacters?: (token: string) => {
    slot: number
    name: string
    appearance: unknown
  }[],
): Server
//# sourceMappingURL=httpServer.d.ts.map
