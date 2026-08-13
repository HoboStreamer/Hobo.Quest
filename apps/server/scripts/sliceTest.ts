/**
 * End-to-end vertical-slice test (headless): boots a real server on a temp
 * DB and drives protocol clients through the full loop — movement, the
 * tool system (physgun/axe equipment gating), hand-gather bootstrap,
 * skills XP, city zone rules, crafting chains, placement, physgun-freeze
 * building, and the prop-protection/trust system with a second player —
 * then restarts the server and verifies persistence of props, frozen
 * state, skills, friends and node depletion.
 *
 * Run: tsx apps/server/scripts/sliceTest.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import {
  PROTOCOL_VERSION,
  defaultAppearance,
  encodeClientMessage,
  decodeServerMessage,
  type Appearance,
  type ClientMessage,
  type ServerMessage,
  type WireEntity,
  type WireInventory,
  type WirePlayerState,
  type WireSkill,
} from '@hobo/protocol'
import { encodeHeights } from '@hobo/content'

const PORT = 18123
const URL = `ws://127.0.0.1:${PORT}/ws`
const dir = mkdtempSync(join(tmpdir(), 'hobo-slice-'))
const dbPath = join(dir, 'world.db')

let server: ChildProcess | null = null

function startServer(): Promise<void> {
  // The world ships blank (map-editor era) — the slice provides a fixture
  // map with the resource nodes its gameplay phases depend on.
  const FIX_SUB = 32
  const flat = new Float32Array((FIX_SUB + 1) * (FIX_SUB + 1))
  const fixtureMap = {
    v: 1,
    halfExtent: 64,
    sub: FIX_SUB,
    heights: encodeHeights(flat),
    statics: [],
    nodes: [
      { node: 'oak_tree', pos: [24, 0, 24] },
      { node: 'branch_pile', pos: [-24, 0, 2] },
      { node: 'loose_stones', pos: [-24, 0, -2] },
      { node: 'scrap_pile', pos: [-28, 0, 4] },
      { node: 'berry_bush', pos: [22, 0, 18] },
    ],
    props: [
      { item: 'merchant_stall', pos: [12, 0.6, 12.8], yaw: 3.14 },
      // Stage 4: an authored production yard outside the north gate.
      { item: 'sawmill', pos: [8, 0.7, 31], yaw: 0 },
      { item: 'scrap_generator', pos: [10, 0.7, 31], yaw: 0 },
      { item: 'wooden_crate', pos: [2, 1.0, 25], yaw: 0.3 },
      { item: 'wooden_crate', pos: [2.2, 1.8, 25.1], yaw: 0.9 },
      { item: 'wooden_crate', pos: [-2, 1.0, 27], yaw: 0.1 },
      { item: 'metal_barrel', pos: [-1, 1.0, 24], yaw: 0 },
      { item: 'metal_barrel', pos: [-4, 1.0, 29], yaw: 0 },
    ],
  }
  const mapPath = join(tmpdir(), `hq-slice-map-${Date.now()}.json`)
  writeFileSync(mapPath, JSON.stringify(fixtureMap))
  return new Promise((resolvePromise, reject) => {
    server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: dbPath,
        GUEST_IP_BINDING: 'off',
        MAP_PATH: mapPath,
      },
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

const SPRINT = 1 << 2

class TestClient {
  ws!: WebSocket
  entityId = ''
  seq = 0
  ack = 0
  tickRate = 30
  me: WirePlayerState | null = null
  inventory: WireInventory | null = null
  skills: WireSkill[] = []
  friends: { id: string; name: string }[] = []
  levelUps: { skill: string; level: number }[] = []
  entities = new Map<string, WireEntity>()
  results: { action: string; ok: boolean; error?: string }[] = []
  constraintEvents: { id: string; kind: string; a: string; b: string; active: boolean }[] = []
  /** What MY beam currently holds (from physgun_state broadcasts). */
  heldTarget: string | null = null
  stats: {
    hp: number
    hunger: number
    thirst: number
    stamina: number
    temp: number
    statuses: string[]
  } | null = null
  /** Latest authoritative weather from the time message. */
  lastWeather: string | null = null
  /** Mirrors the server's hotbar toggle: re-pressing the active slot holsters. */
  activeSlot = -1
  holstered = false
  lastContainer: {
    id: string
    size: number
    slots: { i: number; def: string; count: number }[]
  } | null = null
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    []

  async connect(name: string, token: string, appearance?: Appearance): Promise<void> {
    this.ws = new WebSocket(URL)
    await new Promise<void>((res, rej) => {
      this.ws.on('open', () => res())
      this.ws.on('error', rej)
    })
    this.ws.on('message', (data) => this.handle(String(data)))
    this.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      token,
      slot: 0,
      name,
      appearance: appearance ?? defaultAppearance(),
    })
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
          if (msg.rot) e.rot = msg.rot
          if (msg.remaining !== undefined) e.remaining = msg.remaining
          if (msg.health !== undefined) e.health = msg.health
          if (msg.plant !== undefined) {
            if (msg.plant === null) delete e.plant
            else e.plant = msg.plant
          }
        }
        break
      }
      case 'inventory':
        this.inventory = msg.inv
        break
      case 'skills':
        this.skills = msg.skills
        break
      case 'friends':
        this.friends = msg.friends
        break
      case 'levelup':
        this.levelUps.push({ skill: msg.skill, level: msg.level })
        break
      case 'constraint_state':
        this.constraintEvents.push({
          id: msg.id,
          kind: msg.kind,
          a: msg.a,
          b: msg.b,
          active: msg.active,
        })
        break
      case 'physgun_state':
        if (msg.player === this.entityId) this.heldTarget = msg.target ?? null
        break
      case 'stats':
        this.stats = {
          hp: msg.hp,
          hunger: msg.hunger,
          thirst: msg.thirst,
          stamina: msg.stamina,
          temp: msg.temp,
          statuses: msg.statuses,
        }
        break
      case 'time':
        this.lastWeather = msg.weather
        break
      case 'container':
        this.lastContainer = { id: msg.id, size: msg.size, slots: msg.slots }
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

  /** Sends a use and waits for its result. */
  async use(target: string): Promise<{ ok: boolean; error?: string }> {
    this.send({ t: 'use', target })
    await this.waitFor((m) => m.t === 'result' && m.action === 'use')
    const last = this.results.filter((r) => r.action === 'use').at(-1)
    return last ?? { ok: false, error: 'no_result' }
  }

  count(defId: string): number {
    if (!this.inventory) return 0
    return this.inventory.slots
      .filter((s) => s.stack.def === defId)
      .reduce((sum, s) => sum + s.stack.count, 0)
  }

  slotOf(defId: string): number {
    return this.inventory?.slots.find((s) => s.stack.def === defId)?.i ?? -1
  }

  skill(id: string): WireSkill | undefined {
    return this.skills.find((s) => s.id === id)
  }

  /** Presses a hotbar key, mirroring the server's holster toggle rules. */
  hotbar(slot: number): void {
    this.send({ t: 'hotbar', slot })
    if (slot === this.activeSlot) this.holstered = !this.holstered
    else {
      this.activeSlot = slot
      this.holstered = false
    }
  }

  /** Ensures an item sits in a hotbar slot (0-5) and selects it. */
  async equip(defId: string): Promise<number> {
    let slot = this.slotOf(defId)
    if (slot < 0) throw new Error(`cannot equip missing item ${defId}`)
    if (slot > 5) {
      // Find a free or sacrificial hotbar slot and move it there.
      const used = new Set(this.inventory?.slots.map((s) => s.i))
      let target = 5
      for (let i = 1; i <= 5; i++) {
        if (!used.has(i)) {
          target = i
          break
        }
      }
      this.send({ t: 'inv_move', from: slot, to: target })
      await this.waitFor((m) => m.t === 'inventory')
      slot = this.slotOf(defId)
    }
    if (slot === this.activeSlot && !this.holstered) return slot // already out
    this.hotbar(slot)
    await sleep(120)
    return slot
  }

  close(): void {
    this.ws.close()
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

/** Polls a condition over already-received state (no message-race). */
async function pollUntil(cond: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now()
  while (!cond() && Date.now() - start < timeoutMs) await sleep(100)
}

/** YXZ euler decomposition matching @hobo/shared qtoEulerYXZ. */
function quatToEulerYXZ(q: [number, number, number, number]): {
  pitch: number
  yaw: number
  roll: number
} {
  const [x, y, z, w] = q
  return {
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (w * x - y * z)))),
    yaw: Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)),
    roll: Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z)),
  }
}

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ok: ${label}`)
}

/** Sprint toward a target position by sending real inputs. */
async function walkTo(c: TestClient, x: number, z: number, maxMs = 40000): Promise<void> {
  const start = Date.now()
  // Obstacle shimmy: props litter the flat map now — when distance stops
  // improving, strafe + hop for a moment to slide around whatever we hit.
  let bestDist = Infinity
  let bestAt = Date.now()
  let shimmyUntil = 0
  let shimmyDir = 1
  while (Date.now() - start < maxMs) {
    const me = c.me
    if (!me) {
      await sleep(50)
      continue
    }
    const dx = x - me.pos[0]
    const dz = z - me.pos[2]
    const dist = Math.hypot(dx, dz)
    if (dist < 1.4) return
    if (dist < bestDist - 0.2) {
      bestDist = dist
      bestAt = Date.now()
    } else if (Date.now() - bestAt > 2500 && Date.now() > shimmyUntil) {
      shimmyUntil = Date.now() + 800
      shimmyDir = -shimmyDir
      bestAt = Date.now()
    }
    const yaw = Math.atan2(dx, dz)
    if (Date.now() < shimmyUntil) c.input(shimmyDir, 0.4, yaw, SPRINT | 1)
    else c.input(0, 1, yaw, SPRINT)
    if (Date.now() - start > 8000 && Math.floor((Date.now() - start) / 1000) % 3 === 0) {
      console.log('  walkTo stuck?', JSON.stringify(me.pos), 'vel', JSON.stringify(me.vel))
    }
    await sleep(1000 / 30)
  }
  throw new Error(`walkTo (${x},${z}) timed out at ${JSON.stringify(c.me?.pos)}`)
}

/** Walks through waypoints (no pathfinding — route around walls manually). */
async function walkPath(c: TestClient, points: [number, number][]): Promise<void> {
  for (const [x, z] of points) await walkTo(c, x, z)
}

/** Waits until the player has (nearly) stopped moving. */
async function settle(c: TestClient, maxMs = 4000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const v = c.me?.vel
    if (v && Math.hypot(v[0], v[1], v[2]) < 0.15) return
    c.input(0, 0, c.me ? Math.atan2(0, 1) : 0)
    await sleep(60)
  }
}

/** Stops, then aims precisely at an entity, recomputing from live position. */
async function aimAt(c: TestClient, target: WireEntity): Promise<void> {
  await settle(c)
  for (let i = 0; i < 8; i++) {
    const me = c.me as WirePlayerState
    const eyeY = me.pos[1] + 0.65
    const dx = target.pos[0] - me.pos[0]
    const dy = target.pos[1] - eyeY
    const dz = target.pos[2] - me.pos[2]
    const yaw = Math.atan2(dx, dz)
    const pitch = Math.atan2(dy, Math.hypot(dx, dz))
    c.input(0, 0, yaw, 0, pitch)
    await sleep(33)
  }
  await sleep(120)
}

async function craftAndWait(c: TestClient, recipe: string, outputDef: string): Promise<void> {
  const before = c.count(outputDef)
  c.send({ t: 'craft', recipe })
  const res = await c.waitFor((m) => m.t === 'result' && m.action === 'craft')
  if (res.t === 'result' && !res.ok) throw new Error(`craft ${recipe} rejected: ${res.error}`)
  await c.waitFor((m) => m.t === 'inventory' && c.count(outputDef) > before, 15000)
}

async function grabResult(
  c: TestClient,
): Promise<{ ok: boolean; error?: string; target?: string }> {
  c.results.length = 0
  c.send({ t: 'physgun', a: 'grab' })
  const msg = await c.waitFor(
    (m) => m.t === 'physgun_state' || (m.t === 'result' && m.action === 'physgun'),
  )
  if (msg.t === 'physgun_state') return { ok: true, ...(msg.target ? { target: msg.target } : {}) }
  const last = c.results.at(-1)
  return { ok: false, ...(last?.error ? { error: last.error } : {}) }
}

async function main(): Promise<void> {
  console.log('slice test: starting server (fresh hoboville world)')
  await startServer()

  const a = new TestClient()
  await a.connect('Alice', 'token_aaaaaaaaaaaa')
  await a.waitFor((m) => m.t === 'snap')

  console.log('phase: spawn + starter kit')
  assert(a.me !== null, 'receives own player state')
  assert(a.count('physgun') === 1, 'new player carries a physgun')
  assert(a.skills.length >= 5, 'skill progression replicated on welcome')
  await sleep(200)
  assert(
    [...a.entities.values()].some((e) => e.kind === 'resource'),
    'resource nodes replicated',
  )

  console.log('phase: physgun equipment gating (props outside north gate)')
  await walkTo(a, 0, 23)
  const crate = [...a.entities.values()].find(
    (e) => e.kind === 'prop' && e.def === 'wooden_crate' && e.pos[2] > 20,
  )
  assert(crate, 'found a crate outside the gate')
  await aimAt(a, crate)
  a.hotbar(1) // empty slot for a fresh player
  await sleep(120)
  const bare = await grabResult(a)
  assert(bare.error === 'no_physgun_equipped', 'grab without physgun rejected')

  a.hotbar(0)
  await sleep(120)
  await aimAt(a, crate)
  const grabbed = await grabResult(a)
  assert(grabbed.ok && grabbed.target === crate.id, 'grab with physgun equipped works')

  console.log('phase: drag into city, freeze, re-grab unfreezes (GMod behavior)')
  await walkTo(a, 0, 14) // back through the gate, crate follows the beam
  await sleep(400)
  a.send({ t: 'physgun', a: 'freeze' })
  await a.waitFor((m) => m.t === 'entity' && m.id === crate.id && m.motion === 'frozen')
  assert((a.entities.get(crate.id)?.pos[2] ?? 99) < 20.5, 'crate was dragged inside the city')
  // The city allows physgun use (prop protection guards ownership instead);
  // grabbing a frozen prop unfreezes it and picks it up in one motion.
  await aimAt(a, a.entities.get(crate.id) as WireEntity)
  const cityGrab = await grabResult(a)
  assert(cityGrab.ok && cityGrab.target === crate.id, 'grabbing a frozen prop unfreezes + grabs')
  assert(a.entities.get(crate.id)?.motion === 'dynamic', 'frozen prop went dynamic on grab')
  a.send({ t: 'physgun', a: 'release' })
  await sleep(200)

  console.log('phase: sweep-to-grab (beam fires at nothing, latches on touch)')
  // Aim at the sky and pull the trigger: no result, no latch — the beam just
  // fires. Then sweep down onto the crate: the retry loop latches it.
  await settle(a)
  a.input(0, 0, 0, 0, 1.2) // look up at the sky
  await sleep(150)
  a.results.length = 0
  a.send({ t: 'physgun', a: 'grab' })
  await sleep(400)
  assert(
    !a.results.some((r) => r.action === 'physgun') && !a.heldTarget,
    'empty beam is silent (no error, nothing latched)',
  )
  await aimAt(a, a.entities.get(crate.id) as WireEntity) // sweep onto the crate
  {
    // The latch can land while aimAt is still settling — poll the tracked
    // beam state instead of racing a message waiter.
    const start = Date.now()
    while (a.heldTarget !== crate.id && Date.now() - start < 5000) await sleep(60)
  }
  assert(a.heldTarget === crate.id, 'sweeping the beam onto a prop picks it up')
  console.log('phase: Shift+E world-angle rotation snap')
  // Still holding the crate from the sweep phase: send snapped rotates and
  // verify the replicated orientation lands on the angle grid.
  {
    // Lift the crate off the ground first — ground friction fights the
    // final degrees of rotation and masks the snap.
    const meNow = a.me as WirePlayerState
    const crateNow = a.entities.get(crate.id) as WireEntity
    const liftYaw = Math.atan2(crateNow.pos[0] - meNow.pos[0], crateNow.pos[2] - meNow.pos[2])
    for (let i = 0; i < 15; i++) {
      a.input(0, 0, liftYaw, 0, 0.55)
      await sleep(33)
    }
    const step = Math.PI / 6 // 30 deg
    for (let i = 0; i < 12; i++) {
      a.send({ t: 'physgun', a: 'rotate', dyaw: 0.09, dpitch: 0.05, snap: true, snapStep: step })
      await sleep(40)
    }
    await sleep(900) // let the drive converge on the snapped target
    const rot = a.entities.get(crate.id)?.rot
    assert(rot, 'held crate still replicated')
    const angles = quatToEulerYXZ(rot)
    const offGrid = (angle: number) => {
      const k = angle / step
      return Math.abs(k - Math.round(k))
    }
    const worst = Math.max(offGrid(angles.yaw), offGrid(angles.pitch), offGrid(angles.roll))
    assert(
      worst < 0.12,
      `snapped rotation sits on the 30-degree grid (worst offset ${(worst * 30).toFixed(1)} deg)`,
    )
  }
  a.send({ t: 'physgun', a: 'release' })
  await sleep(200)

  console.log('phase: hand-gather bootstrap (west gate piles) + skill XP')
  const byType = (t: string) =>
    [...a.entities.values()].filter((e) => e.kind === 'resource' && e.def === t)
  const branches = byType('branch_pile').find((e) => e.pos[0] < 0)
  const stones = byType('loose_stones').find((e) => e.pos[0] < 0)
  const scrap = byType('scrap_pile').find((e) => e.pos[0] < 0)
  assert(branches && stones && scrap, 'west-gate bootstrap piles exist')

  // Route out through the west gate (straight lines hit the city walls).
  await walkPath(a, [
    [-15, 0],
    [-23, 0],
    [branches.pos[0], branches.pos[2]],
  ])
  await settle(a)
  let gathered = 0
  for (let i = 0; i < 4; i++) {
    const res = await a.use(branches.id)
    if (res.ok) gathered++
    await sleep(260)
  }
  assert(gathered === 4 && a.count('wood_log') === 4, 'hand-gathered 4 logs')
  const depletedTry = await a.use(branches.id)
  assert(depletedTry.error === 'depleted', 'depleted pile rejects gathering')
  assert(a.entities.get(branches.id)?.remaining === 0, 'depletion replicated')
  assert((a.skill('woodcutting')?.xp ?? 0) > 0, 'woodcutting XP granted')

  await walkTo(a, stones.pos[0], stones.pos[2])
  await settle(a)
  for (let i = 0; i < 5; i++) {
    await a.use(stones.id)
    await sleep(260)
  }
  assert(a.count('stone') === 5, 'hand-gathered 5 stone')
  assert((a.skill('mining')?.xp ?? 0) > 0, 'mining XP granted')

  await walkTo(a, scrap.pos[0], scrap.pos[2])
  await settle(a)
  for (let i = 0; i < 5; i++) {
    await a.use(scrap.id)
    await sleep(260)
  }
  assert(a.count('scrap_metal') === 10, 'hand-gathered 10 scrap (full pile)')

  const tree = byType('oak_tree')[0]
  assert(tree, 'trees replicated')

  console.log('phase: craft tools (skill gate + crafting XP)')
  a.results.length = 0
  a.send({ t: 'craft', recipe: 'craft_metal_wall' })
  await a.waitFor((m) => m.t === 'result' && m.action === 'craft')
  const gateErr = a.results.at(-1)?.error
  assert(
    gateErr === 'missing_skill' || gateErr === 'missing_workstation' || gateErr === 'missing_items',
    `metal wall gated (${gateErr})`,
  )

  await craftAndWait(a, 'craft_planks', 'wood_plank')
  await craftAndWait(a, 'craft_planks', 'wood_plank')
  assert(a.count('wood_plank') === 8, 'sawed 2 logs into 8 planks')
  await craftAndWait(a, 'craft_stone_axe', 'stone_axe')
  assert((a.skill('crafting')?.xp ?? 0) > 0, 'crafting XP granted on completion')

  console.log('phase: axe harvesting (tool power)')
  // Route around the city's north side to the forest.
  await walkPath(a, [
    [-26, 26],
    [24, 26],
    [tree.pos[0] + 1.5, tree.pos[2] + 1.5],
  ])
  await settle(a)
  // Minecraft-style: bare hands (holstered) chop too, just slowly.
  a.hotbar(0)
  await sleep(120)
  const logsBeforePunch = a.count('wood_log')
  await a.equip('stone_axe')
  a.hotbar(a.slotOf('stone_axe')) // re-press = holster (bare hands)
  await sleep(150)
  const punch = await a.use(tree.id)
  assert(punch.ok, 'bare hands can chop (slowly)')
  await pollUntil(() => a.count('wood_log') === logsBeforePunch + 1)
  assert(a.count('wood_log') === logsBeforePunch + 1, 'punch yields a single log')
  await sleep(300) // swing cooldown
  a.hotbar(a.slotOf('stone_axe')) // unholster the axe
  await sleep(150)
  const logsBefore = a.count('wood_log')
  const chop = await a.use(tree.id)
  assert(chop.ok, 'axe chop accepted')
  await sleep(150)
  assert(a.count('wood_log') === logsBefore + 2, 'axe power doubles the yield')

  console.log('phase: TIMBER — deplete the tree, physical trunk falls')
  for (let i = 0; i < 12 && (a.entities.get(tree.id)?.remaining ?? 1) > 0; i++) {
    a.send({ t: 'use', target: tree.id })
    await sleep(260) // swing cooldown
  }
  assert((a.entities.get(tree.id)?.remaining ?? 1) === 0, 'tree fully chopped')
  const trunk = [...a.entities.values()].find(
    (e) =>
      e.kind === 'prop' &&
      e.def === 'tree_trunk' &&
      Math.hypot(e.pos[0] - tree.pos[0], e.pos[2] - tree.pos[2]) < 8,
  )
  assert(trunk, 'felled trunk spawned as a physical prop near the stump')
  await sleep(1200) // let it crash down under physics
  const trunkNow = a.entities.get(trunk.id) as WireEntity
  assert(trunkNow.pos[1] < tree.pos[1] + 1.6, 'trunk fell (physics), not floating')

  console.log('phase: survival — berries, eating, vitals')
  const bush = byType('berry_bush')[0]
  assert(bush, 'berry bush replicated')
  // Route around the city's north side — straight-line hits the west wall.
  await walkPath(a, [
    [24, 26],
    [-26, 26],
    [bush.pos[0] + 1.2, bush.pos[2] + 1.2],
  ])
  await settle(a)
  await sleep(300)
  const berriesBefore = a.count('berries')
  const pick = await a.use(bush.id)
  assert(pick.ok, 'berries gathered by hand')
  {
    const start = Date.now()
    while (a.count('berries') <= berriesBefore && Date.now() - start < 5000) await sleep(100)
  }
  assert(a.count('berries') > berriesBefore, 'berries in inventory')
  // A second handful so the container phase can split-stash later.
  await sleep(300)
  await a.use(bush.id)
  await pollUntil(() => a.count('berries') >= berriesBefore + 3)
  assert(a.stats !== null, 'vitals replicated')
  // Stage 3: vitals carry body temperature + statuses, and the world clock
  // carries authoritative weather.
  assert(
    typeof a.stats.temp === 'number' && a.stats.temp > 30 && a.stats.temp < 42,
    `body temperature replicated (${a.stats.temp})`,
  )
  assert(Array.isArray(a.stats.statuses), 'status list replicated')
  assert(a.lastWeather !== null, `weather replicated (${a.lastWeather})`)
  a.results.length = 0
  a.send({ t: 'consume', slot: a.slotOf('berries') })
  await a.waitFor((m) => m.t === 'result' && m.action === 'consume')
  assert(a.results.at(-1)?.ok === true, 'eating berries accepted')

  console.log('phase: container storage (craft box, stash, persists)')
  await craftAndWait(a, 'craft_rope', 'rope')
  await craftAndWait(a, 'craft_planks', 'wood_plank')
  await craftAndWait(a, 'craft_planks', 'wood_plank')
  await craftAndWait(a, 'craft_storage_box', 'storage_box')
  a.send({ t: 'drop', slot: a.slotOf('storage_box'), count: 1 })
  const boxSpawn = await a.waitFor(
    (m) => m.t === 'spawn' && m.entities.some((e) => e.def === 'storage_box'),
    5000,
  )
  const boxId =
    boxSpawn.t === 'spawn' ? (boxSpawn.entities.find((e) => e.def === 'storage_box')?.id ?? '') : ''
  assert(boxId, 'storage box placed in the world')
  await sleep(600)
  a.send({ t: 'container_open', target: boxId })
  await a.waitFor((m) => m.t === 'container' && m.id === boxId)
  assert(a.lastContainer?.size === 12, 'container opened with 12 slots')
  const stashSlot = a.slotOf('stone')
  assert(stashSlot >= 0, 'has stone to stash')
  a.send({ t: 'container_move', target: boxId, dir: 'in', slot: stashSlot })
  await a.waitFor((m) => m.t === 'container' && m.slots.some((sl) => sl.def === 'stone'), 5000)
  assert(
    a.lastContainer?.slots.some((sl) => sl.def === 'stone'),
    'stone stashed in the box',
  )
  const pickupTry = await a.use(boxId)
  assert(pickupTry.error === 'not_empty', 'stocked box refuses pickup')
  // Take the stone back (later phases need it); leave berries stashed so
  // the restart phase can verify container persistence.
  const stoneInBox = a.lastContainer?.slots.find((sl) => sl.def === 'stone')
  assert(stoneInBox, 'stone slot located in box')
  a.send({ t: 'container_move', target: boxId, dir: 'out', slot: stoneInBox.i })
  await a.waitFor((m) => m.t === 'inventory' && a.count('stone') > 0, 5000)
  const berrySlot = a.slotOf('berries')
  assert(berrySlot >= 0, 'berries left to stash')
  const berriesHeld = a.count('berries')
  if (berriesHeld >= 2) {
    // Stage 3: split — stash only part of the stack.
    const half = Math.floor(berriesHeld / 2)
    a.send({ t: 'container_move', target: boxId, dir: 'in', slot: berrySlot, count: half })
    await a.waitFor((m) => m.t === 'container' && m.slots.some((sl) => sl.def === 'berries'), 5000)
    await pollUntil(() => a.count('berries') === berriesHeld - half)
    assert(a.count('berries') === berriesHeld - half, 'split stash moved only the requested count')
  } else {
    a.send({ t: 'container_move', target: boxId, dir: 'in', slot: berrySlot })
    await a.waitFor((m) => m.t === 'container' && m.slots.some((sl) => sl.def === 'berries'), 5000)
  }
  // Stage 3: sort compacts and orders the box (berries currently in a
  // later slot than the empty ones ahead of it after the stone left).
  a.results.length = 0
  a.send({ t: 'container_sort', target: boxId })
  await a.waitFor((m) => m.t === 'result' && m.action === 'container')
  assert(a.results.at(-1)?.ok === true, 'container sort accepted')
  await pollUntil(() => a.lastContainer?.slots.some((sl) => sl.i === 0) ?? false)
  assert(
    a.lastContainer?.slots.some((sl) => sl.i === 0),
    'sorted contents start at slot 0',
  )

  console.log('phase: doors — craft, install (freeze), swing on E')
  await craftAndWait(a, 'craft_planks', 'wood_plank')
  await craftAndWait(a, 'craft_wooden_door', 'wooden_door')
  a.send({ t: 'drop', slot: a.slotOf('wooden_door'), count: 1 })
  const doorSpawn = await a.waitFor(
    (m) => m.t === 'spawn' && m.entities.some((e) => e.def === 'wooden_door'),
    5000,
  )
  const doorId =
    doorSpawn.t === 'spawn'
      ? (doorSpawn.entities.find((e) => e.def === 'wooden_door')?.id ?? '')
      : ''
  assert(doorId, 'door dropped into the world')
  await sleep(800)
  await a.equip('physgun')
  await aimAt(a, a.entities.get(doorId) as WireEntity)
  const doorGrab = await grabResult(a)
  assert(doorGrab.ok, 'door grabbed')
  a.send({ t: 'physgun', a: 'freeze' })
  await a.waitFor((m) => m.t === 'entity' && m.id === doorId && m.motion === 'frozen')
  const rotBefore = JSON.stringify(a.entities.get(doorId)?.rot)
  await sleep(300)
  const swing1 = await a.use(doorId)
  assert(swing1.ok, 'installed door swings on E')
  await sleep(200)
  assert(JSON.stringify(a.entities.get(doorId)?.rot) !== rotBefore, 'door pose changed (opened)')
  await sleep(300)
  const swing2 = await a.use(doorId)
  assert(swing2.ok, 'door closes again')

  // Return to the north-gate area — later phases (and Bob's approach path)
  // assume Alice is near the crates outside the north gate.
  await walkPath(a, [
    [-26, 26],
    [4, 28],
  ])
  await settle(a)

  console.log('phase: build with physgun freeze (wilderness allows building)')
  await craftAndWait(a, 'craft_planks', 'wood_plank')
  await craftAndWait(a, 'craft_wooden_wall', 'wooden_wall')
  await craftAndWait(a, 'craft_wooden_crate', 'wooden_crate')

  // Dropping IS placement now: the stack becomes a physical prop.
  const wallSlot = a.slotOf('wooden_wall')
  a.send({ t: 'drop', slot: wallSlot, count: 1 })
  const wallSpawn = (await a.waitFor(
    (m) => m.t === 'spawn' && m.entities.some((e) => e.def === 'wooden_wall'),
  )) as Extract<ServerMessage, { t: 'spawn' }>
  const wall = wallSpawn.entities.find((e) => e.def === 'wooden_wall')
  assert(wall, 'dropped wall became a physical entity')
  assert(wall.owner !== undefined, 'dropped prop carries owner id')
  assert(a.count('wooden_wall') === 0, 'wall left the inventory')

  // Step aside so the crate lands well clear of the wall (Bob aims at it).
  await walkTo(a, (a.me as WirePlayerState).pos[0] + 4, (a.me as WirePlayerState).pos[2] - 3)
  await settle(a)
  const crateSlot = a.slotOf('wooden_crate')
  a.send({ t: 'drop', slot: crateSlot, count: 1 })
  const crateSpawn = (await a.waitFor(
    (m) => m.t === 'spawn' && m.entities.some((e) => e.def === 'wooden_crate' && e.id !== crate.id),
  )) as Extract<ServerMessage, { t: 'spawn' }>
  const crate2 = crateSpawn.entities.find((e) => e.def === 'wooden_crate' && e.id !== crate.id)
  assert(crate2, 'crafted crate dropped into the world')
  await sleep(600)

  console.log('phase: pickup (E recovers dropped items)')
  const stonesBefore = a.count('stone')
  assert(stonesBefore >= 2, `has stones to drop (${stonesBefore})`)
  const stoneSlot = a.slotOf('stone')
  a.send({ t: 'drop', slot: stoneSlot, count: 2 })
  const stoneSpawn = (await a.waitFor(
    (m) => m.t === 'spawn' && m.entities.some((e) => e.def === 'stone'),
  )) as Extract<ServerMessage, { t: 'spawn' }>
  const stoneProp = stoneSpawn.entities.find((e) => e.def === 'stone')
  assert(stoneProp, 'material stack dropped as physical prop (fallback shape)')
  assert(a.count('stone') === stonesBefore - 2, '2 stones left the inventory')
  await sleep(700) // let it land nearby
  const pickup = await a.use(stoneProp.id)
  assert(pickup.ok, 'picked the dropped stones back up')
  await sleep(150)
  assert(a.count('stone') === stonesBefore, 'both stones recovered from one prop')

  console.log('phase: rigging — craft tool, weld, rope (materials), cut, hostile inputs')
  // Budget: the tool consumes 1 rope; the tether test consumes another.
  while (a.count('rope') < 2) await craftAndWait(a, 'craft_rope', 'rope')
  if (a.count('wood_plank') < 1) await craftAndWait(a, 'craft_planks', 'wood_plank')
  await craftAndWait(a, 'craft_rigging_tool', 'rigging_tool')

  // Two scrap props to link (dropped one after the other, so they land close).
  const dropScrap = async (): Promise<WireEntity> => {
    const before = new Set(
      [...a.entities.values()].filter((e) => e.def === 'scrap_metal').map((e) => e.id),
    )
    a.send({ t: 'drop', slot: a.slotOf('scrap_metal'), count: 1 })
    const spawn = (await a.waitFor(
      (m) =>
        m.t === 'spawn' && m.entities.some((e) => e.def === 'scrap_metal' && !before.has(e.id)),
    )) as Extract<ServerMessage, { t: 'spawn' }>
    return spawn.entities.find((e) => e.def === 'scrap_metal' && !before.has(e.id))!
  }
  const rigA = await dropScrap()
  await sleep(300)
  // Turn before the second drop so the props land apart, not overlapped —
  // welding interpenetrating bodies stores explosive depenetration energy.
  const turnedYaw = ((a.me?.yaw ?? 0) + 0.9) % (Math.PI * 2)
  for (let i = 0; i < 10; i++) {
    a.input(0, 0, turnedYaw)
    await sleep(33)
  }
  const rigB = await dropScrap()
  await sleep(900) // both settle

  // Hostile: constraint without the rigging tool equipped.
  a.results.length = 0
  a.send({
    t: 'constraint',
    kind: 'weld',
    a: rigA.id,
    b: rigB.id,
    pointA: rigA.pos,
    pointB: rigB.pos,
  })
  await a.waitFor((m) => m.t === 'result' && m.action === 'constraint')
  assert(
    a.results.at(-1)?.error === 'requires_rigging_tool',
    'constraint without the tool rejected',
  )

  await a.equip('rigging_tool')
  // Hostile: forged far-away anchor point.
  a.results.length = 0
  a.send({
    t: 'constraint',
    kind: 'weld',
    a: rigA.id,
    b: rigB.id,
    pointA: [rigA.pos[0] + 50, rigA.pos[1], rigA.pos[2]],
    pointB: rigB.pos,
  })
  await a.waitFor((m) => m.t === 'result' && m.action === 'constraint')
  assert(a.results.at(-1)?.error === 'bad_anchor', 'forged anchor point rejected')

  // Hostile: motor requires construction level 5.
  a.results.length = 0
  a.send({
    t: 'constraint',
    kind: 'motor',
    a: rigA.id,
    b: rigB.id,
    pointA: rigA.pos,
    pointB: rigB.pos,
    axis: [0, 1, 0],
    motorVel: 3,
    motorForce: 200,
  })
  await a.waitFor((m) => m.t === 'result' && m.action === 'constraint')
  assert(a.results.at(-1)?.error === 'missing_skill', 'motor gated behind construction skill')

  // Real weld.
  const constructionBefore = a.skill('construction')
  const conXpBefore = constructionBefore?.xp ?? 0
  const conLvlBefore = constructionBefore?.level ?? 1
  a.results.length = 0
  a.constraintEvents.length = 0
  const freshA = a.entities.get(rigA.id)!
  const freshB = a.entities.get(rigB.id)!
  a.send({
    t: 'constraint',
    kind: 'weld',
    a: rigA.id,
    b: rigB.id,
    pointA: freshA.pos,
    pointB: freshB.pos,
  })
  await a.waitFor((m) => m.t === 'result' && m.action === 'constraint')
  assert(a.results.at(-1)?.ok === true, 'weld created with the rigging tool')
  await pollUntil(() => a.constraintEvents.some((e) => e.kind === 'weld' && e.active))
  assert(
    a.constraintEvents.some((e) => e.kind === 'weld' && e.active),
    'weld constraint_state broadcast',
  )
  // The skills update follows the constraint broadcast; XP within a level
  // resets on level-up, so progress = level rose OR xp rose.
  await pollUntil(() => {
    const s = a.skill('construction')
    return s !== undefined && (s.level > conLvlBefore || s.xp > conXpBefore)
  })
  const conAfter = a.skill('construction')
  assert(
    conAfter && (conAfter.level > conLvlBefore || conAfter.xp > conXpBefore),
    'constraint grants construction XP',
  )

  // Hostile: duplicate same-type link.
  a.results.length = 0
  a.send({
    t: 'constraint',
    kind: 'weld',
    a: rigA.id,
    b: rigB.id,
    pointA: a.entities.get(rigA.id)!.pos,
    pointB: a.entities.get(rigB.id)!.pos,
  })
  await a.waitFor((m) => m.t === 'result' && m.action === 'constraint')
  assert(a.results.at(-1)?.error === 'already_linked', 'duplicate weld rejected')

  // Rope consumes a rope item and carries a length.
  const ropeBefore = a.count('rope')
  assert(ropeBefore >= 1, `has rope for the tether (${ropeBefore})`)
  a.results.length = 0
  a.constraintEvents.length = 0
  a.send({
    t: 'constraint',
    kind: 'rope',
    a: rigA.id,
    b: rigB.id,
    pointA: a.entities.get(rigA.id)!.pos,
    pointB: a.entities.get(rigB.id)!.pos,
    length: 2,
  })
  await a.waitFor((m) => m.t === 'result' && m.action === 'constraint')
  assert(a.results.at(-1)?.ok === true, 'rope tether created')
  await pollUntil(() => a.count('rope') === ropeBefore - 1)
  assert(a.count('rope') === ropeBefore - 1, 'rope material consumed')
  await pollUntil(() => a.constraintEvents.some((e) => e.kind === 'rope' && e.active))
  assert(
    a.constraintEvents.some((e) => e.kind === 'rope' && e.active),
    'rope constraint_state broadcast',
  )

  // Cut everything off rigB, then re-link a weld that must survive restart.
  a.results.length = 0
  a.constraintEvents.length = 0
  a.send({ t: 'constraint_remove', target: rigB.id })
  await a.waitFor((m) => m.t === 'result' && m.action === 'constraint')
  assert(a.results.at(-1)?.ok === true, 'constraints cut from the prop')
  {
    const start = Date.now()
    while (a.constraintEvents.filter((e) => !e.active).length < 2 && Date.now() - start < 5000) {
      await sleep(100)
    }
  }
  assert(
    a.constraintEvents.filter((e) => !e.active).length === 2,
    'both removals broadcast (weld + rope)',
  )
  // Cutting wakes the freed bodies; let them come to rest before re-linking
  // so the weld pins the settled pose.
  await sleep(1200)
  a.results.length = 0
  a.constraintEvents.length = 0
  a.send({
    t: 'constraint',
    kind: 'weld',
    a: rigA.id,
    b: rigB.id,
    pointA: a.entities.get(rigA.id)!.pos,
    pointB: a.entities.get(rigB.id)!.pos,
  })
  await a.waitFor((m) => m.t === 'result' && m.action === 'constraint')
  assert(
    a.results.at(-1)?.ok === true,
    `persistent weld re-created (${JSON.stringify(a.results.at(-1))} A=${JSON.stringify(
      a.entities.get(rigA.id)?.pos,
    )} B=${JSON.stringify(a.entities.get(rigB.id)?.pos)} me=${JSON.stringify(a.me?.pos)})`,
  )
  await pollUntil(() => a.constraintEvents.some((e) => e.kind === 'weld' && e.active))
  const persistedWeldId = a.constraintEvents.find((e) => e.kind === 'weld' && e.active)?.id ?? ''
  assert(persistedWeldId, 'persistent weld id captured')

  console.log('phase: prop health — damage, repair, pickup refusal, destruction')
  while (a.count('wood_plank') < 5) await craftAndWait(a, 'craft_planks', 'wood_plank')
  await craftAndWait(a, 'craft_wooden_beam', 'wooden_beam')
  a.send({ t: 'drop', slot: a.slotOf('wooden_beam'), count: 1 })
  const beamSpawn = (await a.waitFor(
    (m) => m.t === 'spawn' && m.entities.some((e) => e.def === 'wooden_beam'),
  )) as Extract<ServerMessage, { t: 'spawn' }>
  const beam = beamSpawn.entities.find((e) => e.def === 'wooden_beam')!
  await sleep(900)

  await a.equip('stone_axe')
  a.results.length = 0
  a.send({ t: 'attack', target: beam.id })
  await a.waitFor((m) => m.t === 'result' && m.action === 'attack')
  assert(a.results.at(-1)?.ok === true, 'axe swing damages the beam')
  await pollUntil(() => a.entities.get(beam.id)?.health !== undefined)
  const beamHp = a.entities.get(beam.id)?.health
  assert(beamHp !== undefined && beamHp < 120, `beam health dropped (${beamHp})`)

  // Damaged props refuse pickup (no pocket-the-wreck laundering).
  await sleep(300)
  const damagedPickup = await a.use(beam.id)
  assert(damagedPickup.error === 'damaged', 'damaged prop refuses pickup')

  // Repair with the matching material restores it to full.
  await a.equip('wood_plank')
  await sleep(300)
  const repair = await a.use(beam.id)
  assert(repair.ok, 'repaired with a plank')
  await pollUntil(() => a.entities.get(beam.id)?.health === 120)
  assert(a.entities.get(beam.id)?.health === 120, 'beam restored to full health')

  // Now break it completely: salvage loot must scatter.
  await a.equip('stone_axe')
  const planksBefore2 = a.count('wood_plank')
  for (let i = 0; i < 12 && a.entities.has(beam.id); i++) {
    a.send({ t: 'attack', target: beam.id })
    await sleep(320)
  }
  {
    const start = Date.now()
    while (a.entities.has(beam.id) && Date.now() - start < 8000) await sleep(150)
  }
  assert(!a.entities.has(beam.id), 'beam destroyed after enough damage')
  const salvage = [...a.entities.values()].find((e) => e.def === 'wood_plank' && e.kind === 'prop')
  assert(salvage, 'destruction scattered salvage planks')
  await sleep(700)
  const salvagePickup = await a.use(salvage.id)
  assert(salvagePickup.ok, 'salvage recovered')
  assert(a.count('wood_plank') > planksBefore2 - 1, 'salvage planks in inventory')

  console.log('phase: machines — generator power gates the sawmill; logs become lumber')
  {
    const sawmillEnt = [...a.entities.values()].find((e) => e.def === 'sawmill')
    const generatorEnt = [...a.entities.values()].find((e) => e.def === 'scrap_generator')
    assert(sawmillEnt && generatorEnt, 'authored production yard replicated')
    assert(a.count('wood_log') >= 2, `has logs to process (${a.count('wood_log')})`)
    await walkTo(a, sawmillEnt.pos[0] - 1.5, sawmillEnt.pos[2] - 1.5)
    await settle(a)
    // Load a log into the sawmill input.
    a.send({ t: 'container_open', target: sawmillEnt.id })
    await a.waitFor((m) => m.t === 'container' && m.id === sawmillEnt.id, 5000)
    a.send({
      t: 'container_move',
      target: sawmillEnt.id,
      dir: 'in',
      slot: a.slotOf('wood_log'),
      count: 1,
    })
    await a.waitFor(
      (m) =>
        m.t === 'container' &&
        m.id === sawmillEnt.id &&
        m.slots.some((sl) => sl.def === 'wood_log'),
      5000,
    )
    // Unpowered: the log must still be sitting there after a few seconds.
    await sleep(2500)
    a.send({ t: 'container_open', target: sawmillEnt.id })
    await a.waitFor((m) => m.t === 'container' && m.id === sawmillEnt.id, 5000)
    assert(
      a.lastContainer?.slots.some((sl) => sl.def === 'wood_log'),
      'unpowered sawmill does not run',
    )
    // Fuel the generator: power comes online, the sawmill eats the log.
    await walkTo(a, generatorEnt.pos[0] - 1.2, generatorEnt.pos[2] - 1.2)
    await settle(a)
    a.send({ t: 'container_open', target: generatorEnt.id })
    await a.waitFor((m) => m.t === 'container' && m.id === generatorEnt.id, 5000)
    a.send({
      t: 'container_move',
      target: generatorEnt.id,
      dir: 'in',
      slot: a.slotOf('wood_log'),
      count: 1,
    })
    await a.waitFor(
      (m) =>
        m.t === 'container' &&
        m.id === generatorEnt.id &&
        m.slots.some((sl) => sl.def === 'wood_log'),
      5000,
    )
    // Watch the sawmill: within ~15s the job completes into the output zone.
    await walkTo(a, sawmillEnt.pos[0] - 1.5, sawmillEnt.pos[2] - 1.5)
    await settle(a)
    a.send({ t: 'container_open', target: sawmillEnt.id })
    await a.waitFor((m) => m.t === 'container' && m.id === sawmillEnt.id, 5000)
    {
      const start = Date.now()
      while (
        !a.lastContainer?.slots.some((sl) => sl.def === 'wood_plank') &&
        Date.now() - start < 25_000
      ) {
        await sleep(500)
      }
    }
    assert(
      a.lastContainer?.slots.some((sl) => sl.def === 'wood_plank'),
      'powered sawmill produced lumber into its output slots',
    )
    const outSlot = a.lastContainer!.slots.find((sl) => sl.def === 'wood_plank')!
    assert(outSlot.i >= 3, `lumber landed in the OUTPUT zone (slot ${outSlot.i})`)
    // Recover the planks.
    const planksBefore3 = a.count('wood_plank')
    a.send({ t: 'container_move', target: sawmillEnt.id, dir: 'out', slot: outSlot.i })
    await pollUntil(() => a.count('wood_plank') > planksBefore3)
    assert(a.count('wood_plank') > planksBefore3, 'lumber recovered from the machine')
  }

  console.log('phase: merchant trades + farming (plant in a planter)')
  // Into the city through the north gate, to the trading post.
  await walkPath(a, [
    [0, 22],
    [0, 17],
    [12, 14.6],
  ])
  await settle(a)
  a.results.length = 0
  a.send({ t: 'trade', trade: 'sell_stone' })
  await a.waitFor((m) => m.t === 'result' && m.action === 'trade')
  assert(a.results.at(-1)?.ok === true, `sold stone to the merchant`)
  if (a.count('coin') < 2) await a.waitFor((m) => m.t === 'inventory' && a.count('coin') >= 2, 5000)
  a.send({ t: 'trade', trade: 'buy_seeds' })
  if (a.count('berry_seeds') < 3)
    await a.waitFor((m) => m.t === 'inventory' && a.count('berry_seeds') >= 3, 5000)
  assert(a.count('berry_seeds') >= 3, 'bought seeds with coins')

  await craftAndWait(a, 'craft_planks', 'wood_plank')
  await craftAndWait(a, 'craft_planter_box', 'planter_box')
  a.send({ t: 'drop', slot: a.slotOf('planter_box'), count: 1 })
  const planterSpawn = await a.waitFor(
    (m) => m.t === 'spawn' && m.entities.some((e) => e.def === 'planter_box'),
    5000,
  )
  const planterId =
    planterSpawn.t === 'spawn'
      ? (planterSpawn.entities.find((e) => e.def === 'planter_box')?.id ?? '')
      : ''
  assert(planterId, 'planter placed')
  await sleep(800)
  await a.equip('berry_seeds')
  await sleep(200)
  const plantRes = await a.use(planterId)
  assert(plantRes.ok, 'seeds planted')
  {
    const start = Date.now()
    while (!a.entities.get(planterId)?.plant && Date.now() - start < 5000) await sleep(100)
  }
  assert(a.entities.get(planterId)?.plant, 'plant state replicated')
  await sleep(400) // swing cooldown
  const growing = await a.use(planterId)
  assert(growing.error === 'still_growing', 'crop needs time to grow')
  // Back out the north gate for the build phase.
  await walkPath(a, [
    [0, 17],
    [4, 28],
  ])
  await settle(a)

  // Build flow: grab the wall, freeze it in the air — it must stay put.
  await a.equip('physgun')
  await aimAt(a, a.entities.get(wall.id) as WireEntity)
  const wallGrab = await grabResult(a)
  assert(
    wallGrab.ok && wallGrab.target === wall.id,
    `grabbed own wall (${JSON.stringify(wallGrab)} wall=${JSON.stringify(a.entities.get(wall.id)?.pos)} me=${JSON.stringify(a.me?.pos)})`,
  )
  await sleep(400)
  a.send({ t: 'physgun', a: 'freeze' })
  await a.waitFor((m) => m.t === 'entity' && m.id === wall.id && m.motion === 'frozen')
  assert(true, 'wall frozen in place (physgun building)')

  console.log('phase: prop protection + trust (second player)')
  const b = new TestClient()
  const bobLook: Appearance = {
    ...defaultAppearance(),
    body: 'female',
    hairStyle: 'ponytail',
    skin: 5,
    top: 7,
  }
  await b.connect('Bob', 'token_bbbbbbbbbbbb', bobLook)
  await b.waitFor((m) => m.t === 'snap')
  await walkPath(b, [
    [0, 24],
    [24, 26],
    [(a.me as WirePlayerState).pos[0] - 2, (a.me as WirePlayerState).pos[2] - 2],
  ])
  await settle(b)
  const bobsCrate = b.entities.get(crate2.id)
  assert(bobsCrate, 'Bob sees Alice\u2019s crate')
  await aimAt(b, bobsCrate)
  const bobGrab = await grabResult(b)
  assert(bobGrab.error === 'not_owner', 'prop protection blocks strangers')
  // The beam keeps retrying while held (sweep-to-grab) — drop it so Bob
  // doesn't auto-latch the crate the instant Alice trusts him below.
  b.send({ t: 'physgun', a: 'release' })

  // Alice trusts Bob (found via replicated player identity).
  const bobEntry = [...a.entities.values()].find((e) => e.kind === 'player' && e.name === 'Bob')
  assert(bobEntry?.player, 'Alice sees Bob with player identity')
  assert(
    bobEntry.appearance?.hairStyle === 'ponytail' && bobEntry.appearance.body === 'female',
    'Bob\u2019s avatar customization replicated to Alice',
  )
  const aliceSnap = await b.waitFor(
    (m) => m.t === 'snap' && m.players.some((p) => p.id === a.entityId && p.item !== undefined),
    8000,
  )
  assert(aliceSnap, 'equipped item replicated in player snapshots (held-item display)')
  a.results.length = 0
  a.send({ t: 'trust', player: bobEntry.player as string, trusted: true })
  await a.waitFor((m) => m.t === 'result' && m.action === 'trust')
  assert(a.results.at(-1)?.ok === true, 'trust accepted')
  if (!a.friends.some((f) => f.name === 'Bob')) await a.waitFor((m) => m.t === 'friends')
  assert(
    a.friends.some((f) => f.name === 'Bob'),
    'friends list updated with Bob',
  )

  await aimAt(b, b.entities.get(crate2.id) as WireEntity)
  const bobGrab2 = await grabResult(b)
  if (!bobGrab2.ok) {
    console.log(
      '  grab2 failed:',
      JSON.stringify(bobGrab2),
      'bob:',
      b.me?.pos,
      'crate2:',
      b.entities.get(crate2.id)?.pos,
    )
  }
  assert(bobGrab2.ok && bobGrab2.target === crate2.id, 'trusted friend can grab the prop')
  b.send({ t: 'physgun', a: 'release' })
  await sleep(200)

  // Revoke trust — protection returns.
  a.send({ t: 'trust', player: bobEntry.player as string, trusted: false })
  await a.waitFor((m) => m.t === 'result' && m.action === 'trust')
  await sleep(200)
  await aimAt(b, b.entities.get(crate2.id) as WireEntity)
  const bobGrab3 = await grabResult(b)
  assert(bobGrab3.error === 'not_owner', 'revoking trust restores protection')
  b.send({ t: 'physgun', a: 'release' })

  console.log('phase: melee PvP (outside the safe city)')
  await a.equip('stone_axe')
  await sleep(300)
  a.results.length = 0
  a.send({ t: 'use', target: b.entityId })
  await a.waitFor((m) => m.t === 'result' && m.action === 'use')
  const hit = a.results.at(-1)
  assert(hit?.ok === true, `melee hit accepted (${hit?.error ?? 'ok'})`)
  await b.waitFor((m) => m.t === 'stats' && m.hp < 100, 5000)
  assert((b.stats?.hp ?? 100) < 100, 'victim lost health')

  console.log('phase: combat depth — fire/reload denials, bandage healing')
  {
    // Hostile: fire/reload without a ranged weapon equipped.
    await a.equip('stone_axe')
    a.results.length = 0
    a.send({ t: 'fire' })
    await a.waitFor((m) => m.t === 'result' && m.action === 'attack')
    assert(a.results.at(-1)?.error === 'not_a_weapon', 'fire without a gun rejected')
    a.results.length = 0
    a.send({ t: 'reload' })
    await a.waitFor((m) => m.t === 'result' && m.action === 'attack')
    assert(a.results.at(-1)?.error === 'not_a_weapon', 'reload without a gun rejected')
    // Hostile: wearing a non-armor item.
    a.results.length = 0
    a.send({ t: 'equip_armor', slot: a.slotOf('stone_axe') })
    await a.waitFor((m) => m.t === 'result' && m.action === 'inv_move')
    assert(a.results.at(-1)?.error === 'not_armor', 'equipping a non-armor item rejected')
    // Bob swings back bare-handed (via the attack message) so Alice has a
    // wound to treat.
    // Knockback pushed Bob away; close back in before swinging, and
    // holster the physgun (it refuses to be a weapon).
    await walkTo(b, (a.me as WirePlayerState).pos[0] + 1, (a.me as WirePlayerState).pos[2])
    await settle(b)
    if (!b.holstered) b.hotbar(b.activeSlot < 0 ? 0 : b.activeSlot)
    await sleep(150)
    b.results.length = 0
    b.send({ t: 'attack', target: a.entityId })
    // Player melee replies on the 'use' action channel (shared pipeline).
    await b.waitFor((m) => m.t === 'result' && (m.action === 'use' || m.action === 'attack'))
    assert(
      b.results.at(-1)?.ok === true,
      `bare-handed attack message accepted (${JSON.stringify(b.results.at(-1))})`,
    )
    await pollUntil(() => (a.stats?.hp ?? 100) < 100)
    // Bandage: craft from rope, heal the scrap wound.
    if (a.count('rope') < 1) await craftAndWait(a, 'craft_rope', 'rope')
    await craftAndWait(a, 'craft_bandage', 'bandage')
    const hpBefore = a.stats?.hp ?? 100
    assert(hpBefore < 100, `took melee damage (${hpBefore})`)
    a.results.length = 0
    a.send({ t: 'consume', slot: a.slotOf('bandage') })
    await a.waitFor((m) => m.t === 'result' && m.action === 'consume')
    assert(a.results.at(-1)?.ok === true, 'bandage consumed')
    await pollUntil(() => (a.stats?.hp ?? 0) > hpBefore)
    assert((a.stats?.hp ?? 0) > hpBefore, 'bandage healed')
  }

  console.log('phase: players collide (blocking bodies)')
  await settle(a)
  await settle(b)
  {
    const alice = (a.me as WirePlayerState).pos
    // Bob runs straight at (and through) Alice for 2 seconds.
    const start = Date.now()
    while (Date.now() - start < 2000) {
      const bob = (b.me as WirePlayerState).pos
      const yaw = Math.atan2(alice[0] - bob[0], alice[2] - bob[2])
      b.input(0, 1, yaw, SPRINT)
      await sleep(1000 / 30)
    }
    const bob = (b.me as WirePlayerState).pos
    const gap = Math.hypot(alice[0] - bob[0], alice[2] - bob[2])
    // Capsule radius 0.4 each: blocked bodies can't get closer than ~0.8.
    assert(gap > 0.55, `player body blocks player movement (gap ${gap.toFixed(2)}m)`)
    await settle(b)
  }

  // Re-trust for the persistence check.
  a.send({ t: 'trust', player: bobEntry.player as string, trusted: true })
  await a.waitFor((m) => m.t === 'result' && m.action === 'trust')

  console.log('phase: persistence across restart (props, frozen state, skills, friends, depletion)')
  const preRestartBranches = a.entities.get(branches.id)?.remaining
  const wcBefore = a.skill('woodcutting')
  const wallId = wall.id
  const crate2Id = crate2.id
  const branchesId = branches.id
  a.close()
  b.close()
  await sleep(400)
  await stopServer()
  await startServer()

  const c = new TestClient()
  await c.connect('Alice', 'token_aaaaaaaaaaaa')
  await c.waitFor((m) => m.t === 'snap')
  await sleep(600)
  const restoredWall = c.entities.get(wallId)
  assert(restoredWall, 'placed wall restored after restart')
  assert(restoredWall.motion === 'frozen', 'frozen state persisted')
  assert(restoredWall.owner !== undefined, 'ownership persisted')
  assert(c.entities.get(crate2Id), 'placed crate restored after restart')
  // The pile may have legitimately respawned (120s timer) during a long
  // run — persistence is proven by matching the PRE-restart state.
  assert(
    c.entities.get(branchesId)?.remaining === preRestartBranches,
    `node state persisted (${preRestartBranches})`,
  )
  const wcAfter = c.skill('woodcutting')
  assert(
    wcAfter && wcBefore && wcAfter.level === wcBefore.level && wcAfter.xp === wcBefore.xp,
    'skill progression persisted',
  )
  assert(c.count('stone_axe') === 1, 'tools persisted in inventory')
  {
    const box = [...c.entities.values()].find((e) => e.def === 'storage_box')
    assert(box, 'storage box restored after restart')
    // Containers are range-checked: walk to the box (around the city).
    await walkPath(c, [
      [-26, 26],
      [box.pos[0] + 1.5, box.pos[2] + 1.5],
    ])
    await settle(c)
    c.send({ t: 'container_open', target: box.id })
    await c.waitFor((m) => m.t === 'container' && m.id === box.id, 8000)
    assert(
      c.lastContainer?.slots.some((sl) => sl.def === 'berries'),
      'container contents persisted across restart',
    )
  }
  assert(
    c.friends.some((f) => f.name === 'Bob'),
    'friends list persisted across restart',
  )
  // The re-created weld came back with the same id (constraint_state is
  // pushed when its props enter interest).
  {
    const start = Date.now()
    while (
      !c.constraintEvents.some((e) => e.id === persistedWeldId && e.kind === 'weld' && e.active) &&
      Date.now() - start < 8000
    ) {
      await sleep(150)
    }
    assert(
      c.constraintEvents.some((e) => e.id === persistedWeldId && e.kind === 'weld' && e.active),
      'constraint persisted across restart (same id, same type)',
    )
    assert(
      !c.constraintEvents.some((e) => e.kind === 'rope'),
      'cut rope did NOT come back after restart',
    )
  }

  c.close()
  await stopServer()
  rmSync(dir, { recursive: true, force: true })
  console.log(
    '\nSLICE TEST OK — tools, skills, city rules, building, prop protection, persistence verified',
  )
}

main().catch(async (err: unknown) => {
  console.error('\nSLICE TEST FAILED:', err)
  await stopServer()
  process.exit(1)
})
