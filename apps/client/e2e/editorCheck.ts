/**
 * Editor acceptance suite — the canonical browser regression for /editor.
 *
 * Talks to the editor ONLY through window.__editor (the probe API), and
 * interacts with REAL gizmo handle geometry found by ray-testing the utility
 * layer, so it exercises the same code path a user does rather than calling
 * internals directly.
 *
 * Tracked (not in ignored scratch/) because it is the acceptance gate:
 *
 *   pnpm test:editor
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type JSHandle, type Page } from 'playwright'

const PORT = 18195
const dir = mkdtempSync(join(tmpdir(), 'hobo-repro-'))
const mapPath = join(dir, 'map.json')

// ── Fixture map: NATIVE v2 — one ordinary terrain plus three boxes. ─────
// The acceptance fixture is deliberately v2: this suite is the gate for the
// FINAL editor, so it must not depend on the migration path. A separate v1
// smoke below proves old maps still load.
//
// The boxes sit to the +x side so their projections clear the editor's
// ~270px left sidebar, which overlays the canvas and would swallow clicks.
const SUB = 128
const HALF = 100
const flat = new Float32Array((SUB + 1) * (SUB + 1))
const b64 = Buffer.from(new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength)).toString(
  'base64',
)
/** The one terrain in the fixture. Nothing treats it as special. */
const FLOOR_ID = 'terrain-floor'
writeFileSync(
  mapPath,
  JSON.stringify({
    v: 2,
    terrains: [
      {
        id: FLOOR_ID,
        name: 'Floor',
        pos: [0, 0, 0],
        halfExtent: HALF,
        sub: SUB,
        heights: b64,
      },
    ],
    statics: [
      {
        id: 'box-a',
        shape: { type: 'box', size: [4, 4, 4] },
        pos: [6, 2, 0],
        yaw: 0,
        color: '#c04040',
      },
      {
        id: 'box-b',
        shape: { type: 'box', size: [4, 4, 4] },
        pos: [22, 2, 0],
        yaw: 0,
        color: '#40c040',
      },
      {
        id: 'box-c',
        shape: { type: 'box', size: [4, 4, 4] },
        pos: [38, 2, 0],
        yaw: 0,
        color: '#4040c0',
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
    EDITOR_KEY: 'test-admin-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr!.on('data', (c) => console.log('[server]', String(c).slice(0, 400)))
// Never leave an orphan holding the port when a scenario throws.
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
  const tag = cond ? 'PASS' : 'FAIL'
  console.log(
    `  [${tag}] ${name}${cond || detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`,
  )
}
const section = (n: string): void =>
  console.log(`\n── ${n} ${'─'.repeat(Math.max(0, 58 - n.length))}`)

type Probe = {
  selectionIds: () => string[]
  primaryId: () => string | null
  interactionState: () => string
  gizmoState: () => { mode: string; attached: boolean; dragging: boolean }
  gizmoHandleScreenPos: (a: 'x' | 'y' | 'z') => [number, number] | null
  cameraSnapshot: () => { pos: number[]; rot: number[] }
  history: () => { depth: number; redo: number }
  terrainWires: () => Record<string, boolean>
  faceSelKeys: () => string[]
  pickIdAt: (x: number, y: number) => string | null
  surfaceMaterialOf: (id: string) => {
    base: string | null
    layers: { tex: string; channel: string; hidden: boolean; color: string | null }[]
    hasMask: boolean
  } | null
  setPaintTexture: (tex: string) => void
  setPaintColor: (hex: string) => void
  setInspectorTexture: (tex: string) => void
  terrainIds: () => string[]
  transformOf: (id: string) => { position: number[]; rotation: number[] | null } | null
  worldToScreen: (p: number[]) => [number, number]
  setToolByName: (t: string) => void
  selectByIds: (ids: string[]) => void
  undo: () => void
  redo: () => void
  setCameraPose: (pos: number[], rot: number[]) => void
  objectCounts: () => Record<string, number>
  terrainMeshCount: () => number
  sceneMeshNames: () => string[]
}
// The probe lives in the page; pass it into evaluate() as a JSHandle so the
// scenarios below can be written as plain typed functions.
// Filled in once the page has booted; every helper below reads through it.
const probe: { handle?: JSHandle<Probe> } = {}
const ev = <T>(_page: Page, fn: (p: Probe) => T): Promise<T> =>
  page.evaluate(fn as never, probe.handle as never) as Promise<T>
/** evaluate with extra arguments (closures never cross the boundary). */
const evA = <T>(fn: (a: [Probe, ...never[]]) => T, ...args: unknown[]): Promise<T> =>
  page.evaluate(fn as never, [probe.handle, ...args] as never) as Promise<T>

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-webgl', '--disable-gpu-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (e) =>
  console.log('[pageerror]', String((e as Error).stack ?? e).slice(0, 500)),
)
await page.goto(`http://127.0.0.1:${PORT}/editor`)
await page.waitForSelector('#save', { timeout: 90_000 })
await page.waitForFunction(() => Boolean((window as never as { __editor?: unknown }).__editor), {
  timeout: 90_000,
})
await page.waitForTimeout(5000)
probe.handle = (await page.evaluateHandle(
  () => (window as never as { __editor: Probe }).__editor,
)) as JSHandle<Probe>

// Warm-up: Babylon only learns the cursor position from a real pointermove,
// and the editor picks with scene.pointerX/Y — so the very first synthetic
// click must not be the first pointer event the page has ever seen.
await page.mouse.move(700, 450)
await page.waitForTimeout(600)

/** Screen position of a document object, via the editor's own projector. */
const screenOf = (id: string): Promise<[number, number]> =>
  page.evaluate((oid: string) => {
    const w = window as never as {
      __editor: {
        transformOf: (i: string) => { position: number[] } | null
        worldToScreen: (p: number[]) => [number, number]
      }
    }
    const t = w.__editor.transformOf(oid)
    if (!t) throw new Error(`no object ${oid}`)
    return w.__editor.worldToScreen(t.position)
  }, id)

/** transformOf across the process boundary (closures do not transfer). */
const xf = (id: string): Promise<{ position: number[]; rotation: number[] | null }> =>
  page.evaluate(([p, oid]) => (p as Probe).transformOf(oid as string)!, [
    probe.handle,
    id,
  ] as never) as Promise<{ position: number[]; rotation: number[] | null }>
const posOf = async (id: string): Promise<number[]> => (await xf(id)).position

const traceClicks = false
const clickObject = async (id: string, mods: string[] = []): Promise<void> => {
  if (traceClicks)
    console.log(
      `    · pre-click ${id} state=${await ev(page, (p) => p.interactionState())} sel=${JSON.stringify(await ev(page, (p) => p.selectionIds()))}`,
    )
  // The projection uses the last RENDERED camera matrix, so after a camera
  // change it can be a frame stale. Verify the aim against the editor's own
  // picker and re-project until it actually lands on the target.
  let x = 0
  let y = 0
  for (let i = 0; i < 25; i++) {
    ;[x, y] = await screenOf(id)
    const at = await evA(
      ([p, px, py]) => p.pickIdAt(px as unknown as number, py as unknown as number),
      x,
      y,
    )
    if (at === id) break
    await page.waitForTimeout(120)
  }
  await page.mouse.move(x, y)
  await page.waitForTimeout(80)
  for (const m of mods) await page.keyboard.down(m)
  await page.mouse.down()
  await page.mouse.up()
  for (const m of mods) await page.keyboard.up(m)
  await page.waitForTimeout(200)
}

/**
 * Drag a real gizmo handle. Primes hover with a couple of moves (the utility
 * layer only learns what is under the cursor from pointermove), then drags in
 * small steps and reports whether the gizmo actually engaged.
 */
const dragHandle = async (
  axis: 'x' | 'y' | 'z',
  dx: number,
  dy = 0,
  steps = 10,
): Promise<{ started: boolean; from: [number, number] | null }> => {
  // Two things make this flaky under software GL: the gizmo is scaled to
  // screen size on its first utility-layer frame, and a probe point can go
  // stale between the query and the press. So poll for a STABLE handle, then
  // verify the drag actually engaged and retry with a fresh point if not.
  let last: [number, number] | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    let h: [number, number] | null = null
    let prev: string | null = null
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(150)
      const p2 = await evA(([p, a]) => p.gizmoHandleScreenPos(a as unknown as 'x'), axis)
      const key = p2 ? `${p2[0]},${p2[1]}` : null
      if (p2 && key === prev) {
        h = p2
        break
      }
      prev = key
    }
    if (!h) continue
    last = h
    await page.mouse.move(h[0] - 2, h[1])
    await page.waitForTimeout(80)
    await page.mouse.move(h[0], h[1])
    await page.waitForTimeout(150)
    await page.mouse.down()
    await page.waitForTimeout(80)
    let started = false
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(h[0] + (dx * i) / steps, h[1] + (dy * i) / steps)
      await page.waitForTimeout(40)
      if (!started && (await ev(page, (p) => p.gizmoState())).dragging) started = true
    }
    await page.mouse.up()
    await page.waitForTimeout(320)
    if (started) return { started: true, from: h }
  }
  return { started: false, from: last }
}

