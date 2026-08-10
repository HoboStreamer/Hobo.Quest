/**
 * Visual test harness: boots a real server + the built client in headless
 * Chromium and captures screenshots so avatar/viewmodel/world changes can
 * be SEEN, not guessed at. Screenshots land in scratch/visual/.
 *
 * Run: pnpm --filter @hobo/client build && tsx apps/client/scripts/visualTest.ts [outDir]
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

const PORT = 18150
const OUT = process.argv[2] ?? 'scratch/visual'
const dir = mkdtempSync(join(tmpdir(), 'hobo-visual-'))
let server: ChildProcess | null = null

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: join(dir, 'world.db'),
        STATIC_DIR: 'apps/client/dist',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => reject(new Error('server did not start')), 30000)
    server.stdout?.on('data', (c: Buffer) => {
      if (c.toString().includes('"listening"')) {
        clearTimeout(timer)
        resolve()
      }
    })
    server.stderr?.on('data', (c: Buffer) => process.stderr.write(c))
  })
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  console.log(`  shot: ${OUT}/${name}.png`)
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await startServer()
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-webgl', '--disable-gpu-sandbox'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))
  page.on('console', (msg) => {
    logs.push(`${msg.type()}: ${msg.text()}`)
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.waitForSelector('#btn-join', { timeout: 30000 })
  await page.waitForTimeout(2500) // engine boot + first preview frames
  await shot(page, '01-customize-male')
  await page.screenshot({
    path: join(OUT, '01b-legs-closeup.png'),
    clip: { x: 480, y: 350, width: 400, height: 420 },
  })
  console.log(`  shot: ${OUT}/01b-legs-closeup.png`)

  // Female + ponytail variant
  await page.click('text=Female')
  await page.waitForTimeout(400)
  for (let i = 0; i < 3; i++) {
    await page.click('#row-hairstyle button:last-child')
    await page.waitForTimeout(150)
  }
  await shot(page, '02-customize-female')

  await page.click('text=Male')
  await page.waitForTimeout(400)
  await page.fill('#cname', 'VisualBot')
  await page.click('#btn-join')
  await page.waitForTimeout(4000) // havok load + connect + spawn
  await shot(page, '03-ingame-spawn')

  interface HoboDebug {
    input: { yaw: number; pitch: number }
    interact: { handle(a: { kind: string }): void; physgunActive: boolean }
    state: { heldBy: Map<string, string>; myEntityId: string }
  }
  const dbg = () => (window as unknown as { __hobo: HoboDebug }).__hobo

  // Look down to check the first-person body (drive input tracker directly).
  await page.evaluate(() => {
    ;(window as unknown as { __hobo: { input: { pitch: number } } }).__hobo.input.pitch = -1.2
  })
  await page.waitForTimeout(700)
  await shot(page, '04-look-down-body')

  console.log('phase: physgun E2E (walk to crates, grab, verify no freeze)')
  await page.evaluate(() => {
    const w = (window as unknown as { __hobo: { input: { yaw: number; pitch: number } } }).__hobo
    w.input.pitch = 0
    w.input.yaw = 0
  })
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(3000) // walk through the north gate toward the crates
  await page.keyboard.up('KeyW')
  await page.waitForTimeout(800)
  // Park the cursor first: synthetic mouse.move generates movement deltas
  // that would otherwise destroy the aim set below.
  await page.evaluate(() => {
    const w = window as unknown as { __hobo: { input: { debugForceLock(): void } } }
    w.__hobo.input.debugForceLock()
  })
  await page.mouse.move(640, 400)
  await page.waitForTimeout(150)
  // Aim precisely at the nearest crate using replicated state.
  const aimed = await page.evaluate(() => {
    interface Dbg {
      input: { yaw: number; pitch: number }
      state: {
        entities: Map<string, { kind: string; def?: string; pos: [number, number, number] }>
      }
      interact: { player?: unknown }
    }
    const w = (window as unknown as { __hobo: Dbg }).__hobo
    const cam = (
      window as unknown as { __hobo: { player: { eye: { x: number; y: number; z: number } } } }
    ).__hobo.player
    const eye = cam.eye
    let best: { d: number; pos: [number, number, number] } | null = null
    for (const e of w.state.entities.values()) {
      if (e.kind !== 'prop') continue
      const dx = e.pos[0] - eye.x
      const dz = e.pos[2] - eye.z
      const d = Math.hypot(dx, dz)
      if (!best || d < best.d) best = { d, pos: e.pos }
    }
    if (!best || best.d > 7.5) return false
    const dx = best.pos[0] - eye.x
    const dy = best.pos[1] - eye.y
    const dz = best.pos[2] - eye.z
    w.input.yaw = Math.atan2(dx, dz)
    w.input.pitch = Math.atan2(dy, Math.hypot(dx, dz))
    return true
  })
  console.log(`  aimed at a nearby crate: ${aimed}`)
  await page.waitForTimeout(150) // a couple of input ticks carry the aim to the server
  await page.mouse.down()
  await page.waitForTimeout(400)
  const yawBefore = await page.evaluate(
    () => (window as unknown as { __hobo: { input: { yaw: number } } }).__hobo.input.yaw,
  )
  for (let i = 0; i < 6; i++) {
    // Synthetic CDP moves carry no movementX; dispatch real MouseEvents so
    // the look pipeline (which reads movement deltas) is actually exercised.
    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointermove', { movementX: 30, movementY: 0 }))
    })
    await page.waitForTimeout(60)
  }
  const yawAfter = await page.evaluate(
    () => (window as unknown as { __hobo: { input: { yaw: number } } }).__hobo.input.yaw,
  )
  console.log(
    `  look responsive while LMB held: ${Math.abs(yawAfter - yawBefore) > 0.0001} (dyaw=${(yawAfter - yawBefore).toFixed(4)})`,
  )
  await page.waitForTimeout(600)
  const alive = await Promise.race([
    page.evaluate(() => 1 + 1).then(() => true),
    new Promise<boolean>((res) => setTimeout(() => res(false), 4000)),
  ])
  console.log(`  page responsive after grab: ${alive}`)
  const held = await page.evaluate(() => {
    const w = (window as unknown as { __hobo: { state: { heldBy: Map<string, string> } } }).__hobo
    return w.state.heldBy.size
  })
  console.log(`  beams active (heldBy size): ${held}`)
  await shot(page, '06-physgun-grab')
  await page.mouse.up()
  void dbg

  await page.evaluate(() => {
    const w = (window as unknown as { __hobo: { input: { yaw: number; pitch: number } } }).__hobo
    w.input.pitch = -0.15
    w.input.yaw = Math.PI
  })
  await page.waitForTimeout(700)
  await shot(page, '05-look-back-city')

  // Stances: remote view can't be captured solo, but the FP camera height
  // and body pose show in first person.
  await page.keyboard.down('KeyC')
  await page.waitForTimeout(900)
  await page.evaluate(() => {
    ;(window as unknown as { __hobo: { input: { pitch: number } } }).__hobo.input.pitch = -1.1
  })
  await page.waitForTimeout(400)
  await shot(page, '09-crouch-lookdown')
  await page.keyboard.up('KeyC')
  await page.waitForTimeout(900)
  await page.keyboard.press('KeyZ')
  await page.waitForTimeout(1600)
  await shot(page, '10-prone')
  await page.keyboard.press('KeyZ')
  await page.waitForTimeout(1600)

  // Icon factory diagnostic: dump the physgun icon to a file.
  const iconData = await page.evaluate(() => {
    const w = window as unknown as { __hobo: { icons: { iconFor(id: string): string } } }
    return w.__hobo.icons.iconFor('physgun')
  })
  console.log(`  icon dataURL length: ${iconData.length}`)
  if (iconData.length > 200) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(OUT, 'icon-physgun.png'),
      Buffer.from(iconData.split(',')[1] ?? '', 'base64'),
    )
    console.log(`  shot: ${OUT}/icon-physgun.png`)
  }

  // Tab menu: inventory with generated icons.
  await page.keyboard.press('Tab')
  await page.waitForTimeout(800)
  await shot(page, '07-menu-inventory')
  await page.click('text=Crafting')
  await page.waitForTimeout(500)
  await shot(page, '08-menu-crafting')
  await page.keyboard.press('Tab')

  console.log('CONSOLE LOG SAMPLE:')
  for (const l of logs.filter((l) => l.includes('[vm]') || l.includes('warn')).slice(0, 8)) {
    console.log('  ', l.slice(0, 220))
  }

  // Viewmodel orientation sweep (debug param) — isolated storage per page.
  for (const rot of [0, 90, 180, 270]) {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } })
    const p2 = await ctx.newPage()
    await p2.goto(`http://127.0.0.1:${PORT}/?vmrot=${rot}`)
    await p2.waitForSelector('#btn-join', { timeout: 30000 })
    await p2.waitForTimeout(1500)
    await p2.click('#btn-join')
    await p2.waitForTimeout(3500)
    await p2.screenshot({ path: join(OUT, `vm-rot-${rot}.png`) })
    console.log(`  shot: ${OUT}/vm-rot-${rot}.png`)
    await ctx.close()
  }

  if (errors.length > 0) {
    console.log('PAGE ERRORS:')
    for (const e of errors.slice(0, 10)) console.log('  ', e.slice(0, 300))
  } else {
    console.log('no page errors')
  }

  await browser.close()
  server?.kill('SIGTERM')
  rmSync(dir, { recursive: true, force: true })
  console.log('VISUAL TEST DONE')
}

main().catch((err) => {
  console.error(err)
  server?.kill('SIGTERM')
  process.exit(1)
})
