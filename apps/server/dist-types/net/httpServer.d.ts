import { type Server } from 'node:http'
import type { Logger } from '@hobo/shared'
import type { ServerMetrics } from '../observability/metrics.js'
export interface EditorAuth {
  /** Shared-secret fallback. */
  key: string | null
  /** hobo.tools session endpoint; token validated there when configured. */
  hoboToolsUrl: string | null
}
/** hobo.tools OAuth2 client — powers the /auth/login → /auth/callback flow. */
export interface OAuthConfig {
  clientId: string
  clientSecret: string
  /** Public hobo.tools base, e.g. https://hobo.tools */
  baseUrl: string
  /** Our public base, e.g. https://hobo.quest (redirect_uri host). */
  selfUrl: string
}
export declare function createHttpServer(
  staticDir: string | null,
  metrics: ServerMetrics,
  log: Logger,
  mapPath?: string,
  editorAuth?: EditorAuth,
  onMapSaved?: (body: string) => void,
  listCharacters?: (
    token: string,
    auth: string | undefined,
  ) => Promise<
    {
      slot: number
      name: string
      appearance: unknown
    }[]
  >,
  oauth?: OAuthConfig | null,
): Server
//# sourceMappingURL=httpServer.d.ts.map
