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
      skills: { woodcutting: 120, mining: 40 },
      friends: ['p2', 'p3'],
      stats: { health: 90, hunger: 80, thirst: 70, stamina: 100 },
      appearance: {
        body: 'female',
        skin: 3,
        hairStyle: 'bun',
        hairColor: 2,
        facialHair: 'none',
        top: 1,
        bottom: 2,
        shoes: 3,
        height: 1.02,
        build: 0.95,
      },
      updatedAt: 2000,
    }
    store.players.upsert(player)
    expect(store.players.findByToken('tok_12345678')).toEqual(player)
    expect(store.players.findByToken('nope')).toBeNull()
    store.close()
  })

  it('roundtrips constraints', () => {
    const store = openSqliteStore(':memory:')
    store.worldEntities.upsertMany([makeEntity('a'), makeEntity('b')])
    store.constraints.upsertMany([
      { id: 'c1', type: 'weld', entityA: 'a', entityB: 'b', updatedAt: 100 },
    ])
    expect(store.constraints.loadAll()).toEqual([
      { id: 'c1', type: 'weld', entityA: 'a', entityB: 'b', updatedAt: 100 },
    ])
    store.constraints.deleteMany(['c1'])
    expect(store.constraints.loadAll()).toEqual([])
    store.close()
  })

  it('migrates a v1 database to the current schema', async () => {
    const { default: Database } = await import('better-sqlite3')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'hobo-migrate-'))
    const path = join(dir, 'v1.db')

    // Build a genuine v1 database (no skills column, no constraints table).
    const v1 = new Database(path)
    v1.exec(`
      CREATE TABLE world_entities (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, def_id TEXT NOT NULL, owner_id TEXT,
        pos_x REAL NOT NULL, pos_y REAL NOT NULL, pos_z REAL NOT NULL,
        rot_x REAL NOT NULL, rot_y REAL NOT NULL, rot_z REAL NOT NULL, rot_w REAL NOT NULL,
        motion TEXT NOT NULL, state TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE players (
        id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        pos_x REAL NOT NULL, pos_y REAL NOT NULL, pos_z REAL NOT NULL, yaw REAL NOT NULL,
        inventory TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      INSERT INTO players VALUES ('p1', 'tok_11111111', 'Old Hobo', 1, 2, 3, 0.5,
        '{"size":24,"hotbar":6,"slots":[]}', 999);
    `)
    v1.close()

    const store = openSqliteStore(path)
    const player = store.players.findByToken('tok_11111111')
    expect(player?.name).toBe('Old Hobo')
    expect(player?.skills).toEqual({})
    expect(player?.friends).toEqual([])
    expect(player?.appearance).toBeNull()
    // constraints table exists and works post-migration
    store.constraints.upsertMany([
      { id: 'c1', type: 'weld', entityA: 'x', entityB: 'y', updatedAt: 1 },
    ])
    expect(store.constraints.loadAll()).toHaveLength(1)
    expect(store.meta.get('schema_version')).toBe('5')
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
