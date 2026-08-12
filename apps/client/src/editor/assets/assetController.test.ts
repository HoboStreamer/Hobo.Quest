import { describe, expect, it } from 'vitest'
import { blankHeights } from '@hobo/content'
import { EditorDocument } from '../document/editorDocument.js'
import { CommandHistory } from '../history/commandHistory.js'
import {
  AssetController,
  collectModelUsage,
  collectTextureUsage,
  sanitizeTextureName,
} from './assetController.js'

const surface = (base?: string, layers: string[] = []): unknown => ({
  base: base ? { tex: base } : {},
  ...(layers.length
    ? {
        paint: {
          mask: 'data:x',
          layers: layers.map((tex, i) => ({ id: `l${i}`, tex, channel: 'rgba'[i] })),
        },
      }
    : {}),
})

function populated(): EditorDocument {
  const d = new EditorDocument()
  d.addTextureAsset({ name: 'brick', url: '/map-assets/sha256-a.png', scale: 2 })
  d.addTextureAsset({ name: 'unused', url: '/map-assets/sha256-b.png' })
  d.addModelAsset({ id: 'm1', name: 'Chair', glb: '/map-assets/sha256-c.glb', bounds: [1, 1, 1] })
  d.addModelAsset({ id: 'm2', name: 'Unused', glb: '/map-assets/sha256-d.glb', bounds: [1, 1, 1] })
  d.add('terrain', {
    id: 't1',
    pos: [0, 0, 0],
    halfExtent: 8,
    sub: 4,
    heights: blankHeights(4),
    surface: surface('custom:brick'),
  } as never)
  d.add('static', {
    id: 's1',
    shape: { type: 'box', size: [1, 1, 1] },
    pos: [0, 0, 0],
    yaw: 0,
    color: '#ffffff',
    model: 'm1',
    faces: { '2': { tex: 'custom:brick' } },
  } as never)
  d.add('static', {
    id: 's2',
    shape: { type: 'box', size: [1, 1, 1] },
    pos: [0, 0, 0],
    yaw: 0,
    color: '#ffffff',
    surfaces: { 'face:0': surface(undefined, ['custom:brick', 'none']) },
  } as never)
  return d
}

const controller = (doc: EditorDocument) => {
  const history = new CommandHistory<EditorDocument>(doc)
  const messages: string[] = []
  const ctl = new AssetController({
    doc,
    history,
    modelCache: { forget: () => undefined, instantiate: () => Promise.resolve(null) } as never,
    editorKey: () => 'k',
    onAssetsChanged: () => undefined,
    setMessage: (m) => messages.push(m),
  })
  return { ctl, history, messages }
}

describe('collectTextureUsage', () => {
  it('counts EVERY place a reference can live', () => {
    // The previous scan saw terrain surfaces and `static.tex` only, so a
    // texture used solely by a painted face counted as unused — and
    // "refuse to delete while referenced" is worthless with a wrong count.
    const usage = collectTextureUsage(populated()).get('custom:brick')!
    expect(usage.ids.sort()).toEqual(['s1', 's2', 't1'])
  })

  it('finds a per-face override', () => {
    const d = new EditorDocument()
    d.add('static', {
      id: 's1',
      shape: { type: 'box', size: [1, 1, 1] },
      pos: [0, 0, 0],
      yaw: 0,
      color: '#ffffff',
      faces: { '3': { tex: 'custom:only-here' } },
    } as never)
    expect(collectTextureUsage(d).get('custom:only-here')?.count).toBe(1)
  })

  it('finds a paint layer inside a per-surface override', () => {
    const usage = collectTextureUsage(populated())
    expect(usage.get('custom:brick')!.ids).toContain('s2')
  })

  it('does NOT count the plain-colour sentinel as an asset', () => {
    expect(collectTextureUsage(populated()).get('none')).toBeUndefined()
  })

  it('reports an unreferenced texture as absent', () => {
    expect(collectTextureUsage(populated()).get('custom:unused')).toBeUndefined()
  })
})

