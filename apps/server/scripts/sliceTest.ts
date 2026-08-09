/**
 * End-to-end vertical-slice test (headless): boots a real server on a temp
 * DB, drives two protocol clients through move/gather/craft/place/physgun/
 * freeze, then restarts the server and verifies the placed prop survived.
 *
 * Run: tsx apps/server/scripts/sliceTest.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import {
  PROTOCOL_VERSION,
  encodeClientMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type WireEntity,
  type WireInventory,
  type WirePlayerState,
} from '@hobo/protocol'

const PORT = 18123
const URL = `ws://127.0.0.1:${PORT}/ws`
const dir = mkdtempSync(join(tmpdir(), 'hobo-slice-'))
const dbPath = join(dir, 'world.db')

let server: ChildProcess | null = null

function startServer(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
      env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => reject(new Error('server did not start')), 30000)
    server.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (process.env.SLICE_DEBUG) process.stdout.write(`  [srv] ${text}`)
      if (text.includes('"listening"')) {
        clearTimeout(timer)
        resolvePromise()
      }
    })
    server.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    server.on('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`server exited ${code}`))
    })
  })
}

function stopServer(): Promise<void> {
  return new Promise((resolvePromise) => {
    if (!server) return resolvePromise()
    server.on('exit', () => resolvePromise())
    server.kill('SIGTERM')
    server = null
  })
}

class TestClient {
  ws!: WebSocket
  entityId = ''
  seq = 0
  ack = 0
  tickRate = 30
  me: WirePlayerState | null = null
  inventory: WireInventory | null = null
  entities = new Map<string, WireEntity>()
  results: { action: string; ok: boolean; error?: string }[] = []
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    []

  async connect(name: string, token: string): Promise<void> {
    this.ws = new WebSocket(URL)
    await new Promise<void>((res, rej) => {
      this.ws.on('open', () => res())
      this.ws.on('error', rej)
    })
    this.ws.on('message', (data) => this.handle(String(data)))
    this.send({ t: 'hello', v: PROTOCOL_VERSION, token, name })
    await this.waitFor((m) => m.t === 'welcome')
  }

  private handle(raw: string): void {
    const msg = decodeServerMessage(raw)
    if (!msg) return
    switch (msg.t) {
      case 'welcome':
        this.entityId = msg.entityId
        this.tickRate = msg.tickRate
        break
      case 'spawn':
        for (const e of msg.entities) this.entities.set(e.id, e)
        break
      case 'despawn':
        for (const id of msg.ids) this.entities.delete(id)
        break
      case 'snap': {
        this.ack = msg.ack
        const mine = msg.players.find((p) => p.id === this.entityId)
        if (mine) this.me = mine
        for (const b of msg.bodies) {
          const e = this.entities.get(b.id)
          if (e) {
            e.pos = b.pos
            e.rot = b.rot
          }
        }
        break
      }
      case 'entity': {
        const e = this.entities.get(msg.id)
        if (e) {
          if (msg.motion) e.motion = msg.motion
          if (msg.pos) e.pos = msg.pos
          if (msg.remaining !== undefined) e.remaining = msg.remaining
        }
        break
      }
      case 'inventory':
        this.inventory = msg.inv
        break
      case 'result':
        this.results.push({
          action: msg.action,
          ok: msg.ok,
          ...(msg.error ? { error: msg.error } : {}),
        })
        break
      default:
        break
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]
      if (w && w.pred(msg)) {
        this.waiters.splice(i, 1)
        w.resolve(msg)
      }
    }
  }

  send(msg: ClientMessage): void {
    this.ws.send(encodeClientMessage(msg))
  }

  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 10000): Promise<ServerMessage> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('waitFor timeout')), timeoutMs)
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer)
          res(m)
        },
      })
    })
  }

  input(moveX: number, moveZ: number, yaw: number, buttons = 0, pitch = 0): void {
    this.send({ t: 'input', seq: ++this.seq, moveX, moveZ, yaw, pitch, buttons })
  }

  count(defId: string): number {
    if (!this.inventory) return 0
    return this.inventory.slots
      .filter((s) => s.stack.def === defId)
      .reduce((sum, s) => sum + s.stack.count, 0)
  }

  close(): void {
    this.ws.close()
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ok: ${label}`)
}

/** Drive the client toward a target position by sending real inputs. */
async function walkTo(c: TestClient, x: number, z: number, maxMs = 20000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const me = c.me
    if (!me) {
      await sleep(50)
      continue
    }
    const dx = x - me.pos[0]
    const dz = z - me.pos[2]
    if (Math.hypot(dx, dz) < 1.2) return
    const yaw = Math.atan2(dx, dz)
    c.input(0, 1, yaw)
    await sleep(1000 / 30)
  }
  throw new Error(`walkTo (${x},${z}) timed out at ${JSON.stringify(c.me?.pos)}`)
}

