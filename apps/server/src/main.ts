import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { compileMapFileV2, createContent, parseMapFile, setMapOverride } from '@hobo/content'
import { openSqliteStore } from '@hobo/persistence/sqlite'
import { createHeadlessHavokWorld } from '@hobo/physics/havok'
import { createConsoleLogger } from '@hobo/shared'
import { loadConfig } from './config.js'
import { GameServer } from './game/gameServer.js'
import { GameWorld } from './game/gameWorld.js'
import { loadHavok } from './havokLoader.js'
import { attachEditorWs } from './net/editorWs.js'
import { createHttpServer } from './net/httpServer.js'
import { resolveHoboToolsUser } from './net/hoboToolsAuth.js'
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
      // v1 artifacts still load — parseMapFile migrates them — but the
      // RUNTIME representation is always v2 compiled straight through.
      const parsed = parseMapFile(JSON.parse(readFileSync(config.mapPath, 'utf8')))
      if (parsed.ok) {
        // The map's statics live in the override, NOT merged into
        // content.world.statics: that merge was permanent, so the map layer
        // could never be replaced and a live save could not move or delete
        // anything it had already added.
        setMapOverride(compileMapFileV2(parsed.map))
        log.info('edited map loaded', {
          statics: parsed.map.statics.length,
          terrains: parsed.map.terrains.length,
          migrated: parsed.migrated,
        })
      } else {
        log.warn('edited map invalid — ignoring', { issues: parsed.issues.slice(0, 5).join('; ') })
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
    // LIVE map apply. Receives the validated v2 DOCUMENT, not a JSON string
    // of a fabricated v1 wire — the save pipeline has already parsed,
    // migrated and validated it, so there is nothing to re-parse here.
    (next, revision) => {
      try {
        setMapOverride(compileMapFileV2(next))
        world.rebuildTerrain()
        world.reconcileMapStatics()
        world.reconcileMapZones()
        world.reconcileMapNodes()
        world.reconcileMapProps()
        game.broadcastMapReload()
        editors.broadcastSaved()
        log.info('map applied live', { terrains: next.terrains.length, revision })
      } catch (err) {
        log.warn('live map apply failed', { error: String(err) })
      }
    },
    async (token, auth) => {
      // Signed-in accounts list by their hobo.tools identity; guests by
      // their browser token.
      let account = token
      if (auth) {
        const user = await resolveHoboToolsUser(config.hoboToolsAuthUrl, auth)
        if (!user) return []
        account = `hobotools:${user.id}`.slice(0, 64)
      }
      return store.players
        .listByToken(account)
        .slice(0, 3)
        .map((p) => ({ slot: p.charSlot, name: p.name, appearance: p.appearance }))
    },
    config.oauth,
  )
  world.reconcileMapNodes()
  world.reconcileMapProps()
  const gameWss = attachWebSocket(http, game, log.child({ system: 'ws' }))
  const editors = attachEditorWs(
    http,
    { key: config.editorKey, hoboToolsUrl: config.hoboToolsAuthUrl },
    log.child({ system: 'editor-ws' }),
  )
  http.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === '/ws') {
      gameWss.handleUpgrade(req, socket, head, (ws) => gameWss.emit('connection', ws, req))
    } else if (path === '/editor-ws') {
      editors.wss.handleUpgrade(req, socket, head, (ws) => editors.wss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })
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
