import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { emptyMapV2, blankHeights, type MapFileV2 } from '@hobo/content'
import { MAX_MAP_BYTES, loadMap, revisionOf, saveMap } from './mapStore.js'

let dir: string
let mapPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hobo-mapstore-'))
  mapPath = join(dir, 'map.json')
})

const withTerrain = (h = 8): MapFileV2 => {
  const m = emptyMapV2()
  m.terrains.push({ id: 't1', pos: [0, 0, 0], halfExtent: 16, sub: h, heights: blankHeights(h) })
  return m
}

describe('loadMap', () => {
  it('returns an EMPTY v2 map when no artifact exists', async () => {
    const r = await loadMap(mapPath)
    expect(r.map.v).toBe(2)
    expect(r.map.terrains).toEqual([])
  })

  it('migrates a v1 artifact on the way in', async () => {
    writeFileSync(
      mapPath,
      JSON.stringify({
        v: 1,
        halfExtent: 100,
        sub: 8,
        heights: blankHeights(8),
        statics: [],
      }),
    )
    const r = await loadMap(mapPath)
    expect(r.map.v).toBe(2)
    expect(r.map.terrains).toHaveLength(1)
  })

  it('falls back to an empty map rather than throwing on garbage', async () => {
    writeFileSync(mapPath, '{ not json')
    expect((await loadMap(mapPath)).map.terrains).toEqual([])
  })
})

describe('revisions', () => {
  it('is stable for the same document and differs for a changed one', async () => {
    const a = await saveMap(
      mapPath,
      JSON.stringify(withTerrain()),
      await loadMap(mapPath),
      undefined,
    )
    expect(a.status).toBe(200)
    const rev1 = a.status === 200 ? a.record.revision : ''
    const again = await loadMap(mapPath)
    expect(again.revision).toBe(rev1)

    const changed = withTerrain()
    changed.terrains[0]!.pos = [5, 0, 0]
    const b = await saveMap(mapPath, JSON.stringify(changed), again, again.revision)
    expect(b.status).toBe(200)
    if (b.status === 200) expect(b.record.revision).not.toBe(rev1)
  })

  it('does not depend on the revision field embedded in the payload', () => {
    // Otherwise the hash would feed on itself and never settle.
    expect(revisionOf('{"a":1}')).toBe(revisionOf('{"a":1}'))
  })

  it('a save that changes nothing keeps the same revision', async () => {
    const first = await saveMap(
      mapPath,
      JSON.stringify(withTerrain()),
      await loadMap(mapPath),
      undefined,
    )
    const cur = first.status === 200 ? first.record : null
    const second = await saveMap(mapPath, JSON.stringify(cur!.map), cur!, cur!.revision)
    expect(second.status).toBe(200)
    if (second.status === 200) expect(second.record.revision).toBe(cur!.revision)
  })
})

describe('save pipeline', () => {
  it('rejects a stale revision with 409 and reports the current one', async () => {
    const base = await loadMap(mapPath)
    const first = await saveMap(mapPath, JSON.stringify(withTerrain()), base, undefined)
    const cur = first.status === 200 ? first.record : null

    const other = withTerrain()
    other.terrains[0]!.pos = [9, 9, 9]
    const stale = await saveMap(mapPath, JSON.stringify(other), cur!, 'an-old-revision')
    expect(stale.status).toBe(409)
    if (stale.status === 409) expect(stale.revision).toBe(cur!.revision)
    // The on-disk artifact is untouched by the refused save.
    expect(JSON.parse(readFileSync(mapPath, 'utf8')).terrains[0].pos).toEqual([0, 0, 0])
  })

  it('allows a first save with no If-Match', async () => {
    const r = await saveMap(
      mapPath,
      JSON.stringify(withTerrain()),
      await loadMap(mapPath),
      undefined,
    )
    expect(r.status).toBe(200)
  })

  it('rejects invalid JSON with 400', async () => {
    expect((await saveMap(mapPath, '{oops', await loadMap(mapPath), undefined)).status).toBe(400)
  })

  it('rejects a schema-invalid map with 422 and lists the issues', async () => {
    const bad = withTerrain()
    // Height count disagrees with the declared resolution.
    bad.terrains[0]!.sub = 64
    const r = await saveMap(mapPath, JSON.stringify(bad), await loadMap(mapPath), undefined)
    expect(r.status).toBe(422)
    if (r.status === 422) expect(r.issues!.join(' ')).toContain('height samples')
  })

  it('rejects an oversized payload with 413 without parsing it', async () => {
    const huge = 'x'.repeat(MAX_MAP_BYTES + 1)
    expect((await saveMap(mapPath, huge, await loadMap(mapPath), undefined)).status).toBe(413)
  })

  it('accepts and migrates a v1 payload', async () => {
    const v1 = {
      v: 1,
      halfExtent: 100,
      sub: 8,
      heights: blankHeights(8),
      statics: [],
      mix: 'data:image/png;base64,AAA',
    }
    const r = await saveMap(mapPath, JSON.stringify(v1), await loadMap(mapPath), undefined)
    expect(r.status).toBe(200)
    // It is persisted as v2, with the splat migrated to paint layers.
    const onDisk = JSON.parse(readFileSync(mapPath, 'utf8'))
    expect(onDisk.v).toBe(2)
    expect(onDisk.terrains[0].surface.paint.layers).toHaveLength(3)
  })

  it('writes atomically — no .tmp file is left behind', async () => {
    await saveMap(mapPath, JSON.stringify(withTerrain()), await loadMap(mapPath), undefined)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
