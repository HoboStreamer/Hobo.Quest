/**
 * Live map-static reconciliation — the behaviour the editor's Save button
 * claims: adding, moving or deleting a static changes collision immediately,
 * and saving the same map twice changes nothing.
 *
 * A recording fake stands in for `PhysicsWorld` (the layer only ever calls
 * addBody/removeBody). Asserting on the exact calls is the point: a version
 * that removed and re-added every body on every save would pass a
 * "collision is correct" test while costing a full rebuild per save.
 */
import { describe, expect, it } from 'vitest'
import { compileMapFileV2, emptyMapV2, type MapFileV2, type StaticBody } from '@hobo/content'
import type { BodyDesc, BodyId } from '@hobo/physics'
import { MapStaticLayer } from './mapStaticLayer.js'

class RecordingPhysics {
  private next = 1
  readonly live = new Map<BodyId, BodyDesc>()
  readonly added: BodyId[] = []
  readonly removed: BodyId[] = []

  addBody(desc: BodyDesc): BodyId {
    const id = this.next++
    this.live.set(id, desc)
    this.added.push(id)
    return id
  }

  removeBody(id: BodyId): void {
    this.live.delete(id)
    this.removed.push(id)
  }

  reset(): void {
    this.added.length = 0
    this.removed.length = 0
  }
}

const box = (id: string, over: Record<string, unknown> = {}): StaticBody =>
  ({
    id,
    shape: { type: 'box', size: [2, 2, 2] },
    pos: [0, 0, 0],
    yaw: 0,
    color: '#ffffff',
    ...over,
  }) as StaticBody

/** Statics as the runtime actually receives them: compiled from a document. */
const compiled = (statics: StaticBody[]): readonly StaticBody[] =>
  compileMapFileV2({ ...emptyMapV2(), statics } as unknown as MapFileV2).statics ?? []

describe('MapStaticLayer', () => {
  it('adds collision for a static the map introduces', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    layer.reconcile(compiled([box('s1')]))
    expect(layer.size).toBe(1)
    expect(physics.live.size).toBe(1)
  })

  it('an identical repeated save creates NO duplicate bodies and touches nothing', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    const statics = [box('s1'), box('s2', { pos: [4, 0, 0] })]
    layer.reconcile(compiled(statics))
    const before = [layer.bodyOf('s1'), layer.bodyOf('s2')]
    physics.reset()

    layer.reconcile(compiled(structuredClone(statics)))
    expect(physics.added).toEqual([])
    expect(physics.removed).toEqual([])
    expect(layer.size).toBe(2)
    expect([layer.bodyOf('s1'), layer.bodyOf('s2')]).toEqual(before)
  })

  it('a reorder is not a change — array position is not identity', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    layer.reconcile(compiled([box('s1'), box('s2', { pos: [4, 0, 0] })]))
    physics.reset()
    layer.reconcile(compiled([box('s2', { pos: [4, 0, 0] }), box('s1')]))
    expect(physics.added.concat(physics.removed)).toEqual([])
  })

  it('moves a static by replacing ONLY that body', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    layer.reconcile(compiled([box('s1'), box('s2', { pos: [4, 0, 0] })]))
    const untouched = layer.bodyOf('s2')
    physics.reset()

    layer.reconcile(compiled([box('s1', { pos: [9, 0, 9] }), box('s2', { pos: [4, 0, 0] })]))
    expect(physics.added).toHaveLength(1)
    expect(physics.removed).toHaveLength(1)
    expect(layer.bodyOf('s2')).toBe(untouched)
    expect(physics.live.get(layer.bodyOf('s1')!)!.pos).toEqual({ x: 9, y: 0, z: 9 })
  })

  it('removes collision when the map deletes a static', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    layer.reconcile(compiled([box('s1'), box('s2')]))
    layer.reconcile(compiled([box('s1')]))
    expect(layer.size).toBe(1)
    expect(physics.live.size).toBe(1)
    expect(layer.bodyOf('s2')).toBeUndefined()
  })

  it('leaves nothing behind when the map clears every static', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    layer.reconcile(compiled([box('s1'), box('s2')]))
    layer.reconcile([])
    expect(physics.live.size).toBe(0)
    expect(layer.size).toBe(0)
  })

  it('collides at the SCALED size, so render and physics cannot disagree', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    layer.reconcile(compiled([box('s1', { scale: [3, 1, 1] })]))
    const shape = physics.live.get(layer.bodyOf('s1')!)!.shape
    expect(shape.type === 'box' && shape.size).toEqual([6, 2, 2])
  })

  it('rebuilds a body when only its scale changed', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    layer.reconcile(compiled([box('s1')]))
    physics.reset()
    layer.reconcile(compiled([box('s1', { scale: [2, 2, 2] })]))
    expect(physics.added).toHaveLength(1)
    expect(physics.removed).toHaveLength(1)
  })

  it('skips a static with no id rather than minting an unremovable body', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    layer.reconcile([box('') as StaticBody])
    expect(layer.size).toBe(0)
    expect(physics.live.size).toBe(0)
  })

  it('clear() drops every body', () => {
    const physics = new RecordingPhysics()
    const layer = new MapStaticLayer(physics)
    layer.reconcile(compiled([box('s1'), box('s2')]))
    layer.clear()
    expect(physics.live.size).toBe(0)
    expect(layer.size).toBe(0)
  })
})
