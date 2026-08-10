export interface ServerConfig {
  port: number
  host: string
  dbPath: string
  /** Directory of built client assets to serve, or null for API/WS only. */
  staticDir: string | null
  mapPath: string
  editorKey: string | null
  hoboToolsAuthUrl: string | null
  tickRate: number
  /** Send a snapshot every N ticks. */
  snapshotEvery: number
  /** Entities beyond this distance from a player are not replicated to them. */
  interestRadius: number
  maxPlayers: number
  persistFlushSeconds: number
  metricsLogSeconds: number
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    port: intEnv(env, 'PORT', 8000),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? 'data/world.db',
    staticDir: env.STATIC_DIR ?? null,
    mapPath: env.MAP_PATH ?? 'data/map.json',
    /** Fallback admin secret for the map editor (until hobo.tools SSO). */
    editorKey: env.EDITOR_KEY ?? null,
    /** hobo.tools auth endpoint; when set, editor tokens validate there. */
    hoboToolsAuthUrl: env.HOBO_TOOLS_AUTH_URL ?? null,
    tickRate: 30,
    snapshotEvery: 2,
    interestRadius: intEnv(env, 'INTEREST_RADIUS', 80),
    maxPlayers: intEnv(env, 'MAX_PLAYERS', 64),
    persistFlushSeconds: intEnv(env, 'PERSIST_FLUSH_SECONDS', 10),
    metricsLogSeconds: intEnv(env, 'METRICS_LOG_SECONDS', 30),
  }
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value)) throw new Error(`invalid ${key}: ${raw}`)
  return value
}