// ════════════════════════════════════════════════════════════════════════
section('A. Gizmo click-through (box on terrain)')
await ev(page, (p) => p.setToolByName('select'))
await page.waitForTimeout(200)
await clickObject('box-b')
ok(
  'box-b selected',
  (await ev(page, (p) => p.selectionIds())).includes('box-b'),
  await ev(page, (p) => p.selectionIds()),
)
ok('gizmo attached', (await ev(page, (p) => p.gizmoState())).attached)

const camBefore = await ev(page, (p) => p.cameraSnapshot())
const posBefore = (await posOf('box-b')).slice()
const dragA = await dragHandle('x', 70)
ok('found a real X move-handle on screen', dragA.from !== null, dragA.from)
ok('gizmo drag actually engaged', dragA.started, dragA)
const selAfter = await ev(page, (p) => p.selectionIds())
const camAfter = await ev(page, (p) => p.cameraSnapshot())
const posAfter = await posOf('box-b')
ok('selection is still exactly [box-b]', selAfter.length === 1 && selAfter[0] === 'box-b', selAfter)
ok('terrain was NOT selected by the drag', !selAfter.includes(`terrain:${FLOOR_ID}`), selAfter)
ok('box actually moved', Math.abs(posAfter[0]! - posBefore[0]!) > 0.05, { posBefore, posAfter })
const camDelta = Math.max(
  ...camBefore.pos.map((v, i) => Math.abs(v - camAfter.pos[i]!)),
  ...camBefore.rot.map((v, i) => Math.abs(v - camAfter.rot[i]!)),
)
ok('camera did not move during gizmo drag', camDelta < 1e-6, { camBefore, camAfter, camDelta })

