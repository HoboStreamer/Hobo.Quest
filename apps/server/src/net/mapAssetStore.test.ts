import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_ASSET_BYTES,
  hashOf,
  isContentAddressed,
  sniffAsset,
  storeAsset,
} from './mapAssetStore.js'

const dir = (): string => mkdtempSync(join(tmpdir(), 'hobo-assets-'))

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('some pixels'),
])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif body')])
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.from('vp8 body'),
])
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0]), Buffer.from('chunks')])

describe('sniffAsset', () => {
  it('identifies every type the editor may upload', () => {
    expect(sniffAsset(PNG)).toEqual({ mime: 'image/png', ext: 'png' })
    expect(sniffAsset(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' })
    expect(sniffAsset(WEBP)).toEqual({ mime: 'image/webp', ext: 'webp' })
    expect(sniffAsset(GLB)).toEqual({ mime: 'model/gltf-binary', ext: 'glb' })
  })

  it('rejects anything else, however it was labelled', () => {
    expect(sniffAsset(Buffer.from('<?php system($_GET[0]); ?>'))).toBeNull()
    expect(sniffAsset(Buffer.from('<svg onload=alert(1)>'))).toBeNull()
    expect(sniffAsset(Buffer.from('#!/bin/sh\nrm -rf /'))).toBeNull()
    expect(sniffAsset(Buffer.alloc(0))).toBeNull()
  })

  it('does not accept a truncated signature', () => {
    expect(sniffAsset(Buffer.from([0x89, 0x50]))).toBeNull()
    expect(sniffAsset(Buffer.from('RIFF____'))).toBeNull()
  })
})

describe('storeAsset', () => {
  it('names the file after its content and returns the url', async () => {
    const d = dir()
    const r = await storeAsset(d, PNG)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.asset.hash).toBe(hashOf(PNG))
    expect(r.asset.url).toBe(`/map-assets/${hashOf(PNG)}.png`)
    expect(r.asset.mime).toBe('image/png')
    expect(r.asset.bytes).toBe(PNG.length)
    expect(readFileSync(join(d, `${hashOf(PNG)}.png`))).toEqual(PNG)
  })

  it('deduplicates identical content — one file, one url, no rewrite', async () => {
    const d = dir()
    const first = await storeAsset(d, PNG)
    const second = await storeAsset(d, Buffer.from(PNG))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.deduplicated).toBe(true)
    expect(second.asset.url).toBe(first.asset.url)
    expect(readdirSync(d)).toHaveLength(1)
  })

  it('gives different content different urls', async () => {
    const d = dir()
    const a = await storeAsset(d, PNG)
    const b = await storeAsset(d, Buffer.concat([PNG, Buffer.from('!')]))
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.asset.url).not.toBe(b.asset.url)
    expect(readdirSync(d)).toHaveLength(2)
  })

  it('picks the extension from the bytes, never from a caller', async () => {
    // The old endpoint took ?ext= from the client, so arbitrary bytes could
    // be stored — and later served — as an image.
    const d = dir()
    const r = await storeAsset(d, GLB)
    expect(r.ok && r.asset.url.endsWith('.glb')).toBe(true)
  })

  it('refuses unsupported content instead of storing it', async () => {
    const d = dir()
    const r = await storeAsset(d, Buffer.from('not an asset'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('unsupported_type')
    expect(readdirSync(d)).toEqual([])
  })

  it('refuses an empty upload', async () => {
    const r = await storeAsset(dir(), Buffer.alloc(0))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it('refuses an oversized upload with 413', async () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_ASSET_BYTES)])
    const r = await storeAsset(dir(), huge)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(413)
  })

  it('leaves no temp files behind', async () => {
    const d = dir()
    await storeAsset(d, PNG)
    await storeAsset(d, JPEG)
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('survives concurrent uploads of the same content', async () => {
    const d = dir()
    const results = await Promise.all(Array.from({ length: 8 }, () => storeAsset(d, PNG)))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(readdirSync(d)).toEqual([`${hashOf(PNG)}.png`])
  })
})

describe('isContentAddressed', () => {
  it('recognises hashed names, which are safe to cache forever', () => {
    expect(isContentAddressed(`${hashOf(PNG)}.png`)).toBe(true)
  })

  it('does not vouch for legacy or hand-made names', () => {
    expect(isContentAddressed('tex-abc123.png')).toBe(false)
    expect(isContentAddressed('sha256-short.png')).toBe(false)
    expect(isContentAddressed('../../etc/passwd')).toBe(false)
  })
})
