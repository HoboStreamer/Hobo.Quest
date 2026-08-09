import { describe, expect, it } from 'vitest'
import type { PlayerDto, WorldEntityDto } from '../dto.js'
import { openSqliteStore } from './sqliteStore.js'

function makeEntity(id: string): WorldEntityDto {
  return {
    id,
    kind: 'prop',
    defId: 'wooden_crate',
    ownerId: 'player1',
    pos: [1, 2, 3],
    rot: [0, 0, 0, 1],
    motion: 'dynamic',
    state: null,
    updatedAt: 1000,
  }
}

describe('sqlite store', () => {
  it('roundtrips world entities with batch upsert', () => {
    const store = openSqliteStore(':memory:')
    store.worldEntities.upsertMany([makeEntity('a'), makeEntity('b')])
    const loaded = store.worldEntities.loadAll()
    expect(loaded).toHaveLength(2)
    expect(loaded.find((e) => e.id === 'a')).toEqual(makeEntity('a'))

    // update in place
    const moved = {
      ...makeEntity('a'),
      pos: [9, 9, 9] as [number, number, number],
      motion: 'frozen' as const,
    }
    store.worldEntities.upsertMany([moved])
    expect(store.worldEntities.loadAll().find((e) => e.id === 'a')).toEqual(moved)

    store.worldEntities.deleteMany(['a'])
    expect(store.worldEntities.loadAll()).toHaveLength(1)
    store.close()
  })

  it('roundtrips players by token including inventory json', () => {
    const store = openSqliteStore(':memory:')
    const player: PlayerDto = {
      id: 'p1',
      token: 'tok_12345678',
      name: 'Hobo',
      pos: [0, 1, 0],
      yaw: 1.5,
      inventory: {
        size: 24,
        hotbar: 6,
        slots: [{ i: 0, stack: { defId: 'wood_plank', count: 10 } }],
      },
      updatedAt: 2000,
    }
    store.players.upsert(player)
    expect(store.players.findByToken('tok_12345678')).toEqual(player)
    expect(store.players.findByToken('nope')).toBeNull()
    store.close()
  })

  it('persists resource state json', () => {
    const store = openSqliteStore(':memory:')
    const node: WorldEntityDto = {
      ...makeEntity('r1'),
      kind: 'resource',
      defId: 'scrap_metal',
      motion: 'static',
      state: { remaining: 12, perUse: 2 },
    }
    store.worldEntities.upsertMany([node])
    expect(store.worldEntities.loadAll()[0]?.state).toEqual({ remaining: 12, perUse: 2 })
    store.close()
  })
})