// ════════════════════════════════════════════════════════════════════════
section('A2. RAPID click on a gizmo handle (no hover frame)')
// Real users press within the same frame they arrive on the handle. The old
// architecture gates scene picking on gizmo.isHovered, which is only updated
// when Babylon PROCESSES a pointermove — so a move+press in one tick leaks
// the click through to whatever is behind the gizmo (here: the terrain).
await clickObject('box-b')
let h2: [number, number] | null = null
for (let i = 0; i < 20 && !h2; i++) {
  await page.waitForTimeout(200)
  h2 = await evA(([p, a]) => p.gizmoHandleScreenPos(a as unknown as 'x'), 'x')
}
ok('handle located for rapid-click test', h2 !== null, h2)
if (h2) {
  // Park the cursor away, then jump onto the handle and press immediately.
  await page.mouse.move(200, 800)
  await page.waitForTimeout(300)
  await page.mouse.move(h2[0], h2[1])
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(300)
}
const rapidSel = await ev(page, (p) => p.selectionIds())
ok(
  'rapid press on a handle does NOT select what is behind it',
  rapidSel.length === 1 && rapidSel[0] === 'box-b',
  rapidSel,
)

// ════════════════════════════════════════════════════════════════════════
section('F. Select tool Ctrl/Alt semantics')
await clickObject('box-a')
ok(
  'plain click A → [A]',
  JSON.stringify(await ev(page, (p) => p.selectionIds())) === '["box-a"]',
  await ev(page, (p) => p.selectionIds()),
)
await clickObject('box-b', ['Control'])
let s = await ev(page, (p) => p.selectionIds())
ok('Ctrl+B → A+B', s.length === 2 && s.includes('box-a') && s.includes('box-b'), s)
await clickObject('box-c', ['Control'])
s = await ev(page, (p) => p.selectionIds())
ok('Ctrl+C → A+B+C', s.length === 3, s)
// Alt-click box-A: the group pivot (and therefore the gizmo) sits on box-B,
// and by design nothing behind a gizmo may receive a selection click.
await clickObject('box-a', ['Alt'])
s = await ev(page, (p) => p.selectionIds())
ok('Alt+A removes only A → B+C', s.length === 2 && !s.includes('box-a'), s)
await clickObject('box-a', ['Alt'])
s = await ev(page, (p) => p.selectionIds())
ok('Alt on unselected A does nothing → B+C', s.length === 2 && !s.includes('box-a'), s)
// Empty space: aim high above the scene where nothing is.
// The fixture terrain fills the viewport from the default pose, so an
// "empty" click means aiming at the sky: pitch up, click, restore.
const HOME_POS = [0, 45, -55]
const HOME_ROT = await ev(page, (p) => p.cameraSnapshot()).then((c) => c.rot)
const clickEmpty = async (mods: string[] = []): Promise<void> => {
  await ev(page, (p) => p.setCameraPose([0, 45, -55], [-0.9, 0, 0]))
  await page.waitForTimeout(120)
  await page.mouse.move(700, 120)
  for (const m of mods) await page.keyboard.down(m)
  await page.mouse.down()
  await page.mouse.up()
  for (const m of mods) await page.keyboard.up(m)
  await page.waitForTimeout(150)
  await page.evaluate(
    ([pr, pos, rot]) => (pr as Probe).setCameraPose(pos as number[], rot as number[]),
    [probe.handle, HOME_POS, HOME_ROT] as never,
  )
  // World→screen uses the last RENDERED transform matrix; under swiftshader a
  // frame can take ~250ms, so give the restore time to land.
  await page.waitForTimeout(500)
}
await clickEmpty(['Control'])
s = await ev(page, (p) => p.selectionIds())
ok('Ctrl+empty preserves selection', s.length === 2, s)
await clickEmpty(['Alt'])
s = await ev(page, (p) => p.selectionIds())
ok('Alt+empty preserves selection', s.length === 2, s)
await clickEmpty()
s = await ev(page, (p) => p.selectionIds())
ok('plain empty clears', s.length === 0, s)

