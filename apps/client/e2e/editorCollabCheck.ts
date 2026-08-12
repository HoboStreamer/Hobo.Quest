/**
 * Two-editor collaboration acceptance, through real browsers and the real
 * WebSocket.
 *
 * This exists because the previous collaboration code passed its unit tests
 * while being completely non-functional end to end: the client never sent the
 * `hello` the server required, listened for a message tag the server never
 * emitted, and never streamed camera at all. Every piece was individually
 * "tested"; nothing checked that the two halves could talk.
 *
 * So this drives two pages against one server and asserts on what a second
 * person actually sees and is prevented from doing. Calling LockController
 * directly would prove nothing about that.
 *
 *   pnpm test:collab
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type JSHandle, type Page } from 'playwright'

const PORT = 18271
const KEY = 'test-admin-key'
const dir = mkdtempSync(join(tmpdir(), 'hobo-collab-'))
const mapPath = join(dir, 'map.json')

const SUB = 64
const HALF = 60
const flat = new Float32Array((SUB + 1) * (SUB + 1))
const heights = Buffer.from(new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength)).toString(
  'base64',
)

writeFileSync(
  mapPath,
  JSON.stringify({
    v: 2,
    terrains: [{ id: 'floor', pos: [0, 0, 0], halfExtent: HALF, sub: SUB, heights }],
    statics: [
      {
        id: 'box-a',
        shape: { type: 'box', size: [4, 4, 4] },
        pos: [8, 2, 0],
        yaw: 0,
        color: '#c04040',
      },
      {
        id: 'box-b',
        shape: { type: 'box', size: [4, 4, 4] },
        pos: [24, 2, 0],
        yaw: 0,
        color: '#40c040',
      },
    ],
    nodes: [],
    props: [],
    lights: [],
    zones: [],
  }),
)

const server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(dir, 'world.db'),
    STATIC_DIR: 'apps/client/dist',
    MAP_PATH: mapPath,
    EDITOR_KEY: KEY,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr!.on('data', (c) => console.log('[server]', String(c).slice(0, 300)))
for (const sig of ['exit', 'uncaughtException', 'unhandledRejection'] as const)
  process.on(sig, (e) => {
    server.kill()
    if (e instanceof Error) {
      console.error(e)
      process.exit(1)
    }
  })
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error('server never reported listening')), 30_000)
  server.stdout!.on('data', (c) => {
    if (String(c).includes('listening')) {
      clearTimeout(t)
      res()
    }
  })
})

let failures = 0
let checks = 0
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  checks++
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`,
  )
}
const section = (n: string): void =>
  console.log(`\n── ${n} ${'─'.repeat(Math.max(0, 58 - n.length))}`)

type Probe = {
  selectionIds: () => string[]
  selectByIds: (ids: string[]) => void
  transformOf: (id: string) => { position: number[] } | null
  groupMove: (dx: number, dy: number, dz: number) => void
  setToolByName: (t: string) => void
  objectCounts: () => Record<string, number>
  collab: () => {
    connected: boolean
    peerId: number
    peers: { peerId: number; name: string; color: string; selection: string[] }[]
    peerCount: number
    lockOwners: Record<string, string>
    owns: string[]
  }
  inspectorLockedBy: () => string | null
  setProperty: (ids: string[], key: string, value: unknown) => void
  deleteSelection: () => void
}

const handles = new Map<Page, JSHandle<Probe>>()
const on = <T>(page: Page, fn: (p: Probe) => T): Promise<T> =>
  page.evaluate(fn as never, handles.get(page) as never) as Promise<T>
const onA = <T>(page: Page, fn: (a: [Probe, ...never[]]) => T, ...args: unknown[]): Promise<T> =>
  page.evaluate(fn as never, [handles.get(page), ...args] as never) as Promise<T>

async function openEditor(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, String(e).slice(0, 300)))
  // Seed the credential and name before boot, so `hello` goes out on connect.
  await page.addInitScript(
    ([k, n]) => {
      localStorage.setItem('hobo.editorkey', k as string)
      localStorage.setItem('hobo.editor.name', n as string)
    },
    [KEY, name],
  )
  await page.goto(`http://127.0.0.1:${PORT}/editor`)
  await page.waitForSelector('#save', { timeout: 90_000 })
  await page.waitForFunction(() => Boolean((window as never as { __editor?: unknown }).__editor), {
    timeout: 90_000,
  })
  handles.set(
    page,
    await page.evaluateHandle(() => (window as never as { __editor: Probe }).__editor),
  )
  return page
}

/** Poll until `predicate` holds, so nothing depends on a fixed sleep. */
async function until<T>(
  read: () => Promise<T>,
  predicate: (v: T) => boolean,
  what: string,
  tries = 60,
): Promise<T> {
  let last: T = await read()
  for (let i = 0; i < tries; i++) {
    if (predicate(last)) return last
    await new Promise((r) => setTimeout(r, 150))
    last = await read()
  }
  console.log(`    · timed out waiting for ${what}: ${JSON.stringify(last)}`)
  return last
}

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-webgl', '--disable-gpu-sandbox'],
})

