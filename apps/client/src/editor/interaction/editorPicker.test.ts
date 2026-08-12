import { describe, expect, it } from 'vitest'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import { resolveFrontMost, resolveOwner, type MeshOwner } from './editorPicker.js'

/** Minimal stand-in: only the parent chain matters for ownership. */
const meshNode = (name: string, parent: unknown = null): AbstractMesh =>
  ({ name, parent }) as unknown as AbstractMesh

describe('resolveOwner', () => {
  const owners = new Map<string, MeshOwner>([
    ['glb-root', { objectId: 'model-1', kind: 'model' }],
    ['box', { objectId: 'static-1', kind: 'static' }],
  ])
  const lookup = (m: AbstractMesh): MeshOwner | null => owners.get(m.name) ?? null

  it('resolves a directly owned mesh', () => {
    expect(resolveOwner(meshNode('box'), lookup)?.objectId).toBe('static-1')
  })

  it('resolves an imported model child up to its owning object', () => {
    const root = meshNode('glb-root')
    const child = meshNode('mesh_0', meshNode('node_2', root))
    expect(resolveOwner(child, lookup)).toEqual({ objectId: 'model-1', kind: 'model' })
  })

  it('returns null for editor-only helpers (sky, brush, wires, ghosts)', () => {
    for (const n of ['skybox', 'clouds', 'brush', 'wire', 'ghost', 'peer:3:eye'])
      expect(resolveOwner(meshNode(n), lookup)).toBeNull()
  })

  it('does not loop forever on a cyclic parent chain', () => {
    const a = meshNode('a') as unknown as { parent: unknown }
    const b = meshNode('b', a) as unknown as { parent: unknown }
    a.parent = b
    expect(resolveOwner(a as unknown as AbstractMesh, lookup)).toBeNull()
  })
})

describe('resolveFrontMost', () => {
  it('returns null with no hits', () => {
    expect(resolveFrontMost([])).toBeNull()
  })

  it('picks the nearest hit', () => {
    const win = resolveFrontMost([
      { objectId: 'far', distance: 20 },
      { objectId: 'near', distance: 5 },
      { objectId: 'mid', distance: 12 },
    ])
    expect(win?.objectId).toBe('near')
  })

  it('breaks coincident-surface ties deterministically by id', () => {
    // Two terrains at exactly the same depth: whatever traversal order the
    // scene produces, the same one must win every time.
    const a = { objectId: 'terrain:aaa', distance: 10 }
    const b = { objectId: 'terrain:bbb', distance: 10 + 1e-9 }
    expect(resolveFrontMost([a, b])?.objectId).toBe('terrain:aaa')
    expect(resolveFrontMost([b, a])?.objectId).toBe('terrain:aaa')
  })

  it('a genuinely nearer surface still beats a lower id', () => {
    const a = { objectId: 'terrain:aaa', distance: 10 }
    const b = { objectId: 'terrain:bbb', distance: 4 }
    expect(resolveFrontMost([a, b])?.objectId).toBe('terrain:bbb')
    expect(resolveFrontMost([b, a])?.objectId).toBe('terrain:bbb')
  })

  it('never returns more than one result for overlapping terrain', () => {
    const hits = [
      { objectId: 'terrain:big', distance: 30 },
      { objectId: 'terrain:small', distance: 30 },
      { objectId: 'terrain:tiny', distance: 30 },
    ]
    const win = resolveFrontMost(hits)
    expect(win).not.toBeNull()
    expect(hits.filter((h) => h === win)).toHaveLength(1)
  })
})
