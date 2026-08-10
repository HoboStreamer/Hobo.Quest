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
import { mkdtempSync, rmSync } from 'node:fs'
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
  weldEvents: { a: string; b: string; active: boolean }[] = []
  /** What MY beam currently holds (from physgun_state broadcasts). */
  heldTarget: string | null = null
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
          if (msg.remaining !== undefined) e.remaining = msg.remaining
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
      case 'weld_state':
        this.weldEvents.push({ a: msg.a, b: msg.b, active: msg.active })
        break
      case 'physgun_state':
        if (msg.player === this.entityId) this.heldTarget = msg.target ?? null
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
    this.send({ t: 'hotbar', slot })
    await sleep(120)
    return slot
  }

  close(): void {
    this.ws.close()
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

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
  while (Date.now() - start < maxMs) {
    const me = c.me
    if (!me) {
      await sleep(50)
      continue
    }
    const dx = x - me.pos[0]
    const dz = z - me.pos[2]
    if (Math.hypot(dx, dz) < 1.4) return
    const yaw = Math.atan2(dx, dz)
    c.input(0, 1, yaw, SPRINT)
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
  a.send({ t: 'hotbar', slot: 1 }) // empty slot for a fresh player
  await sleep(120)
  const bare = await grabResult(a)
  assert(bare.error === 'no_physgun_equipped', 'grab without physgun rejected')

  a.send({ t: 'hotbar', slot: 0 })
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
  for (let i = 0; i < 2; i++) {
    await a.use(scrap.id)
    await sleep(260)
  }
  assert(a.count('scrap_metal') === 4, 'hand-gathered 4 scrap')

  console.log('phase: tool gating on trees')
  const tree = byType('oak_tree')[0]
  assert(tree, 'trees replicated')
  const treeTry = await a.use(tree.id)
  assert(treeTry.error === 'requires_axe', 'tree rejects bare-handed chopping')

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
  await a.equip('stone_axe')
  const logsBefore = a.count('wood_log')
  const chop = await a.use(tree.id)
  assert(chop.ok, 'axe chop accepted')
  await sleep(150)
  assert(a.count('wood_log') === logsBefore + 2, 'axe power doubles the yield')

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

  // Build flow: grab the wall, freeze it in the air — it must stay put.
  await a.equip('physgun')
  await aimAt(a, a.entities.get(wall.id) as WireEntity)
  const wallGrab = await grabResult(a)
  assert(wallGrab.ok && wallGrab.target === wall.id, 'grabbed own wall')
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
  await a.waitFor((m) => m.t === 'friends')
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
  assert(c.entities.get(branchesId)?.remaining === 0, 'node depletion persisted')
  const wcAfter = c.skill('woodcutting')
  assert(
    wcAfter && wcBefore && wcAfter.level === wcBefore.level && wcAfter.xp === wcBefore.xp,
    'skill progression persisted',
  )
  assert(c.count('stone_axe') === 1, 'tools persisted in inventory')
  assert(
    c.friends.some((f) => f.name === 'Bob'),
    'friends list persisted across restart',
  )

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
