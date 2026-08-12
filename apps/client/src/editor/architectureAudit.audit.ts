/**
 * Structural completion audit.
 *
 * The editor spent a while running TWO architectures at once: new systems
 * (EditorDocument, SelectionManager, CommandHistory, MapFile v2) alongside the
 * old ones they were meant to replace. That duplication is invisible to type
 * checking and to behavioural tests — both architectures "work" — so it needs
 * a test of its own or it quietly becomes permanent.
 *
 * This audit fails while any legacy construct is still ACTIVE runtime code.
 * Migration code, migration tests and documentation are explicitly allowed:
 * one-way v1 → v2 compatibility is the intended end state.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = new URL('../../../../', import.meta.url).pathname
const SCAN_ROOTS = ['apps/client/src', 'apps/server/src', 'packages/content/src']

/** Files that legitimately mention legacy constructs. */
const ALLOWED = [
  // One-way v1 → v2 compatibility lives here by design.
  'packages/content/src/mapFile.ts',
  'packages/content/src/mapFileV2.ts',
  'packages/content/src/mapFileV2.test.ts',
  // The audit itself names everything it forbids.
  'apps/client/src/editor/architectureAudit.audit.ts',
]

interface SourceFile {
  path: string
  text: string
}

function collect(): SourceFile[] {
  const out: SourceFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-types') continue
        walk(full)
        continue
      }
      if (!['.ts', '.tsx'].includes(extname(entry))) continue
      const rel = relative(REPO, full)
      if (ALLOWED.some((a) => rel === a)) continue
      out.push({ path: rel, text: readFileSync(full, 'utf8') })
    }
  }
  for (const root of SCAN_ROOTS) walk(join(REPO, root))
  return out
}

const FILES = collect()

/** Occurrences outside comments — a mention in prose is not active code. */
function activeHits(needle: RegExp): { path: string; line: number; text: string }[] {
  const hits: { path: string; line: number; text: string }[] = []
  for (const f of FILES) {
    let inBlockComment = false
    f.text.split('\n').forEach((raw, i) => {
      const line = raw.trim()
      if (inBlockComment) {
        if (line.includes('*/')) inBlockComment = false
        return
      }
      if (line.startsWith('/*')) {
        if (!line.includes('*/')) inBlockComment = true
        return
      }
      if (line.startsWith('//') || line.startsWith('*')) return
      if (needle.test(raw)) hits.push({ path: f.path, line: i + 1, text: line.slice(0, 110) })
    })
  }
  return hits
}

const report = (hits: { path: string; line: number; text: string }[]): string =>
  hits.map((h) => `${h.path}:${h.line}  ${h.text}`).join('\n')

