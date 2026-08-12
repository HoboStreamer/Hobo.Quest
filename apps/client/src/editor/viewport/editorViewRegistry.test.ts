/**
 * The registry is pure bookkeeping — it never touches Babylon itself, only
 * the `EditorView` interface — so it is tested with fake views that record
 * what they were asked to do. That is the point: identity, ownership and
 * lifecycle must be correct independently of what any particular view draws.
 */
import { describe, expect, it } from 'vitest'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import {
  EditorDocument,
  type EditorObject,
  type EditorObjectKind,
} from '../document/editorDocument.js'
import { EditorViewRegistry, type EditorView } from './editorViewRegistry.js'

interface FakeMesh {
  name: string
  parent: FakeMesh | null
  children: FakeMesh[]
  getChildMeshes(): FakeMesh[]
}

const mesh = (name: string, parent: FakeMesh | null = null): FakeMesh => {
  const m: FakeMesh = { name, parent, children: [], getChildMeshes: () => m.children }
  parent?.children.push(m)
  return m
}

class FakeView implements EditorView {
  readonly root: TransformNode
  readonly main: FakeMesh
  disposed = false
  updates: { keys: readonly string[] }[] = []
  visible = true
  /** Set to make `update` report "rebuild me". */
  refuseKeys: string[] = []
  static built = 0

  constructor(
    readonly id: string,
    readonly kind: EditorObjectKind,
  ) {
    FakeView.built++
    this.main = mesh(`${kind}:${id}`)
    this.root = this.main as unknown as TransformNode
  }

  meshes(): Mesh[] {
    return [this.main as unknown as Mesh]
  }

  update(_object: EditorObject, keys: readonly string[]): boolean {
    this.updates.push({ keys })
    return !keys.some((k) => this.refuseKeys.includes(k))
  }

  setVisible(on: boolean): void {
    this.visible = on
  }

  dispose(): void {
    this.disposed = true
  }
}

const box = (id: string, over: Record<string, unknown> = {}): never =>
  ({
    id,
    shape: { type: 'box', size: [1, 1, 1] },
    pos: [0, 0, 0],
    yaw: 0,
    color: '#ffffff',
    ...over,
  }) as never

function harness(): { doc: EditorDocument; reg: EditorViewRegistry; views: Map<string, FakeView> } {
  const doc = new EditorDocument()
  const views = new Map<string, FakeView>()
  const reg = new EditorViewRegistry(doc, (id, kind) => {
    const v = new FakeView(id, kind)
    views.set(id, v)
    return v
  })
  reg.start()
  return { doc, reg, views }
}

describe('EditorViewRegistry: lifecycle follows the document', () => {
  it('builds a view for each object already in the document', () => {
    const doc = new EditorDocument()
    doc.add('static', box('a'))
    doc.add('static', box('b'))
    const reg = new EditorViewRegistry(doc, (id, kind) => new FakeView(id, kind))
    reg.start()
    expect(reg.size).toBe(2)
  })

  it('creates a view when an object is added', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    expect(h.reg.viewOf('a')).not.toBeNull()
  })

  it('disposes the view when the object is removed', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    const view = h.views.get('a')!
    h.doc.remove('a')
    expect(view.disposed).toBe(true)
    expect(h.reg.viewOf('a')).toBeNull()
  })

  it('updates in place, passing only the keys that changed', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    const view = h.views.get('a')!
    h.doc.update('a', { color: '#123456' })
    expect(view.updates.at(-1)!.keys).toEqual(['color'])
    expect(view.disposed).toBe(false)
  })

  it('rebuilds when a view says it cannot apply a change', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    const first = h.views.get('a')!
    first.refuseKeys = ['shape']
    h.doc.update('a', { shape: { type: 'sphere', radius: 2 } } as never)
    expect(first.disposed).toBe(true)
    // Same id, new view: identity survives the rebuild.
    expect(h.reg.viewOf('a')).not.toBe(first)
    expect(h.reg.viewOf('a')!.id).toBe('a')
  })

  it('a REPLACE reports only what differs, so a tint edit does not rebuild', () => {
    // Inspector edits replace the whole object to make one clean undo step.
    // When that reported "everything changed", altering a colour rebuilt the
    // mesh — and re-instantiated the glTF for an imported model.
    const h = harness()
    h.doc.add('static', box('a'))
    const view = h.views.get('a')!
    view.refuseKeys = ['shape']
    const builtBefore = FakeView.built
    h.doc.replace('a', box('a', { color: '#123456' }))
    expect(view.updates.at(-1)!.keys).toEqual(['color'])
    expect(FakeView.built, 'no rebuild for a colour-only replace').toBe(builtBefore)
  })

  it('but a replace that DOES change the shape still rebuilds', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    h.views.get('a')!.refuseKeys = ['shape']
    const builtBefore = FakeView.built
    h.doc.replace('a', box('a', { shape: { type: 'sphere', radius: 2 } }))
    expect(FakeView.built).toBe(builtBefore + 1)
  })

  it('rebuilds everything on a remote document replacement', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    const before = h.views.get('a')!
    const next = new EditorDocument()
    next.add('static', box('c'))
    h.doc.replaceFromRemote(next.serialize())
    expect(before.disposed).toBe(true)
    expect(h.reg.viewOf('a')).toBeNull()
    expect(h.reg.viewOf('c')).not.toBeNull()
  })

  it('batches a transaction into one pass', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    h.doc.add('static', box('b'))
    const va = h.views.get('a')!
    const vb = h.views.get('b')!
    va.updates.length = 0
    vb.updates.length = 0
    h.doc.transact(() => {
      h.doc.update('a', { pos: [1, 0, 0] })
      h.doc.update('b', { pos: [2, 0, 0] })
    })
    expect(va.updates).toHaveLength(1)
    expect(vb.updates).toHaveLength(1)
  })
})

