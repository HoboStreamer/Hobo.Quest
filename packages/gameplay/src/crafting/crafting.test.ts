import { describe, expect, it } from 'vitest'
import { ContentRegistry, ITEMS, RECIPES, TEST_WORLD } from '@hobo/content'
import { Inventory } from '../inventory/inventory.js'
import { validateCraft } from './crafting.js'
import { CraftQueue } from './queue.js'

const content = new ContentRegistry(ITEMS, RECIPES, TEST_WORLD)
const noStations = { nearbyWorkstations: new Set<string>() }
const withBench = { nearbyWorkstations: new Set(['workbench']) }

function makeInv(): Inventory {
  return new Inventory(20, 4, content)
}

describe('validateCraft', () => {
  it('rejects unknown recipes', () => {
    const result = validateCraft(content, makeInv(), 'nope', noStations)
    expect(result).toEqual({ ok: false, error: 'unknown_recipe' })
  })

  it('rejects missing ingredients', () => {
    const inv = makeInv()
    inv.add('wood_plank', 3) // needs 4
    inv.add('scrap_metal', 2)
    const result = validateCraft(content, inv, 'craft_wooden_crate', noStations)
    expect(result).toEqual({ ok: false, error: 'missing_items' })
  })

  it('accepts when ingredients present', () => {
    const inv = makeInv()
    inv.add('wood_plank', 4)
    inv.add('scrap_metal', 2)
    expect(validateCraft(content, inv, 'craft_wooden_crate', noStations).ok).toBe(true)
  })

  it('enforces workstation requirement', () => {
    const inv = makeInv()
    inv.add('scrap_metal', 6)
    expect(validateCraft(content, inv, 'craft_metal_barrel', noStations)).toEqual({
      ok: false,
      error: 'missing_workstation',
    })
    expect(validateCraft(content, inv, 'craft_metal_barrel', withBench).ok).toBe(true)
  })

  it('rejects when outputs cannot fit (accounting for freed input space)', () => {
    const inv = new Inventory(1, 1, content)
    inv.add('scrap_metal', 1) // craft_rope: 1 scrap -> 2 rope; slot frees up
    expect(validateCraft(content, inv, 'craft_rope', noStations).ok).toBe(true)
    const full = new Inventory(2, 1, content)
    full.add('scrap_metal', 1)
    full.add('wooden_crate', 4)
    // outputs fit in freed slot — ok
    expect(validateCraft(content, full, 'craft_rope', noStations).ok).toBe(true)
  })
})

describe('CraftQueue', () => {
  it('consumes inputs at start, grants outputs when due', () => {
    const inv = makeInv()
    inv.add('wood_plank', 4)
    inv.add('scrap_metal', 2)
    const queue = new CraftQueue()
    const started = queue.start(content, inv, 'craft_wooden_crate', noStations, 100, 30)
    expect(started.ok).toBe(true)
    expect(inv.countOf('wood_plank')).toBe(0)
    expect(inv.countOf('wooden_crate')).toBe(0)
    // 2s at 30tps = 60 ticks
    expect(queue.update(159, content, inv)).toHaveLength(0)
    const done = queue.update(160, content, inv)
    expect(done).toHaveLength(1)
    expect(inv.countOf('wooden_crate')).toBe(1)
    expect(queue.pending).toHaveLength(0)
  })

  it('holds completion until output space exists', () => {
    const inv = new Inventory(1, 1, content)
    inv.add('scrap_metal', 1)
    const queue = new CraftQueue()
    expect(queue.start(content, inv, 'craft_rope', noStations, 0, 30).ok).toBe(true)
    // Fill the freed slot so outputs can't fit at completion time.
    inv.add('wooden_crate', 4)
    expect(queue.update(1000, content, inv)).toHaveLength(0)
    expect(queue.pending).toHaveLength(1)
    // Free space; job then completes.
    inv.removeFromSlot(0, 4)
    expect(queue.update(1001, content, inv)).toHaveLength(1)
    expect(inv.countOf('rope')).toBe(2)
  })

  it('caps queued jobs', () => {
    const inv = makeInv()
    inv.add('scrap_metal', 50)
    const queue = new CraftQueue(2)
    expect(queue.start(content, inv, 'craft_rope', noStations, 0, 30).ok).toBe(true)
    expect(queue.start(content, inv, 'craft_rope', noStations, 0, 30).ok).toBe(true)
    expect(queue.start(content, inv, 'craft_rope', noStations, 0, 30)).toEqual({
      ok: false,
      error: 'queue_full',
    })
  })
})