describe('architecture audit: the transitional editor is gone', () => {
  it('scans a meaningful number of source files', () => {
    // Guard against the audit silently passing because it scanned nothing.
    expect(FILES.length).toBeGreaterThan(40)
  })

  it('has no special "main terrain" concept', () => {
    for (const pattern of [
      /['"`]terrain:main['"`]/,
      /\bmainSelected\b/,
      /\bmainGone\b/,
      /\bmainconvert\b/,
      /\bselectMainTerrain\b/,
      /\bconvertMainToPatch\b/,
    ]) {
      const hits = activeHits(pattern)
      expect(report(hits), `legacy main-terrain construct ${pattern}`).toBe('')
    }
  })

  it('has no parallel multi-selection arrays', () => {
    for (const pattern of [
      /\bmultiSel\b/,
      /\bmultiPatches\b/,
      /\bmultiNodes\b/,
      /\bmultiProps\b/,
      /\bmultiTotal\b/,
      /\bmultiPivot\b/,
    ]) {
      const hits = activeHits(pattern)
      expect(report(hits), `legacy selection array ${pattern}`).toBe('')
    }
  })

  it('has no reverse v2 → v1 runtime projection', () => {
    expect(report(activeHits(/\bprojectV2ToV1\b/))).toBe('')
  })

  it('does not use the UndoOp/applyOp union as the history mechanism', () => {
    for (const pattern of [/\bUndoOp\b/, /\bapplyOp\b/, /\bpushUndo\b/]) {
      const hits = activeHits(pattern)
      expect(report(hits), `legacy history construct ${pattern}`).toBe('')
    }
  })

  it('does not use Babylon TerrainMaterial for authored surfaces', () => {
    // The layered surface shader replaced its fixed grass/rock/mud palette.
    expect(report(activeHits(/\bTerrainMaterial\b/))).toBe('')
  })

  it('keeps main.ts a boot/wiring layer', () => {
    const main = FILES.find((f) => f.path === 'apps/client/src/editor/main.ts')
    expect(main, 'editor main.ts should exist').toBeDefined()
    const kb = Buffer.byteLength(main!.text, 'utf8') / 1024
    expect(kb, `editor main.ts is ${kb.toFixed(0)} KB; it should be boot/wiring only`).toBeLessThan(
      25,
    )
  })

  it('keeps editorApp.ts a composition root rather than a second god-file', () => {
    // main.ts was decomposed; the composition root must not silently become
    // the thing it replaced.
    const app = FILES.find((f) => f.path === 'apps/client/src/editor/editorApp.ts')
    expect(app, 'editorApp.ts should exist').toBeDefined()
    const kb = Buffer.byteLength(app!.text, 'utf8') / 1024
    // The harness surface lives in devProbe.ts and inspector-edit command
    // construction in history/commands.ts; neither is composition.
    expect(kb, `editorApp.ts is ${kb.toFixed(0)} KB`).toBeLessThan(45)
  })

  it('keeps editor.html free of a giant inline stylesheet', () => {
    const html = readFileSync(join(REPO, 'apps/client/editor.html'), 'utf8')
    const style = /<style[\s\S]*?<\/style>/.exec(html)?.[0] ?? ''
    expect(
      style.length,
      `editor.html has a ${(style.length / 1024).toFixed(0)} KB inline <style> block`,
    ).toBeLessThan(2048)
  })
})

/**
 * The second class of regression: not a legacy construct coming back, but a
 * completed system quietly losing the property that made it correct. Each of
 * these is a specific failure this editor actually had.
 */
const fileText = (path: string): string => {
  const f = FILES.find((x) => x.path === path)
  expect(f, `${path} should exist`).toBeDefined()
  return f!.text
}

describe('architecture audit: completed systems keep their guarantees', () => {
  it('never puts the editor credential in the WebSocket URL', () => {
    // A query string is logged by proxies and lives in browser history; the
    // credential goes in the first frame, after the socket is open.
    const conn = fileText('apps/client/src/editor/collaboration/editorConnection.ts')
    const url = /new WebSocket\(([^)]*)\)/.exec(conn)?.[1] ?? ''
    expect(url, 'editor-ws URL').not.toMatch(/key|token|cred|auth/i)
    expect(url).not.toContain('?')
  })

  it('decodes collaboration frames through the shared protocol, not ad-hoc parsing', () => {
    // "Runtime validation of untrusted JSON" — a hostile client is assumed,
    // and a malformed frame must be rejected whole rather than half-applied.
    expect(fileText('apps/server/src/net/editorWs.ts')).toContain('decodeEditorClientMessage')
    expect(fileText('apps/client/src/editor/collaboration/editorConnection.ts')).toContain(
      'decodeEditorServerMessage',
    )
    // The server must not reach into a raw parse of its own.
    expect(activeHits(/JSON\.parse/).filter((h) => h.path.endsWith('net/editorWs.ts'))).toEqual([])
  })

  it('lets the SERVER assign peer identity', () => {
    const ws = fileText('apps/server/src/net/editorWs.ts')
    // A client-supplied id or colour is a client that can impersonate a peer.
    expect(ws).toMatch(/peerId\s*[:=]/)
    expect(ws).not.toMatch(/msg\.peerId|hello\.peerId|msg\.color/)
  })

  it('routes mutations through the lock gate', () => {
    // Every path that changes the document while someone else may hold a
    // lease goes through withLock; a menu item that skips it is a lock that
    // does not enforce anything.
    const app = fileText('apps/client/src/editor/editorApp.ts')
    expect(app).toContain('const withLock =')
    expect((app.match(/withLock\(/g) ?? []).length).toBeGreaterThan(4)
  })

  it('makes the harness probe obey the same gate', () => {
    // `groupMove` once bypassed withLock, which made the collaboration suite
    // prove nothing: it "moved" objects Bob was never granted.
    const probe = fileText('apps/client/src/editor/devProbe.ts')
    const groupMove = /groupMove:[\s\S]*?\n {4}\}/.exec(probe)?.[0] ?? ''
    expect(groupMove, 'devProbe.groupMove').toContain('withLock')
    // And it may only reach the gate through the app, never re-implement it.
    expect(probe).not.toContain('const withLock =')
  })

  it('keeps asset authority in the document', () => {
    // Two asset registries meant an import could be visible in the browser
    // and absent from the saved map.
    const doc = fileText('apps/client/src/editor/document/editorDocument.ts')
    for (const method of [
      'addTextureAsset',
      'addModelAsset',
      'renameTextureAsset',
      'replaceAssets',
    ])
      expect(doc, `EditorDocument.${method}`).toContain(method)
    // The save path serializes the document; it must not splice asset arrays
    // in from somewhere else on the way out.
    const save = fileText('apps/client/src/editor/net/saveController.ts')
    expect(save).not.toMatch(/models:\s*\[|textures:\s*\[/)
  })

  it('has real Asset Browser actions, not placeholders', () => {
    const ui = fileText('apps/client/src/editor/ui/editorUi.ts')
    for (const cb of ['onDeleteTexture', 'onDeleteModel', 'onRenameTexture'])
      expect(ui, cb).toMatch(new RegExp(`${cb}:[^\\n]*assets\\.`))
  })

  it('paints by object kind rather than only on terrain', () => {
    const paint = fileText('apps/client/src/editor/materials/paintController.ts')
    // Written either way round; what matters is that statics are handled.
    expect(paint).toMatch(/kind (===|!==) 'static'/)
    expect(paint).toContain('staticHit')
    // The brush entry point must not be gated on the terrain view type.
    const hitTest = /hitTest\([\s\S]*?\n {2}\}/.exec(paint)?.[0] ?? ''
    expect(hitTest, 'PaintController.hitTest').not.toContain('instanceof TerrainView')
  })

  it('has Light and Zone placement wired to real tools', () => {
    const app = fileText('apps/client/src/editor/editorApp.ts')
    expect(app).toContain('lightForPlacement')
    expect(app).toContain('zoneForPlacement')
  })

  it('identifies map-authored entities by provenance, never by distance', () => {
    // The proximity heuristic is the specific bug: `dx*dx + dz*dz < 1`.
    const world = fileText('apps/server/src/game/gameWorld.ts')
    const nodes = /reconcileMapNodes\(\)[\s\S]*?\n {2}\}/.exec(world)?.[0] ?? ''
    const props = /reconcileMapProps\(\)[\s\S]*?\n {2}\}/.exec(world)?.[0] ?? ''
    expect(nodes, 'reconcileMapNodes').toContain('planMapProvenance')
    expect(props, 'reconcileMapProps').toContain('planMapProvenance')
    for (const region of [nodes, props])
      expect(region).not.toMatch(/dx\s*\*\s*dx|distanceSquared|nearest/i)
  })

  it('reconciles the running map by stable id instead of rebuilding categories', () => {
    // A normal map_reload must not dispose every light, terrain and static.
    const main = fileText('apps/client/src/main.ts')
    expect(main).toContain('mapDiff')
    expect(main, 'buildMapLights rebuilt every light on every reload').not.toMatch(
      /\bbuildMapLights\(/,
    )
    expect(fileText('apps/server/src/game/gameWorld.ts')).toContain('MapTerrainLayer')
  })
})
