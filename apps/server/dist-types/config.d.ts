export interface ServerConfig {
  port: number
  host: string
  dbPath: string
  /** Directory of built client assets to serve, or null for API/WS only. */
  staticDir: string | null
  mapPath: string
  editorKey: string | null
  hoboToolsAuthUrl: string | null
  /** Bind fresh guest tokens to client IPs (off in tests: peers share an IP). */
  guestIpBinding: boolean
  /** hobo.tools OAuth client (SSO); null until the secret is configured. */
  oauth: {
    clientId: string
    clientSecret: string
    baseUrl: string
    selfUrl: string
  } | null
  tickRate: number
  /** Send a snapshot every N ticks. */
  snapshotEvery: number
  /** Entities beyond this distance from a player are not replicated to them. */
  interestRadius: number
  maxPlayers: number
  persistFlushSeconds: number
  metricsLogSeconds: number
  /** Multiplier on world-event cadences (tests shrink it). */
  eventIntervalScale: number
}
export declare function loadConfig(env: NodeJS.ProcessEnv): ServerConfig
//# sourceMappingURL=config.d.ts.map
