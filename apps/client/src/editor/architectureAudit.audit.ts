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

  it('keeps editor.html free of a giant inline stylesheet', () => {
    const html = readFileSync(join(REPO, 'apps/client/editor.html'), 'utf8')
    const style = /<style[\s\S]*?<\/style>/.exec(html)?.[0] ?? ''
    expect(
      style.length,
      `editor.html has a ${(style.length / 1024).toFixed(0)} KB inline <style> block`,
    ).toBeLessThan(2048)
  })
})
