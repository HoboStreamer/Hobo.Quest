import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ContentRegistry, ITEMS, RECIPES, TEST_WORLD } from '@hobo/content'
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
  const content = new ContentRegistry(ITEMS, RECIPES, TEST_WORLD)
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

  const http = createHttpServer(config.staticDir, metrics, log.child({ system: 'http' }))
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