// ════════════════════════════════════════════════════════════════════════
section('B. Group gizmo (3 statics)')
await clickObject('box-a')
await clickObject('box-b', ['Control'])
await clickObject('box-c', ['Control'])
s = await ev(page, (p) => p.selectionIds())
ok('3 selected', s.length === 3, s)
const before3 = await Promise.all(
  ['box-a', 'box-b', 'box-c'].map(async (id) => (await posOf(id)).slice()),
)
const hist0 = (await ev(page, (p) => p.history())).depth
const camB3 = await ev(page, (p) => p.cameraSnapshot())
const dragB = await dragHandle('x', 70)
ok('group gizmo handle exists', dragB.from !== null, dragB.from)
ok('group gizmo drag engaged', dragB.started, dragB)
const after3 = await Promise.all(
  ['box-a', 'box-b', 'box-c'].map(async (id) => (await posOf(id)).slice()),
)
const deltas = after3.map((p2, i) => p2[0]! - before3[i]![0]!)
ok(
  'all three moved',
  deltas.every((d) => Math.abs(d) > 0.05),
  deltas,
)
ok('all three received the SAME delta', Math.max(...deltas) - Math.min(...deltas) < 1e-4, deltas)
ok('selection unchanged after group drag', (await ev(page, (p) => p.selectionIds())).length === 3)
ok('exactly ONE history entry', (await ev(page, (p) => p.history())).depth === hist0 + 1, {
  before: hist0,
  after: (await ev(page, (p) => p.history())).depth,
})
const camA3 = await ev(page, (p) => p.cameraSnapshot())
ok(
  'camera unchanged during group drag',
  Math.max(...camB3.pos.map((v, i) => Math.abs(v - camA3.pos[i]!))) < 1e-6,
  { camB3, camA3 },
)

