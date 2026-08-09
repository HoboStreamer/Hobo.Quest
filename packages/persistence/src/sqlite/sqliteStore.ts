import Database from 'better-sqlite3'
import type { InventoryDto, SkillsDto } from '@hobo/gameplay'
import type { ConstraintDto, PlayerDto, WorldEntityDto } from '../dto.js'
import type {
  ConstraintRepository,
  MetaRepository,
  PersistenceStore,
  PlayerRepository,
  WorldEntityRepository,
} from '../repositories.js'

/**
 * SQLite implementation. Synchronous better-sqlite3 is intentional: batched
 * transactional writes from the flush system are microseconds-scale and far
 * simpler to reason about than async write queues.
 *
 * Schema changes are forward-only migrations keyed off meta.schema_version;
 * a database is upgraded step by step inside a transaction per step.
 */

const SCHEMA_VERSION = 4

const BASE_SCHEMA = `
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
  skills TEXT NOT NULL DEFAULT '{}',
  friends TEXT NOT NULL DEFAULT '[]',
  appearance TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS constraints (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  entity_a TEXT NOT NULL,
  entity_b TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** Migration from version N applies index N-1. Each runs in a transaction. */
const MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  1: (db) => {
    db.exec(`
      ALTER TABLE players ADD COLUMN skills TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS constraints (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        entity_a TEXT NOT NULL,
        entity_b TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  },
  2: (db) => {
    db.exec("ALTER TABLE players ADD COLUMN friends TEXT NOT NULL DEFAULT '[]';")
  },
  3: (db) => {
    db.exec('ALTER TABLE players ADD COLUMN appearance TEXT;')
  },
}

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
  skills: string
  friends: string
  appearance: string | null
  updated_at: number
}

interface ConstraintRow {
  id: string
  type: string
  entity_a: string
  entity_b: string
  updated_at: number
}

export function openSqliteStore(path: string): PersistenceStore {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get()
  if (!hasMeta) {
    // Fresh database: create the full current schema.
    db.exec(BASE_SCHEMA)
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    )
  } else {
    let version = Number(
      (
        db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
          { value: string } | undefined
      )?.value ?? '1',
    )
    if (version > SCHEMA_VERSION) {
      throw new Error(`database schema ${version} is newer than this build (${SCHEMA_VERSION})`)
    }
    while (version < SCHEMA_VERSION) {
      const migrate = MIGRATIONS[version]
      if (!migrate) throw new Error(`missing migration from schema version ${version}`)
      db.transaction(() => {
        migrate(db)
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
          'schema_version',
          String(version + 1),
        )
      })()
      version++
    }
  }

  const metaGet = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
  const metaSet = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )

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
    deleteByKind(kind: string): void {
      db.prepare('DELETE FROM world_entities WHERE kind = ?').run(kind)
    },
  }

  const upsertPlayer = db.prepare(`
    INSERT INTO players (id, token, name, pos_x, pos_y, pos_z, yaw, inventory, skills, friends, appearance, updated_at)
    VALUES (@id, @token, @name, @pos_x, @pos_y, @pos_z, @yaw, @inventory, @skills, @friends, @appearance, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, pos_x=excluded.pos_x, pos_y=excluded.pos_y, pos_z=excluded.pos_z,
      yaw=excluded.yaw, inventory=excluded.inventory, skills=excluded.skills, friends=excluded.friends, appearance=excluded.appearance, updated_at=excluded.updated_at
  `)
  const selectPlayerByToken = db.prepare<[string], PlayerRow>(
    'SELECT * FROM players WHERE token = ?',
  )
  const selectPlayerById = db.prepare<[string], PlayerRow>('SELECT * FROM players WHERE id = ?')

  const rowToPlayer = (row: PlayerRow): PlayerDto => ({
    id: row.id,
    token: row.token,
    name: row.name,
    pos: [row.pos_x, row.pos_y, row.pos_z],
    yaw: row.yaw,
    inventory: JSON.parse(row.inventory) as InventoryDto,
    skills: JSON.parse(row.skills || '{}') as SkillsDto,
    friends: JSON.parse(row.friends || '[]') as string[],
    appearance: row.appearance ? (JSON.parse(row.appearance) as PlayerDto['appearance']) : null,
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
    skills: JSON.stringify(p.skills),
    friends: JSON.stringify(p.friends),
    appearance: p.appearance ? JSON.stringify(p.appearance) : null,
    updated_at: p.updatedAt,
  })

  const players: PlayerRepository = {
    findByToken(token: string): PlayerDto | null {
      const row = selectPlayerByToken.get(token)
      return row ? rowToPlayer(row) : null
    },
    findById(id: string): PlayerDto | null {
      const row = selectPlayerById.get(id)
      return row ? rowToPlayer(row) : null
    },
    upsert(player: PlayerDto): void {
      upsertPlayer.run(playerToRow(player))
    },
    upsertMany: db.transaction((list: readonly PlayerDto[]) => {
      for (const p of list) upsertPlayer.run(playerToRow(p))
    }) as (list: readonly PlayerDto[]) => void,
    resetAllPositions(pos: [number, number, number], yaw: number): void {
      db.prepare('UPDATE players SET pos_x = ?, pos_y = ?, pos_z = ?, yaw = ?').run(
        pos[0],
        pos[1],
        pos[2],
        yaw,
      )
    },
  }

  const upsertConstraint = db.prepare(`
    INSERT INTO constraints (id, type, entity_a, entity_b, updated_at)
    VALUES (@id, @type, @entity_a, @entity_b, @updated_at)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
  `)
  const deleteConstraint = db.prepare('DELETE FROM constraints WHERE id = ?')
  const selectConstraints = db.prepare<[], ConstraintRow>('SELECT * FROM constraints')

  const constraints: ConstraintRepository = {
    loadAll(): ConstraintDto[] {
      return selectConstraints.all().map((row) => ({
        id: row.id,
        type: row.type as ConstraintDto['type'],
        entityA: row.entity_a,
        entityB: row.entity_b,
        updatedAt: row.updated_at,
      }))
    },
    upsertMany: db.transaction((list: readonly ConstraintDto[]) => {
      for (const c of list) {
        upsertConstraint.run({
          id: c.id,
          type: c.type,
          entity_a: c.entityA,
          entity_b: c.entityB,
          updated_at: c.updatedAt,
        })
      }
    }) as (list: readonly ConstraintDto[]) => void,
    deleteMany: db.transaction((ids: readonly string[]) => {
      for (const id of ids) deleteConstraint.run(id)
    }) as (ids: readonly string[]) => void,
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
    constraints,
    meta,
    close(): void {
      db.close()
    },
  }
}
