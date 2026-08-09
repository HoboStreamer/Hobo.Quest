import Database from 'better-sqlite3'
import type { InventoryDto } from '@hobo/gameplay'
import type { PlayerDto, WorldEntityDto } from '../dto.js'
import type {
  MetaRepository,
  PersistenceStore,
  PlayerRepository,
  WorldEntityRepository,
} from '../repositories.js'

/**
 * SQLite implementation. Synchronous better-sqlite3 is intentional: batched
 * transactional writes from the flush system are microseconds-scale and far
 * simpler to reason about than async write queues. If profiling ever shows
 * flush stalls, batching moves to a worker behind the same repository
 * interface.
 */

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS world_entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  def_id TEXT NOT NULL,
  owner_id TEXT,
  pos_x REAL NOT NULL, pos_y REAL NOT NULL, pos_z REAL NOT NULL,
  rot_x REAL NOT NULL, rot_y REAL NOT NULL, rot_z REAL NOT NULL, rot_w REAL NOT NULL,
  motion TEXT NOT NULL,
  state TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pos_x REAL NOT NULL, pos_y REAL NOT NULL, pos_z REAL NOT NULL,
  yaw REAL NOT NULL,
  inventory TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

interface WorldEntityRow {
  id: string
  kind: string
  def_id: string
  owner_id: string | null
  pos_x: number
  pos_y: number
  pos_z: number
  rot_x: number
  rot_y: number
  rot_z: number
  rot_w: number
  motion: string
  state: string | null
  updated_at: number
}

interface PlayerRow {
  id: string
  token: string
  name: string
  pos_x: number
  pos_y: number
  pos_z: number
  yaw: number
  inventory: string
  updated_at: number
}

export function openSqliteStore(path: string): PersistenceStore {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(SCHEMA)

  const metaGet = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
  const metaSet = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )

  const existingVersion = metaGet.get('schema_version')?.value
  if (existingVersion === undefined) {
    metaSet.run('schema_version', String(SCHEMA_VERSION))
  } else if (Number(existingVersion) !== SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${existingVersion} != expected ${SCHEMA_VERSION}; migration required`,
    )
  }

  const upsertEntity = db.prepare(`
    INSERT INTO world_entities (id, kind, def_id, owner_id, pos_x, pos_y, pos_z, rot_x, rot_y, rot_z, rot_w, motion, state, updated_at)
    VALUES (@id, @kind, @def_id, @owner_id, @pos_x, @pos_y, @pos_z, @rot_x, @rot_y, @rot_z, @rot_w, @motion, @state, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      pos_x=excluded.pos_x, pos_y=excluded.pos_y, pos_z=excluded.pos_z,
      rot_x=excluded.rot_x, rot_y=excluded.rot_y, rot_z=excluded.rot_z, rot_w=excluded.rot_w,
      motion=excluded.motion, state=excluded.state, owner_id=excluded.owner_id, updated_at=excluded.updated_at
  `)
  const deleteEntity = db.prepare('DELETE FROM world_entities WHERE id = ?')
  const selectEntities = db.prepare<[], WorldEntityRow>('SELECT * FROM world_entities')

  const worldEntities: WorldEntityRepository = {
    loadAll(): WorldEntityDto[] {
      return selectEntities.all().map((row) => ({
        id: row.id,
        kind: row.kind as WorldEntityDto['kind'],
        defId: row.def_id,
        ownerId: row.owner_id,
        pos: [row.pos_x, row.pos_y, row.pos_z],
        rot: [row.rot_x, row.rot_y, row.rot_z, row.rot_w],
        motion: row.motion as WorldEntityDto['motion'],
        state: row.state ? (JSON.parse(row.state) as WorldEntityDto['state']) : null,
        updatedAt: row.updated_at,
      }))
    },
    upsertMany: db.transaction((entities: readonly WorldEntityDto[]) => {
      for (const e of entities) {
        upsertEntity.run({
          id: e.id,
          kind: e.kind,
          def_id: e.defId,
          owner_id: e.ownerId,
          pos_x: e.pos[0],
          pos_y: e.pos[1],
          pos_z: e.pos[2],
          rot_x: e.rot[0],
          rot_y: e.rot[1],
          rot_z: e.rot[2],
          rot_w: e.rot[3],
          motion: e.motion,
          state: e.state ? JSON.stringify(e.state) : null,
          updated_at: e.updatedAt,
        })
      }
    }) as (entities: readonly WorldEntityDto[]) => void,
    deleteMany: db.transaction((ids: readonly string[]) => {
      for (const id of ids) deleteEntity.run(id)
    }) as (ids: readonly string[]) => void,
  }

  const upsertPlayer = db.prepare(`
    INSERT INTO players (id, token, name, pos_x, pos_y, pos_z, yaw, inventory, updated_at)
    VALUES (@id, @token, @name, @pos_x, @pos_y, @pos_z, @yaw, @inventory, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, pos_x=excluded.pos_x, pos_y=excluded.pos_y, pos_z=excluded.pos_z,
      yaw=excluded.yaw, inventory=excluded.inventory, updated_at=excluded.updated_at
  `)
  const selectPlayerByToken = db.prepare<[string], PlayerRow>(
    'SELECT * FROM players WHERE token = ?',
  )

  const rowToPlayer = (row: PlayerRow): PlayerDto => ({
    id: row.id,
    token: row.token,
    name: row.name,
    pos: [row.pos_x, row.pos_y, row.pos_z],
    yaw: row.yaw,
    inventory: JSON.parse(row.inventory) as InventoryDto,
    updatedAt: row.updated_at,
  })

  const playerToRow = (p: PlayerDto) => ({
    id: p.id,
    token: p.token,
    name: p.name,
    pos_x: p.pos[0],
    pos_y: p.pos[1],
    pos_z: p.pos[2],
    yaw: p.yaw,
    inventory: JSON.stringify(p.inventory),
    updated_at: p.updatedAt,
  })

  const players: PlayerRepository = {
    findByToken(token: string): PlayerDto | null {
      const row = selectPlayerByToken.get(token)
      return row ? rowToPlayer(row) : null
    },
    upsert(player: PlayerDto): void {
      upsertPlayer.run(playerToRow(player))
    },
    upsertMany: db.transaction((list: readonly PlayerDto[]) => {
      for (const p of list) upsertPlayer.run(playerToRow(p))
    }) as (list: readonly PlayerDto[]) => void,
  }

  const meta: MetaRepository = {
    get(key: string): string | null {
      return metaGet.get(key)?.value ?? null
    },
    set(key: string, value: string): void {
      metaSet.run(key, value)
    },
  }

  return {
    worldEntities,
    players,
    meta,
    close(): void {
      db.close()
    },
  }
}
