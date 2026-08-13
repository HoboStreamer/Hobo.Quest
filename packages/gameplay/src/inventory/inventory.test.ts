import { describe, expect, it } from 'vitest'
import { createContent } from '@hobo/content'
import { Inventory } from './inventory.js'

const content = createContent()

function makeInv(size = 12, hotbar = 4): Inventory {
  return new Inventory(size, hotbar, content)
}

describe('Inventory', () => {
  it('adds items and fills existing stacks first', () => {
    const inv = makeInv()
    expect(inv.add('wood_plank', 30)).toBe(0)
    expect(inv.get(0)?.count).toBe(30)
    expect(inv.add('wood_plank', 30)).toBe(0)
    // maxStack 50: first stack tops to 50, remainder starts a new stack
    expect(inv.get(0)?.count).toBe(50)
    expect(inv.get(1)?.count).toBe(10)
  })

  it('returns leftover when full', () => {
    const inv = makeInv(2, 1)
    expect(inv.add('wood_plank', 120)).toBe(20)
    expect(inv.countOf('wood_plank')).toBe(100)
  })

  it('respects maxStack for low-stack items', () => {
    const inv = makeInv()
    expect(inv.add('wooden_crate', 6)).toBe(0)
    expect(inv.get(0)?.count).toBe(4)
    expect(inv.get(1)?.count).toBe(2)
  })

  it('moves stacks to empty slots and swaps non-mergeable', () => {
    const inv = makeInv()
    inv.add('wood_plank', 10)
    inv.add('scrap_metal', 5)
    expect(inv.move(0, 5).ok).toBe(true)
    expect(inv.get(0)).toBeNull()
    expect(inv.get(5)?.defId).toBe('wood_plank')
    // swap
    expect(inv.move(5, 1).ok).toBe(true)
    expect(inv.get(5)?.defId).toBe('scrap_metal')
    expect(inv.get(1)?.defId).toBe('wood_plank')
  })

  it('merges stacks up to maxStack on move', () => {
    const inv = makeInv()
    inv.add('wood_plank', 50)
    inv.move(0, 1, 20) // split 20 into slot 1
    expect(inv.get(0)?.count).toBe(30)
    expect(inv.get(1)?.count).toBe(20)
    expect(inv.move(1, 0).ok).toBe(true)
    expect(inv.get(0)?.count).toBe(50)
    expect(inv.get(1)).toBeNull()
  })

  it('splits stacks with count', () => {
    const inv = makeInv()
    inv.add('scrap_metal', 20)
    expect(inv.move(0, 3, 7).ok).toBe(true)
    expect(inv.get(0)?.count).toBe(13)
    expect(inv.get(3)?.count).toBe(7)
    expect(inv.move(0, 3, 999).ok).toBe(false)
  })

  it('consumes atomically across slots', () => {
    const inv = makeInv()
    inv.add('wood_plank', 50)
    inv.move(0, 1, 10)
    expect(inv.consume([{ item: 'wood_plank', count: 55 }]).ok).toBe(false)
    expect(inv.countOf('wood_plank')).toBe(50)
    expect(inv.consume([{ item: 'wood_plank', count: 45 }]).ok).toBe(true)
    expect(inv.countOf('wood_plank')).toBe(5)
  })

  it('canFit accounts for partial stacks', () => {
    const inv = makeInv(1, 1)
    inv.add('wood_plank', 45)
    expect(inv.canFit('wood_plank', 5)).toBe(true)
    expect(inv.canFit('wood_plank', 6)).toBe(false)
    expect(inv.canFit('scrap_metal', 1)).toBe(false)
  })

  it('serializes and restores via DTO', () => {
    const inv = makeInv()
    inv.add('wood_plank', 60)
    inv.add('wooden_crate', 2)
    const dto = inv.toDto()
    const restored = Inventory.fromDto(dto, content)
    expect(restored.toDto()).toEqual(dto)
    expect(restored.countOf('wood_plank')).toBe(60)
  })

  it('partitions unsecured valuables for the death drop', () => {
    const inv = new Inventory(6, 2, content)
    inv.add('wood_plank', 5)
    inv.addStack({ defId: 'salvage_core', count: 2 })
    inv.addStack({ defId: 'salvage_core', count: 1, meta: { secured: 1 } })
    const isValuable = (id: string) => id === 'salvage_core'
    const dropped = inv.takeUnsecuredValuables(isValuable)
    expect(dropped).toEqual([{ defId: 'salvage_core', count: 2 }])
    expect(inv.countOf('salvage_core')).toBe(1) // the secured stack stays
    expect(inv.countOf('wood_plank')).toBe(5)
  })

  it('secures valuables exactly once', () => {
    const inv = new Inventory(6, 2, content)
    inv.addStack({ defId: 'salvage_core', count: 2 })
    const isValuable = (id: string) => id === 'salvage_core'
    expect(inv.secureValuables(isValuable)).toBe(1)
    expect(inv.secureValuables(isValuable)).toBe(0)
    expect(inv.takeUnsecuredValuables(isValuable)).toEqual([])
  })
})
