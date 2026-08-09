import type { PlayerDto, WorldEntityDto } from './dto.js'

/**
 * Repository boundary: gameplay/server code never touches SQL or the
 * database driver. Writes are designed to be batched — the server flushes
 * dirty entities periodically and on shutdown, not per mutation.
 */

export interface WorldEntityRepository {
  loadAll(): WorldEntityDto[]
  /** Transactional batch upsert. */
  upsertMany(entities: readonly WorldEntityDto[]): void
  deleteMany(ids: readonly string[]): void
}

export interface PlayerRepository {
  findByToken(token: string): PlayerDto | null
  upsert(player: PlayerDto): void
  upsertMany(players: readonly PlayerDto[]): void
}

export interface MetaRepository {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface PersistenceStore {
  readonly worldEntities: WorldEntityRepository
  readonly players: PlayerRepository
  readonly meta: MetaRepository
  close(): void
}