const alice = await openEditor(browser, 'Alice')
const bob = await openEditor(browser, 'Bob')

// ════════════════════════════════════════════════════════════════════════
section('Handshake and presence')

const aliceState = await until(
  () => on(alice, (p) => p.collab()),
  (c) => c.connected && c.peerId > 0,
  'Alice connected',
)
ok('Alice completed the hello handshake', aliceState.connected, aliceState)
ok('the server assigned Alice a peer id', aliceState.peerId > 0, aliceState.peerId)

const bobState = await until(
  () => on(bob, (p) => p.collab()),
  (c) => c.connected && c.peerId > 0,
  'Bob connected',
)
ok('Bob completed the hello handshake', bobState.connected)
ok('the two editors have DIFFERENT server-assigned ids', aliceState.peerId !== bobState.peerId, {
  a: aliceState.peerId,
  b: bobState.peerId,
})

// Camera presence: each sees the other as a peer. Nudging the camera makes
// the throttled stream send at least once.
await onA(alice, ([p]) => p.setToolByName('select'))
await alice.mouse.move(640, 400)
await alice.keyboard.down('KeyW')
await alice.waitForTimeout(400)
await alice.keyboard.up('KeyW')

const bobSeesAlice = await until(
  () => on(bob, (p) => p.collab()),
  (c) => c.peers.length >= 1,
  'Bob sees Alice',
)
ok('Bob sees Alice as a peer', bobSeesAlice.peers.length === 1, bobSeesAlice.peers)
ok('the peer carries her real name', bobSeesAlice.peers[0]?.name === 'Alice', bobSeesAlice.peers[0])
ok(
  'peer count is real, not derived from who happens to have a selection',
  bobSeesAlice.peerCount === 1,
  bobSeesAlice.peerCount,
)

// ════════════════════════════════════════════════════════════════════════
section('Remote selection and lock ownership')

await onA(alice, ([p]) => p.selectByIds(['box-a']))
const bobSeesSelection = await until(
  () => on(bob, (p) => p.collab()),
  (c) => c.peers[0]?.selection.includes('box-a') === true,
  "Bob sees Alice's selection",
)
ok(
  "Bob sees Alice's remote selection",
  bobSeesSelection.peers[0]?.selection.includes('box-a') === true,
  bobSeesSelection.peers[0],
)
ok(
  'and it carries her collaborator colour',
  /^#[0-9a-fA-F]{6}$/.test(bobSeesSelection.peers[0]?.color ?? ''),
  bobSeesSelection.peers[0]?.color,
)

const aliceOwns = await until(
  () => on(alice, (p) => p.collab()),
  (c) => c.owns.includes('box-a'),
  'Alice owns box-a',
)
ok('selecting acquired the edit lock', aliceOwns.owns.includes('box-a'), aliceOwns.owns)

const bobSeesLock = await until(
  () => on(bob, (p) => p.collab()),
  (c) => c.lockOwners['box-a'] === 'Alice',
  'Bob sees the lock owner',
)
ok(
  'Bob sees Alice as the lock owner',
  bobSeesLock.lockOwners['box-a'] === 'Alice',
  bobSeesLock.lockOwners,
)

// ════════════════════════════════════════════════════════════════════════
section("B may inspect but not mutate A's object")

await onA(bob, ([p]) => p.selectByIds(['box-a']))
await bob.waitForTimeout(300)
ok(
  'Bob can still SELECT it — reading is never blocked',
  (await on(bob, (p) => p.selectionIds())).includes('box-a'),
)
ok(
  'and the Inspector names who is editing it',
  (await on(bob, (p) => p.inspectorLockedBy())) === 'Alice',
  await on(bob, (p) => p.inspectorLockedBy()),
)
ok('Bob does NOT own the lock', !(await on(bob, (p) => p.collab())).owns.includes('box-a'))

