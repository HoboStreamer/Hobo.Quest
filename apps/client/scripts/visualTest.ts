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

  // Look down to check the first-person body (drive input tracker directly).
  await page.evaluate(() => {
    const w = window as unknown as { __hoboInput?: { yaw: number; pitch: number } }
    if (w.__hoboInput) {
      w.__hoboInput.pitch = -1.2
    }
  })
  await page.waitForTimeout(700)
  await shot(page, '04-look-down-body')

  // Look forward-left toward the plaza/fountain.
  await page.evaluate(() => {
    const w = window as unknown as { __hoboInput?: { yaw: number; pitch: number } }
    if (w.__hoboInput) {
      w.__hoboInput.pitch = -0.15
      w.__hoboInput.yaw = Math.PI
    }
  })
  await page.waitForTimeout(700)
  await shot(page, '05-look-back-city')

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