// ════════════════════════════════════════════════════════════════════════
section('G. Terrain wire stays visible while terrain is selected')
await clickEmpty()
const terrainScreen: [number, number] = [700, 700]
await page.mouse.move(...terrainScreen)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(250)
s = await ev(page, (p) => p.selectionIds())
const terrainId = s.find((x) => x.startsWith('terrain:')) ?? null
ok('clicking terrain selects exactly one terrain', s.length === 1 && terrainId !== null, s)
if (terrainId) {
  // The wire turns on in the render loop, and under swiftshader a frame can
  // be ~250ms — so wait for the first frame that shows it, THEN assert it
  // never blinks off. The requirement is persistence, not instant paint.
  let appeared = false
  for (let i = 0; i < 25 && !appeared; i++) {
    await page.waitForTimeout(120)
    appeared = Boolean((await ev(page, (p) => p.terrainWires()))[terrainId])
  }
  ok('wire appears for the selected terrain', appeared)
  let visibleFrames = 0
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(120)
    const w = await ev(page, (p) => p.terrainWires())
    if (w[terrainId]) visibleFrames++
  }
  ok('wire STAYS visible across 12 samples', visibleFrames === 12, { visibleFrames })
}

// ════════════════════════════════════════════════════════════════════════
section('H. Scale inputs')
await clickObject('box-a')
const scaleFields = (await page
  .evaluate(
    'JSON.stringify({x:(document.getElementById("s-x")||{}).value??"MISSING",y:(document.getElementById("s-y")||{}).value??"MISSING",z:(document.getElementById("s-z")||{}).value??"MISSING"})',
  )
  .then((j) => JSON.parse(j as string))) as { x: string; y: string; z: string }
ok(
  'selected box shows scale 1,1,1 (not 0, not blank)',
  scaleFields.x === '1' && scaleFields.y === '1' && scaleFields.z === '1',
  scaleFields,
)

// ════════════════════════════════════════════════════════════════════════
section('K. Face selection highlights only the picked faces')
await ev(page, (p) => p.setToolByName('face'))
await page.waitForTimeout(200)
await clickObject('box-a')
let fk = await ev(page, (p) => p.faceSelKeys())
ok('one face selected', fk.length === 1, fk)
const faceOverlay1 = (await page.evaluate(
  'window.__editor.faceOverlayCount ? window.__editor.faceOverlayCount() : -1',
)) as number
ok('a per-face overlay exists (not whole-mesh highlight)', faceOverlay1 === 1, { faceOverlay1 })
await clickObject('box-b', ['Control'])
fk = await ev(page, (p) => p.faceSelKeys())
ok('Ctrl adds a second face', fk.length === 2, fk)

// ════════════════════════════════════════════════════════════════════════
section('I. Base texture survives painting, any texture paints')
const paintProbe = (await page.evaluate(
  'window.__editor.surfaceMaterialOf ? "present" : "missing"',
)) as string
ok('layered surface probe exists', paintProbe === 'present', paintProbe)

// Place a terrain patch to paint on.
await ev(page, (p) => p.setToolByName('mesh'))
await page.waitForTimeout(200)
const meshOpts = await page.$$eval('#mesh-sel option', (os) => os.map((o) => o.textContent ?? ''))
await page.selectOption('#mesh-sel', String(meshOpts.findIndex((t) => t.includes('Terrain patch'))))
await page.mouse.move(1000, 620)
await page.waitForTimeout(400)
await page.mouse.click(1000, 620)
await page.waitForTimeout(600)
const terrains = await ev(page, (p) => p.terrainIds())
ok('a terrain patch exists to paint', terrains.length > 0, terrains)

