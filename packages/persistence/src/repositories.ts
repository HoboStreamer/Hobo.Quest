import type { ConstraintDto, PlayerDto, WorldEntityDto } from './dto.js'

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
  /** Bulk removal used on world-definition changes (e.g. all resource nodes). */
  deleteByKind(kind: string): void
}

export interface PlayerRepository {
  findByToken(token: string): PlayerDto | null
  /** All characters under an account token (max 3, ordered by slot). */
  listByToken(token: string): PlayerDto[]
  findByTokenSlot(token: string, slot: number): PlayerDto | null
  /** Offline lookups (prop protection checks owners who are not connected). */
  findById(id: string): PlayerDto | null
  upsert(player: PlayerDto): void
  upsertMany(players: readonly PlayerDto[]): void
  /** World-change safety: move every player to the given spawn. */
  resetAllPositions(pos: [number, number, number], yaw: number): void
}

export interface GuestRepository {
  /** Resolve a guest connection (ip + browser token) to its canonical account token. */
  resolve(ip: string, token: string): string
}

export interface ConstraintRepository {
  loadAll(): ConstraintDto[]
  upsertMany(constraints: readonly ConstraintDto[]): void
  deleteMany(ids: readonly string[]): void
}

export interface MetaRepository {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface PersistenceStore {
  readonly worldEntities: WorldEntityRepository
  readonly players: PlayerRepository
  guests: GuestRepository
  readonly constraints: ConstraintRepository
  readonly meta: MetaRepository
  close(): void
}