describe('collectModelUsage', () => {
  it('counts placements', () => {
    expect(collectModelUsage(populated()).get('m1')).toEqual({ count: 1, ids: ['s1'] })
    expect(collectModelUsage(populated()).get('m2')).toBeUndefined()
  })
})

describe('sanitizeTextureName', () => {
  it('makes a safe name from a filename', () => {
    expect(sanitizeTextureName('Red Brick 01.PNG', () => false)).toBe('red_brick_01')
  })

  it('avoids collisions', () => {
    const taken = new Set(['brick', 'brick_2'])
    expect(sanitizeTextureName('brick.png', (n) => taken.has(n))).toBe('brick_3')
  })

  it('always produces something', () => {
    expect(sanitizeTextureName('***.png', () => false)).toBe('texture')
  })
})

describe('delete', () => {
  it('refuses a referenced texture', () => {
    const doc = populated()
    const { ctl, messages } = controller(doc)
    expect(ctl.deleteTexture('brick')).toBe(false)
    expect(doc.textureByName('brick')).not.toBeNull()
    expect(messages.at(-1)).toContain('used by 3')
  })

  it('removes an unreferenced texture, undoably', () => {
    const doc = populated()
    const { ctl, history } = controller(doc)
    expect(ctl.deleteTexture('unused')).toBe(true)
    expect(doc.textureByName('unused')).toBeNull()
    history.undo()
    expect(doc.textureByName('unused')).not.toBeNull()
  })

  it('refuses a placed model and removes an unplaced one', () => {
    const doc = populated()
    const { ctl, history } = controller(doc)
    expect(ctl.deleteModel('m1')).toBe(false)
    expect(ctl.deleteModel('m2')).toBe(true)
    expect(doc.modelById('m2')).toBeNull()
    history.undo()
    expect(doc.modelById('m2')).not.toBeNull()
  })
})

describe('rename', () => {
  it('updates the entry AND every reference, atomically', () => {
    // Renaming the entry alone leaves every user pointing at a texture that
    // no longer exists.
    const doc = populated()
    const { ctl, history } = controller(doc)
    expect(ctl.renameTexture('brick', 'stone')).toBe(true)

    expect(doc.textureByName('stone')).not.toBeNull()
    expect(doc.textureByName('brick')).toBeNull()
    const usage = collectTextureUsage(doc)
    expect(usage.get('custom:brick')).toBeUndefined()
    expect(usage.get('custom:stone')!.ids.sort()).toEqual(['s1', 's2', 't1'])
    expect(history.depth).toBe(1)
  })

  it('undo restores the name and every reference', () => {
    const doc = populated()
    const { ctl, history } = controller(doc)
    ctl.renameTexture('brick', 'stone')
    history.undo()
    expect(doc.textureByName('brick')).not.toBeNull()
    expect(collectTextureUsage(doc).get('custom:brick')!.ids.sort()).toEqual(['s1', 's2', 't1'])
  })

  it('rewrites a face override and a per-surface paint layer', () => {
    const doc = populated()
    controller(doc).ctl.renameTexture('brick', 'stone')
    const s1 = doc.get('s1') as unknown as { faces: Record<string, { tex: string }> }
    expect(s1.faces['2']!.tex).toBe('custom:stone')
    const s2 = doc.get('s2') as unknown as {
      surfaces: Record<string, { paint: { layers: { tex: string }[] } }>
    }
    expect(s2.surfaces['face:0']!.paint.layers[0]!.tex).toBe('custom:stone')
    // The plain-colour sentinel beside it is untouched.
    expect(s2.surfaces['face:0']!.paint.layers[1]!.tex).toBe('none')
  })

  it('refuses a name another texture already has', () => {
    const doc = populated()
    const { ctl, messages } = controller(doc)
    expect(ctl.renameTexture('brick', 'unused')).toBe(false)
    expect(messages.at(-1)).toContain('already exists')
    expect(doc.textureByName('brick')).not.toBeNull()
  })

  it('sanitizes what the user typed', () => {
    const doc = populated()
    controller(doc).ctl.renameTexture('unused', 'My Nice Texture!')
    expect(doc.textureByName('my_nice_texture')).not.toBeNull()
  })
})