if (terrains.length > 0) {
  const tid = terrains[terrains.length - 1]!
  // Give it a distinctive BASE texture through the inspector.
  await ev(page, (p) => p.setToolByName('select'))
  await evA(([p, id]) => p.selectByIds([id as unknown as string]), tid)
  await page.waitForTimeout(300)
  // The <select> is hidden behind the thumbnail picker widget, so drive the
  // same code path the picker does.
  await evA(([p, tex]) => p.setInspectorTexture(tex as unknown as string), 'red_brick')
  await page.waitForTimeout(400)
  const beforePaint = await evA(([p, id]) => p.surfaceMaterialOf(id as unknown as string), tid)
  ok('base texture set to red_brick', beforePaint?.base === 'red_brick', beforePaint)

  // Paint a DIFFERENT texture over it.
  await ev(page, (p) => p.setToolByName('paint'))
  await page.waitForTimeout(200)
  await ev(page, (p) => p.setPaintTexture('wood_planks'))
  await page.waitForTimeout(200)
  const [px, py] = await screenOf(tid)
  await page.mouse.move(px, py)
  await page.mouse.down()
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(px + i * 4, py + i * 2)
    await page.waitForTimeout(60)
  }
  await page.mouse.up()
  await page.waitForTimeout(500)

  const afterPaint = await evA(([p, id]) => p.surfaceMaterialOf(id as unknown as string), tid)
  ok('BASE is still red_brick after painting', afterPaint?.base === 'red_brick', afterPaint)
  ok(
    'painted texture became its own layer (not a grass/rock/mud swap)',
    afterPaint?.layers.some((l) => l.tex === 'wood_planks') === true,
    afterPaint?.layers,
  )
  ok('a paint mask was produced', afterPaint?.hasMask === true, afterPaint)

  // A second arbitrary texture allocates a second layer.
  await ev(page, (p) => p.setPaintTexture('metal_plate'))
  await page.waitForTimeout(200)
  await page.mouse.move(px + 12, py + 10)
  await page.mouse.down()
  await page.mouse.move(px + 16, py + 12)
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(500)
  const twoLayers = await evA(([p, id]) => p.surfaceMaterialOf(id as unknown as string), tid)
  ok(
    'a second arbitrary texture paints as a second layer',
    (twoLayers?.layers.length ?? 0) >= 2,
    twoLayers?.layers,
  )
  ok('base STILL red_brick with two paint layers', twoLayers?.base === 'red_brick', twoLayers)

  // ── Paint colour: tinted textures and plain colour ─────────────────
  await ev(page, (p) => p.setPaintTexture('red_brick'))
  await evA(([p, c]) => p.setPaintColor(c as unknown as string), '#3366ff')
  await page.waitForTimeout(200)
  await page.mouse.move(px - 10, py + 6)
  await page.mouse.down()
  await page.mouse.move(px - 6, py + 8)
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(500)
  const tinted = await evA(([p, id]) => p.surfaceMaterialOf(id as unknown as string), tid)
  ok(
    'a tinted texture becomes its own layer carrying the colour',
    tinted?.layers.some((l) => l.tex === 'red_brick' && l.color === '#3366ff') === true,
    tinted?.layers,
  )
  ok('base is STILL red_brick after tinted painting', tinted?.base === 'red_brick', tinted?.base)

  // Plain colour: no texture at all, the tint IS the paint.
  await ev(page, (p) => p.setPaintTexture(''))
  await evA(([p, c]) => p.setPaintColor(c as unknown as string), '#22cc55')
  await page.waitForTimeout(200)
  await page.mouse.move(px + 6, py - 8)
  await page.mouse.down()
  await page.mouse.move(px + 9, py - 6)
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(500)
  const plain = await evA(([p, id]) => p.surfaceMaterialOf(id as unknown as string), tid)
  ok(
    'plain colour paints as a texture-less layer',
    plain?.layers.some((l) => l.tex === 'none' && l.color === '#22cc55') === true,
    plain?.layers,
  )

  await page.screenshot({ path: 'scratch/visual/paint-colour.png' })
  const depthBefore = (await ev(page, (p) => p.history())).depth
  await ev(page, (p) => p.undo())
  await page.waitForTimeout(400)
  ok(
    'a paint stroke is exactly one undo entry',
    (await ev(page, (p) => p.history())).depth === depthBefore - 1,
    { depthBefore, after: (await ev(page, (p) => p.history())).depth },
  )
  await ev(page, (p) => p.redo())
  await page.waitForTimeout(300)
  ok('redo restores the stroke', (await ev(page, (p) => p.history())).depth === depthBefore)
}

// ════════════════════════════════════════════════════════════════════════
section('L. Environment')
const envOk = (await page.evaluate('window.__editor.hasSky()')) as boolean
ok('sky dome + clouds exist in the editor scene', envOk)

await page.screenshot({ path: 'scratch/visual/editor-final.png' })
await browser.close()
server.kill()

// ════════════════════════════════════════════════════════════════════════
// Scenarios that need a DIFFERENT map artifact get their own server. Each
// one boots, asserts, and tears down before the next starts.
// ════════════════════════════════════════════════════════════════════════

