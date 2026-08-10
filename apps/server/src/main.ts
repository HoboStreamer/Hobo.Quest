import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createContent, mapFileToOverride, setMapOverride, type MapFile } from '@hobo/content'
import { openSqliteStore } from '@hobo/persistence/sqlite'
import { createHeadlessHavokWorld } from '@hobo/physics/havok'
import { createConsoleLogger } from '@hobo/shared'
import { loadConfig } from './config.js'
import { GameServer } from './game/gameServer.js'
import { GameWorld } from './game/gameWorld.js'
import { loadHavok } from './havokLoader.js'
import { createHttpServer } from './net/httpServer.js'
import { attachWebSocket } from './net/wsTransport.js'
import { ServerMetrics } from './observability/metrics.js'

/**
 * Dedicated authoritative server entry point.
 * Boot order: config -> content validation (fail fast) -> physics ->
 * persistence -> world restore -> network -> fixed-tick loop.
 */
async function main(): Promise<void> {
  const log = createConsoleLogger(
    { app: 'hobo-server' },
    process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  )
  const config = loadConfig(process.env)
  log.info('starting', { port: config.port, db: config.dbPath })

  // Content validates at construction — invalid definitions kill the boot.
  const content = createContent()
  // Edited map (from /editor): heightfield + extra statics replace the
  // procedural terrain for EVERYTHING (physics, spawns, clients fetch the
  // same file over /map.json).
  if (existsSync(config.mapPath)) {
    try {
      const raw = JSON.parse(readFileSync(config.mapPath, 'utf8')) as MapFile | null
      if (raw && raw.v === 1) {
        setMapOverride(mapFileToOverride(raw))
        content.world.statics.push(...raw.statics)
        log.info('edited map loaded', { statics: raw.statics.length, sub: raw.sub })
      }
    } catch (err) {
      log.warn('edited map unreadable — using procedural terrain', { error: String(err) })
    }
  }
  log.info('content loaded', {
    items: content.allItems().length,
    recipes: content.allRecipes().length,
    world: content.world.id,
  })

  const havok = await loadHavok()
  const physics = createHeadlessHavokWorld(havok)

  mkdirSync(dirname(config.dbPath), { recursive: true })
  const store = openSqliteStore(config.dbPath)

  const metrics = new ServerMetrics()
  const world = new GameWorld(content, physics, log.child({ system: 'world' }))
  world.seedOrRestore(store)

  const game = new GameServer(config, world, store, metrics, log.child({ system: 'game' }))

  const http = createHttpServer(
    config.staticDir,
    metrics,
    log.child({ system: 'http' }),
    config.mapPath,
    {
      key: config.editorKey,
      hoboToolsUrl: config.hoboToolsAuthUrl,
    },
    (body) => {
      // LIVE map apply: swap the heightfield under everyone's feet and tell
      // clients to refetch + rebuild. (Statics still need a restart; the
      // editor works on terrain/paint live.)
      try {
        const raw = JSON.parse(body) as MapFile | null
        if (raw && raw.v === 1) {
          setMapOverride(mapFileToOverride(raw))
          world.rebuildTerrain()
          game.broadcastMapReload()
          log.info('map applied live', { sub: raw.sub })
        }
      } catch (err) {
        log.warn('live map apply failed', { error: String(err) })
      }
    },
    (token) =>
      store.players
        .listByToken(token)
        .slice(0, 3)
        .map((p) => ({ slot: p.charSlot, name: p.name, appearance: p.appearance })),
  )
  attachWebSocket(http, game, log.child({ system: 'ws' }))
  http.listen(config.port, config.host, () => {
    log.info('listening', { host: config.host, port: config.port })
  })

  // Fixed-tick loop with drift correction — never tied to timers' jitter.
  const tickMs = 1000 / config.tickRate
  let nextTick = performance.now()
  let running = true
  const loop = (): void => {
    if (!running) return
    const now = performance.now()
    while (now >= nextTick) {
      game.step()
      nextTick += tickMs
      // If we fell far behind (debugger pause, EL stall), resync instead of
      // spiraling through hundreds of catch-up ticks.
      if (now - nextTick > 1000) nextTick = now + tickMs
    }
    setTimeout(loop, Math.max(0, nextTick - performance.now()))
  }
  loop()

  const metricsTimer = setInterval(() => metrics.logSummary(log), config.metricsLogSeconds * 1000)

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal })
    running = false
    clearInterval(metricsTimer)
    game.shutdown()
    store.close()
    http.close()
    physics.dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  console.error('fatal:', err)
  process.exit(1)
})
