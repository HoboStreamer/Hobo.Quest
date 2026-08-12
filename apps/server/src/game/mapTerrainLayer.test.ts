/**
 * Live terrain reconciliation. The behaviour that matters is what does NOT
 * happen: retinting a surface must not tear down a trimesh, and an identical
 * repeated save must not touch a body at all.
 */
import { describe, expect, it } from 'vitest'
import type { TerrainPatchData } from '@hobo/content'
import type { BodyDesc, BodyId } from '@hobo/physics'
import { MapTerrainLayer, terrainCollisionSignature } from './mapTerrainLayer.js'

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

const terrain = (id: string, over: Partial<TerrainPatchData> = {}): TerrainPatchData => ({
  id,
  origin: [0, 0, 0],
  halfExtent: 8,
  sub: 4,
  heights: new Float32Array(25),
  ...over,
})

describe('MapTerrainLayer', () => {
  it('creates a body per terrain', () => {
    const physics = new RecordingPhysics()
    const layer = new MapTerrainLayer(physics)
    layer.reconcile([terrain('a'), terrain('b', { origin: [40, 0, 0] })])
    expect(layer.size).toBe(2)
    expect(physics.live.size).toBe(2)
  })

  it('an identical repeated save touches NOTHING', () => {
    const physics = new RecordingPhysics()
    const layer = new MapTerrainLayer(physics)
    const before = [terrain('a')]
    layer.reconcile(before)
    const body = layer.bodyOf('a')
    physics.reset()

    layer.reconcile([terrain('a')])
    expect(physics.added).toEqual([])
    expect(physics.removed).toEqual([])
    expect(layer.bodyOf('a')).toBe(body)
  })

  it('a SURFACE-only edit rebuilds no collision at all', () => {
    // Physics and rendering are separate costs and only one of them moved.
    const physics = new RecordingPhysics()
    const layer = new MapTerrainLayer(physics)
    layer.reconcile([terrain('a')])
    const body = layer.bodyOf('a')
    physics.reset()

    layer.reconcile([
      terrain('a', {
        surface: { base: { tex: 'red_brick', color: '#ff0000' } },
        tex: 'red_brick',
        color: '#ff0000',
      }),
    ])
    expect(physics.added).toEqual([])
    expect(physics.removed).toEqual([])
    expect(layer.bodyOf('a')).toBe(body)
  })

  it('a sculpt rebuilds exactly the terrain that was sculpted', () => {
    const physics = new RecordingPhysics()
    const layer = new MapTerrainLayer(physics)
    layer.reconcile([terrain('a'), terrain('b', { origin: [40, 0, 0] })])
    const untouched = layer.bodyOf('b')
    physics.reset()

    const sculpted = new Float32Array(25)
    sculpted[12] = 3
    layer.reconcile([terrain('a', { heights: sculpted }), terrain('b', { origin: [40, 0, 0] })])
    expect(physics.added).toHaveLength(1)
    expect(physics.removed).toHaveLength(1)
    expect(layer.bodyOf('b')).toBe(untouched)
  })

  it('a move rebuilds that body', () => {
    const physics = new RecordingPhysics()
    const layer = new MapTerrainLayer(physics)
    layer.reconcile([terrain('a')])
    physics.reset()
    layer.reconcile([terrain('a', { origin: [10, 2, 10] })])
    expect(physics.added).toHaveLength(1)
    expect(physics.live.get(layer.bodyOf('a')!)!.pos).toEqual({ x: 10, y: 2, z: 10 })
  })

  it('a scale change rebuilds, because the VERTICES are scaled', () => {
    const physics = new RecordingPhysics()
    const layer = new MapTerrainLayer(physics)
    layer.reconcile([terrain('a')])
    physics.reset()
    layer.reconcile([terrain('a', { scale: [2, 1, 2] })])
    expect(physics.added).toHaveLength(1)
  })

  it('removes collision for a deleted terrain and nothing else', () => {
    const physics = new RecordingPhysics()
    const layer = new MapTerrainLayer(physics)
    layer.reconcile([terrain('a'), terrain('b', { origin: [40, 0, 0] })])
    const keep = layer.bodyOf('b')
    layer.reconcile([terrain('b', { origin: [40, 0, 0] })])
    expect(layer.size).toBe(1)
    expect(layer.bodyOf('a')).toBeUndefined()
    expect(layer.bodyOf('b')).toBe(keep)
  })

  it('a blank map leaves no authored terrain collider', () => {
    const physics = new RecordingPhysics()
    const layer = new MapTerrainLayer(physics)
    layer.reconcile([terrain('a')])
    layer.reconcile([])
    expect(physics.live.size).toBe(0)
  })

  it('skips a terrain with no id rather than minting an unremovable body', () => {
    const physics = new RecordingPhysics()
    const layer = new MapTerrainLayer(physics)
    layer.reconcile([terrain('') as TerrainPatchData])
    expect(layer.size).toBe(0)
  })
})

describe('terrainCollisionSignature', () => {
  it('ignores appearance', () => {
    expect(terrainCollisionSignature(terrain('a'))).toBe(
      terrainCollisionSignature(
        terrain('a', { tex: 'red_brick', color: '#ff0000', surface: { base: {} } }),
      ),
    )
  })

  it('notices every collision-relevant field', () => {
    const base = terrainCollisionSignature(terrain('a'))
    const heights = new Float32Array(25)
    heights[3] = 1
    for (const over of [
      { origin: [1, 0, 0] as [number, number, number] },
      { rot: [0, 0.5, 0] as [number, number, number] },
      { scale: [2, 2, 2] as [number, number, number] },
      { halfExtent: 16 },
      { heights },
    ])
      expect(terrainCollisionSignature(terrain('a', over)), JSON.stringify(over)).not.toBe(base)
  })
})