/** Boot a server + editor page on `map`, run `body`, then tear both down. */
async function withMap(
  port: number,
  map: unknown,
  body: (p: Page) => Promise<void>,
): Promise<void> {
  const d = mkdtempSync(join(tmpdir(), 'hobo-repro-'))
  const mp = join(d, 'map.json')
  writeFileSync(mp, JSON.stringify(map))
  const srv = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(d, 'world.db'),
      STATIC_DIR: 'apps/client/dist',
      MAP_PATH: mp,
      EDITOR_KEY: 'test-admin-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stderr!.on('data', (c) => console.log('[server]', String(c).slice(0, 400)))
  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('server never reported listening')), 30_000)
      srv.stdout!.on('data', (c) => {
        if (String(c).includes('listening')) {
          clearTimeout(t)
          res()
        }
      })
    })
    const br = await chromium.launch({
      args: ['--use-angle=swiftshader', '--enable-webgl', '--disable-gpu-sandbox'],
    })
    try {
      const pg = await br.newPage({ viewport: { width: 1400, height: 900 } })
      pg.on('pageerror', (e) =>
        console.log('[pageerror]', String((e as Error).stack ?? e).slice(0, 500)),
      )
      await pg.goto(`http://127.0.0.1:${port}/editor`)
      await pg.waitForSelector('#save', { timeout: 90_000 })
      await pg.waitForFunction(
        () => Boolean((window as never as { __editor?: unknown }).__editor),
        {
          timeout: 90_000,
        },
      )
      handles.set(
        pg,
        await pg.evaluateHandle(() => (window as never as { __editor: Probe }).__editor),
      )
      await body(pg)
    } finally {
      await br.close()
    }
  } finally {
    srv.kill()
  }
}

/** Per-page probe handles, so scenarios stay plain typed functions. */
const handles = new Map<Page, JSHandle<Probe>>()
const probeOf = <T>(pg: Page, fn: (p: Probe) => T): Promise<T> =>
  pg.evaluate(fn as never, handles.get(pg) as never) as Promise<T>

// ════════════════════════════════════════════════════════════════════════
section('O. Live static reconciliation reaches the running server')
{
  const port = PORT + 3
  const d = mkdtempSync(join(tmpdir(), 'hobo-repro-'))
  const mp = join(d, 'map.json')
  const base = { v: 2, terrains: [], statics: [], nodes: [], props: [], lights: [], zones: [] }
  writeFileSync(mp, JSON.stringify(base))
  const srv = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(d, 'world.db'),
      STATIC_DIR: 'apps/client/dist',
      MAP_PATH: mp,
      EDITOR_KEY: 'test-admin-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stderr!.on('data', (c) => console.log('[server]', String(c).slice(0, 400)))
  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('server never reported listening')), 30_000)
      srv.stdout!.on('data', (c) => {
        if (String(c).includes('listening')) {
          clearTimeout(t)
          res()
        }
      })
    })

    const root = `http://127.0.0.1:${port}`
    /** Wait for the tick loop to publish, then read the live map counts. */
    const counts = async (): Promise<Record<string, number>> => {
      for (let i = 0; i < 40; i++) {
        const m = (await (await fetch(`${root}/metrics`)).json()) as Record<string, number>
        if (m['tick']! > 0) return m
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('server never ticked')
    }
    /** POST a map through the real save pipeline; returns the new revision. */
    const save = async (map: unknown, ifMatch?: string): Promise<string> => {
      const resp = await fetch(`${root}/api/map`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-editor-key': 'test-admin-key',
          ...(ifMatch ? { 'if-match': ifMatch } : {}),
        },
        body: JSON.stringify(map),
      })
      if (!resp.ok) throw new Error(`save failed: ${resp.status} ${await resp.text()}`)
      return resp.headers.get('etag')?.replace(/"/g, '') ?? ''
    }

    ok('a blank map gives the server no map statics', (await counts())['mapStatics'] === 0)

    const withOne = {
      ...base,
      statics: [
        {
          id: 'live-a',
          shape: { type: 'box', size: [2, 2, 2] },
          pos: [3, 1, 0],
          yaw: 0,
          color: '#ff0000',
        },
      ],
    }
    let rev = await save(withOne)
    await new Promise((r) => setTimeout(r, 400))
    ok('saving a static gives it collision immediately', (await counts())['mapStatics'] === 1)

    // The bug this replaces: the second identical save appended a second copy.
    rev = await save(withOne, rev)
    await new Promise((r) => setTimeout(r, 400))
    ok('an identical repeated save creates no duplicate', (await counts())['mapStatics'] === 1)

    rev = await save(
      {
        ...base,
        statics: [{ ...withOne.statics[0], pos: [12, 1, 0] }],
      },
      rev,
    )
    await new Promise((r) => setTimeout(r, 400))
    ok('moving it keeps exactly one body', (await counts())['mapStatics'] === 1)

    rev = await save(base, rev)
    await new Promise((r) => setTimeout(r, 400))
    ok('deleting it removes the collision', (await counts())['mapStatics'] === 0)

    // Zones apply live too, in their own replaceable layer.
    rev = await save(
      {
        ...base,
        zones: [
          {
            id: 'zone-live',
            name: 'Live',
            min: [-5, -5, -5],
            max: [5, 5, 5],
            rules: { pvp: false, build: true, physgun: true },
          },
        ],
      },
      rev,
    )
    await new Promise((r) => setTimeout(r, 400))
    ok('a saved zone reaches the server rule index', (await counts())['mapZones'] === 1)
    await save(base, rev)
    await new Promise((r) => setTimeout(r, 400))
    ok('removing the zone removes the rule', (await counts())['mapZones'] === 0)
  } finally {
    srv.kill()
  }
}