describe('EditorViewRegistry: mesh ownership', () => {
  it('resolves a picked mesh to its object id', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    const m = h.views.get('a')!.main
    expect(h.reg.ownerOf(m as unknown as AbstractMesh)).toBe('a')
  })

  it('resolves a CHILD mesh to the owning object', () => {
    // Imported models are hierarchies; clicking a door must select the
    // instance, not nothing.
    const h = harness()
    h.doc.add('static', box('a'))
    const view = h.views.get('a')!
    const child = mesh('door', view.main)
    const grandchild = mesh('handle', child)
    h.reg.reindex('a')
    expect(h.reg.ownerOf(child as unknown as AbstractMesh)).toBe('a')
    expect(h.reg.ownerOf(grandchild as unknown as AbstractMesh)).toBe('a')
  })

  it('forgets ownership when the view goes', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    const m = h.views.get('a')!.main
    h.doc.remove('a')
    expect(h.reg.ownerOf(m as unknown as AbstractMesh)).toBeNull()
  })

  it('does not claim a mesh it has never seen', () => {
    const h = harness()
    expect(h.reg.ownerOf(mesh('stranger') as unknown as AbstractMesh)).toBeNull()
    expect(h.reg.ownerOf(null)).toBeNull()
  })

  it('re-owns meshes after an explicit rebuild', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    const stale = h.views.get('a')!.main
    h.reg.rebuild('a')
    const fresh = h.views.get('a')!.main
    expect(h.reg.ownerOf(stale as unknown as AbstractMesh)).toBeNull()
    expect(h.reg.ownerOf(fresh as unknown as AbstractMesh)).toBe('a')
  })
})

describe('EditorViewRegistry: the mesh set stays truthful', () => {
  it('lists every view mesh', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    h.doc.add('static', box('b'))
    expect(h.reg.allMeshes()).toHaveLength(2)
  })

  it('drops a removed object from the cached mesh list', () => {
    // Cached for picking; a stale entry is a pick on a disposed mesh.
    const h = harness()
    h.doc.add('static', box('a'))
    h.reg.allMeshes()
    h.doc.remove('a')
    expect(h.reg.allMeshes()).toEqual([])
  })

  it('picks up a mesh added by an explicit reindex', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    expect(h.reg.allMeshes()).toHaveLength(1)
    mesh('loaded-child', h.views.get('a')!.main)
    h.reg.reindex('a')
    // The child is owned but not listed as a top-level pickable mesh.
    expect(h.reg.allMeshes()).toHaveLength(1)
    expect(h.reg.ownerOf(h.views.get('a')!.main.children[0] as unknown as AbstractMesh)).toBe('a')
  })

  it('a rebuilt view replaces its meshes rather than accumulating them', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    h.reg.rebuild('a')
    h.reg.rebuild('a')
    expect(h.reg.allMeshes()).toHaveLength(1)
  })

  it('unindexing one object leaves every other owner intact', () => {
    // The old cleanup scanned the whole owner table per removal; this is the
    // behaviour that scan provided and the reverse index must preserve.
    const h = harness()
    for (const id of ['a', 'b', 'c']) h.doc.add('static', box(id))
    const keep = h.views.get('c')!.main
    h.doc.remove('b')
    expect(h.reg.ownerOf(keep as unknown as AbstractMesh)).toBe('c')
    expect(h.reg.allMeshes()).toHaveLength(2)
  })
})

describe('EditorViewRegistry: teardown', () => {
  it('stop() disposes every view and stops following the document', () => {
    const h = harness()
    h.doc.add('static', box('a'))
    const view = h.views.get('a')!
    h.reg.stop()
    expect(view.disposed).toBe(true)
    expect(h.reg.size).toBe(0)
    h.doc.add('static', box('b'))
    expect(h.reg.size).toBe(0)
  })
})