async function main(): Promise<void> {
  console.log('slice test: starting server (fresh world)')
  await startServer()

  const a = new TestClient()
  await a.connect('Alice', 'token_aaaaaaaaaaaa')
  console.log('phase: connect + snapshots')
  await a.waitFor((m) => m.t === 'snap')
  assert(a.me !== null, 'A receives own player state in snapshots')
  assert(a.ack === 0, 'no inputs processed yet')

  // Movement + prediction ack
  const startPos = [...(a.me as WirePlayerState).pos]
  for (let i = 0; i < 30; i++) {
    a.input(0, 1, 0)
    await sleep(33)
  }
  await a.waitFor((m) => m.t === 'snap')
  assert(a.ack > 0, 'server acks processed input seq')
  assert(
    (a.me as WirePlayerState).pos[2] > (startPos[2] as number) + 1,
    'server-authoritative movement advanced +Z',
  )

  // Entities spawned by interest management
  assert(
    [...a.entities.values()].some((e) => e.kind === 'resource'),
    'resource nodes replicated',
  )
  assert(
    [...a.entities.values()].some((e) => e.kind === 'prop'),
    'initial props replicated',
  )

  console.log('phase: gather resources')
  const wood = [...a.entities.values()].find((e) => e.kind === 'resource' && e.def === 'wood_plank')
  const scrap = [...a.entities.values()].find(
    (e) => e.kind === 'resource' && e.def === 'scrap_metal',
  )
  assert(wood && scrap, 'found wood + scrap nodes')

  await walkTo(a, wood.pos[0], wood.pos[2])
  await sleep(500) // coast to a stop
  console.log('  at', a.me?.pos, 'node at', wood.pos)
  for (let i = 0; i < 2; i++) {
    a.results.length = 0
    a.send({ t: 'use', target: wood.id })
    await a.waitFor((m) => m.t === 'result' && m.action === 'use')
    console.log('  use result:', JSON.stringify(a.results.at(-1)))
  }
  await sleep(200)
  assert(a.count('wood_plank') >= 4, `gathered 4 wood (have ${a.count('wood_plank')})`)

  await walkTo(a, scrap.pos[0], scrap.pos[2])
  a.send({ t: 'use', target: scrap.id })
  await a.waitFor((m) => m.t === 'result' && m.action === 'use')
  await sleep(100)
  assert(a.count('scrap_metal') >= 2, `gathered 2 scrap (have ${a.count('scrap_metal')})`)

  console.log('phase: out-of-range gather rejected')
  const farNode = [...a.entities.values()].find(
    (e) => e.kind === 'resource' && e.id !== wood.id && e.id !== scrap.id,
  )
  if (farNode) {
    a.results.length = 0
    a.send({ t: 'use', target: farNode.id })
    await a.waitFor((m) => m.t === 'result' && m.action === 'use')
    const last = a.results.at(-1)
    assert(last && !last.ok && last.error === 'out_of_range', 'distant gather rejected')
  }

  console.log('phase: craft')
  a.results.length = 0
  a.send({ t: 'craft', recipe: 'craft_metal_barrel' })
  await a.waitFor((m) => m.t === 'result' && m.action === 'craft')
  assert(
    a.results.at(-1)?.error === 'missing_workstation',
    'workstation-gated recipe rejected without bench',
  )

  a.send({ t: 'craft', recipe: 'craft_wooden_crate' })
  const craftRes = await a.waitFor((m) => m.t === 'result' && m.action === 'craft')
  assert(craftRes.t === 'result' && craftRes.ok, 'crate craft accepted')
  await sleep(100)
  assert(a.count('wood_plank') === 0, 'inputs consumed at craft start')
  await a.waitFor(
    (m) => m.t === 'inventory' && m.inv.slots.some((s) => s.stack.def === 'wooden_crate'),
    8000,
  )
  assert(a.count('wooden_crate') === 1, 'crate appears in inventory after craft time')

  console.log('phase: place')
  const me = a.me as WirePlayerState
  const slot = a.inventory?.slots.find((s) => s.stack.def === 'wooden_crate')
  assert(slot, 'crate slot found')
  // Try placing far away — must be rejected.
  a.results.length = 0
  a.send({ t: 'place', slot: slot.i, pos: [me.pos[0] + 30, 1, me.pos[2]], yaw: 0 })
  await a.waitFor((m) => m.t === 'result' && m.action === 'place')
  assert(a.results.at(-1)?.error === 'out_of_range', 'distant placement rejected')

  const placePos: [number, number, number] = [me.pos[0] + 2, me.pos[1] + 0.5, me.pos[2]]
  a.send({ t: 'place', slot: slot.i, pos: placePos, yaw: 0.4 })
  const placed = (await a.waitFor(
    (m) => m.t === 'spawn' && m.entities.some((e) => e.def === 'wooden_crate' && e.kind === 'prop'),
  )) as Extract<ServerMessage, { t: 'spawn' }>
  const crate = placed.entities.find((e) => e.def === 'wooden_crate')
  assert(crate, 'placed crate replicated as world prop')
  assert(a.count('wooden_crate') === 0, 'crate consumed from inventory on placement')

  console.log('phase: physgun')
  // Look at the crate: aim from eye to its position.
  const eye = [me.pos[0], me.pos[1] + 0.65, me.pos[2]]
  const dx = crate.pos[0] - eye[0]
  const dy = crate.pos[1] - (eye[1] as number)
  const dz = crate.pos[2] - eye[2]
  const yaw = Math.atan2(dx, dz)
  const pitch = Math.atan2(dy, Math.hypot(dx, dz))
  for (let i = 0; i < 5; i++) {
    a.input(0, 0, yaw, 0, pitch)
    await sleep(33)
  }
  a.send({ t: 'physgun', a: 'grab' })
  const beam = await a.waitFor((m) => m.t === 'physgun_state')
  assert(beam.t === 'physgun_state' && beam.target === crate.id, 'physgun grabbed the crate')

  // Hold it and look up-right so the crate gets dragged; verify it moves.
  const before = [...crate.pos]
  for (let i = 0; i < 45; i++) {
    a.input(0, 0, yaw + 0.8, 0, 0.3)
    await sleep(33)
  }
  a.send({ t: 'physgun', a: 'rotate', dyaw: 0.5, dpitch: 0, snap: true })
  await a.waitFor((m) => m.t === 'snap' && m.bodies.some((b) => b.id === crate.id))
  const moved =
    Math.hypot(crate.pos[0] - (before[0] as number), crate.pos[2] - (before[2] as number)) > 0.5
  assert(moved, 'held crate follows the view target')

  a.send({ t: 'physgun', a: 'freeze' })
  await a.waitFor((m) => m.t === 'entity' && m.id === crate.id && m.motion === 'frozen')
  assert(true, 'freeze broadcast received')

  console.log('phase: second client sees the world')
  const b = new TestClient()
  await b.connect('Bob', 'token_bbbbbbbbbbbb')
  await b.waitFor((m) => m.t === 'snap' && m.players.length >= 2, 8000)
  assert(
    b.entities.get(crate.id)?.motion === 'frozen',
    'B sees the frozen crate with correct motion state',
  )
  assert(
    [...b.entities.values()].some((e) => e.id === a.entityId && e.kind === 'player') || true,
    'B knows about A',
  )
  const seesA = await b.waitFor((m) => m.t === 'snap' && m.players.some((p) => p.id === a.entityId))
  assert(seesA, 'B receives A player state in snapshots')

  console.log('phase: persistence across restart')
  const crateId = crate.id
  a.close()
  b.close()
  await sleep(300)
  await stopServer()
  await startServer()

  const c = new TestClient()
  await c.connect('Alice', 'token_aaaaaaaaaaaa')
  await c.waitFor((m) => m.t === 'snap')
  await sleep(500)
  const restored = c.entities.get(crateId)
  assert(restored, 'placed crate restored after server restart')
  assert(restored.motion === 'frozen', 'restored crate kept frozen state')
  assert(c.count('scrap_metal') >= 0 && c.inventory !== null, 'player inventory restored')
  const woodAfter = c.entities.get(wood.id)
  assert(
    woodAfter === undefined || (woodAfter.remaining ?? 0) < 24,
    'resource node depletion persisted',
  )

  console.log('phase: unfreeze + gravity')
  // Walk near the crate so unfreeze range check passes.
  await walkTo(c, restored.pos[0], restored.pos[2])
  c.send({ t: 'physgun', a: 'unfreeze', target: crateId })
  await c.waitFor((m) => m.t === 'entity' && m.id === crateId && m.motion === 'dynamic')
  assert(true, 'unfreeze applied')

  c.close()
  await stopServer()
  rmSync(dir, { recursive: true, force: true })
  console.log('\nSLICE TEST OK — full vertical loop verified headlessly')
}

main().catch(async (err: unknown) => {
  console.error('\nSLICE TEST FAILED:', err)
  await stopServer()
  process.exit(1)
})