// ════════════════════════════════════════════════════════════════════════
section('M. Native v2 blank map — no fabricated ground')
await withMap(
  PORT + 1,
  { v: 2, terrains: [], statics: [], nodes: [], props: [], lights: [], zones: [] },
  async (pg) => {
    ok(
      'the document has zero terrain objects',
      (await probeOf(pg, (p) => p.terrainIds())).length === 0,
    )
    ok(
      'the viewport has zero terrain meshes',
      (await probeOf(pg, (p) => p.terrainMeshCount())) === 0,
    )
    // The retired main mesh was called exactly 'terrain', and its overlay
    // 'wire'. Neither may exist: a blank map has no hidden ground.
    const stray = await probeOf(pg, (p) => p.sceneMeshNames())
    ok(
      'no legacy "terrain"/"wire" mesh in the scene',
      !stray.includes('terrain') && !stray.includes('wire'),
      stray,
    )
    const counts = await probeOf(pg, (p) => p.objectCounts())
    ok('no statics either — the map really is empty', counts['statics'] === 0, counts)
  },
)

// ════════════════════════════════════════════════════════════════════════
section('N. v1 migration smoke — old maps still load')
{
  const v1flat = new Float32Array((SUB + 1) * (SUB + 1)).fill(1.5)
  const v1b64 = Buffer.from(
    new Uint8Array(v1flat.buffer, v1flat.byteOffset, v1flat.byteLength),
  ).toString('base64')
  await withMap(
    PORT + 2,
    {
      v: 1,
      halfExtent: HALF,
      sub: SUB,
      heights: v1b64,
      statics: [
        { shape: { type: 'box', size: [4, 4, 4] }, pos: [6, 2, 0], yaw: 0, color: '#c04040' },
      ],
    },
    async (pg) => {
      const ids = await probeOf(pg, (p) => p.terrainIds())
      // The old privileged heightfield is now ONE ordinary terrain object.
      ok(
        'the v1 main heightfield became an ordinary terrain',
        ids.includes('terrain:terrain-v1-main'),
        ids,
      )
      ok('exactly one terrain came across', ids.length === 1, ids)
      const counts = await probeOf(pg, (p) => p.objectCounts())
      ok('the v1 static came across', counts['statics'] === 1, counts)
      // Nothing treats the migrated terrain as special: it selects like any
      // other object, under its real id.
      await probeOf(pg, (p) => p.setToolByName('select'))
      await probeOf(pg, (p) => p.selectByIds(['terrain:terrain-v1-main']))
      ok(
        'it selects under its real id, with no "main" special case',
        (await probeOf(pg, (p) => p.selectionIds())).includes('terrain:terrain-v1-main'),
        await probeOf(pg, (p) => p.selectionIds()),
      )
    },
  )
}

console.log(
  `\n${'═'.repeat(64)}\n${checks - failures}/${checks} checks passed, ${failures} FAILED\n`,
)
process.exit(failures > 0 ? 1 : 0)