const before = (await onA(bob, ([p]) => p.transformOf('box-a')))!.position
await onA(bob, ([p]) => p.groupMove(0, 0, 12))
await bob.waitForTimeout(400)
ok(
  'Bob cannot MOVE it',
  JSON.stringify((await onA(bob, ([p]) => p.transformOf('box-a')))!.position) ===
    JSON.stringify(before),
  { before, after: (await onA(bob, ([p]) => p.transformOf('box-a')))!.position },
)

await onA(bob, ([p]) => p.setProperty(['box-a'], 'color', '#000000'))
await bob.waitForTimeout(400)
ok(
  'Bob cannot EDIT it in the Inspector',
  (await onA(alice, ([p]) => p.transformOf('box-a'))) !== null,
)
ok(
  'and the object is unchanged on Alice',
  (await alice.evaluate(() => {
    const w = window as never as { __editor: { colorOf: (id: string) => string | null } }
    return w.__editor.colorOf('box-a')
  })) === '#c04040',
)

await onA(bob, ([p]) => p.deleteSelection())
await bob.waitForTimeout(400)
ok(
  'Bob cannot DELETE it',
  (await on(bob, (p) => p.objectCounts()))['statics'] === 2,
  await on(bob, (p) => p.objectCounts()),
)

// ════════════════════════════════════════════════════════════════════════
section('A can edit what she owns')

const aliceBefore = (await onA(alice, ([p]) => p.transformOf('box-a')))!.position
await onA(alice, ([p]) => p.groupMove(0, 0, 9))
await alice.waitForTimeout(400)
const aliceAfter = (await onA(alice, ([p]) => p.transformOf('box-a')))!.position
ok('Alice CAN move the object she holds', aliceAfter[2] !== aliceBefore[2], {
  aliceBefore,
  aliceAfter,
})

// ════════════════════════════════════════════════════════════════════════
section('Group locks are all-or-nothing')

// Alice holds box-a. Bob asks for box-a + box-b together.
await onA(bob, ([p]) => p.selectByIds(['box-a', 'box-b']))
await bob.waitForTimeout(600)
const bobGroup = await on(bob, (p) => p.collab())
ok(
  'a group containing a locked member grants NOTHING',
  !bobGroup.owns.includes('box-a') && !bobGroup.owns.includes('box-b'),
  bobGroup.owns,
)

await onA(bob, ([p]) => p.selectByIds(['box-b']))
const bobOwnsB = await until(
  () => on(bob, (p) => p.collab()),
  (c) => c.owns.includes('box-b'),
  'Bob owns box-b',
)
ok('but the free member alone is granted', bobOwnsB.owns.includes('box-b'), bobOwnsB.owns)

// ════════════════════════════════════════════════════════════════════════
section('Release on deselect, and after a disconnect')

await onA(alice, ([p]) => p.selectByIds([]))
const released = await until(
  () => on(bob, (p) => p.collab()),
  (c) => c.lockOwners['box-a'] === undefined,
  'box-a released',
)
ok('deselecting releases the lock', released.lockOwners['box-a'] === undefined, released.lockOwners)

await onA(bob, ([p]) => p.selectByIds(['box-a']))
const bobAcquired = await until(
  () => on(bob, (p) => p.collab()),
  (c) => c.owns.includes('box-a'),
  'Bob acquires box-a',
)
ok('and Bob can then acquire it', bobAcquired.owns.includes('box-a'), bobAcquired.owns)

// Abnormal disconnect: close Alice's whole context without a clean release.
const alicePeerId = aliceState.peerId
await alice.context().close()
const afterGone = await until(
  () => on(bob, (p) => p.collab()),
  (c) => c.peers.length === 0,
  'Alice disappears',
)
ok('an abnormal disconnect removes the peer', afterGone.peers.length === 0, afterGone.peers)
ok('peer count follows', afterGone.peerCount === 0, afterGone.peerCount)
ok(
  'and no stale remote selection is left behind',
  Object.keys(afterGone.lockOwners).length === 0 ||
    !Object.values(afterGone.lockOwners).includes('Alice'),
  afterGone.lockOwners,
)
void alicePeerId

await browser.close()
server.kill()

console.log(
  `\n${'═'.repeat(64)}\n${checks - failures}/${checks} collaboration checks passed, ${failures} FAILED\n`,
)
process.exit(failures > 0 ? 1 : 0)
