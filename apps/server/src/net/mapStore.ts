/**
 * The map artifact's read/write pipeline.
 *
 * The previous save handler did `JSON.parse(body)` followed by
 * `writeFileSync(mapPath, body)`: no schema validation, no migration, no
 * revision check, no atomicity. A malformed or stale save could corrupt the
 * live world, and two admins saving at once silently clobbered each other —
 * "revisions" were a string of array lengths compared on the client.
 *
 * Now every save is: authenticate → size-limit → parse → migrate → validate →
 * revision check → canonicalise → atomic write → apply live → broadcast.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalizeMapFile, emptyMapV2, parseMapFile, type MapFileV2 } from '@hobo/content'

export interface MapRecord {
  map: MapFileV2
  /** SHA-256 of the canonical form — the ETag clients send back as If-Match. */
  revision: string
  canonical: string
}

export type SaveOutcome =
  | { status: 200; record: MapRecord }
  | { status: 400 | 409 | 413 | 422; error: string; issues?: string[]; revision?: string }

/** 24 MB of JSON is far more than any real map; refuse rather than buffer it. */
export const MAX_MAP_BYTES = 24 * 1024 * 1024

export function revisionOf(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

function record(map: MapFileV2): MapRecord {
  // The stored revision is derived from the map WITHOUT its own revision
  // field, or the hash would depend on itself.
  const bare: MapFileV2 = { ...map }
  delete (bare as { revision?: string }).revision
  const canonical = canonicalizeMapFile(bare)
  const revision = revisionOf(canonical)
  return { map: { ...bare, revision }, revision, canonical }
}

/**
 * Load the artifact, migrating v1 on the way in. A missing or unreadable file
 * yields an empty v2 map rather than throwing — a fresh server should boot to
 * a blank world, not fail.
 */
export async function loadMap(mapPath: string): Promise<MapRecord> {
  if (!existsSync(mapPath)) return record(emptyMapV2())
  try {
    const raw = JSON.parse(await readFile(mapPath, 'utf8')) as unknown
    const parsed = parseMapFile(raw)
    if (!parsed.ok) return record(emptyMapV2())
    return record(parsed.map)
  } catch {
    return record(emptyMapV2())
  }
}

/**
 * Validate and persist a save. `ifMatch` is the revision the editor last
 * loaded; a mismatch is a 409 so the client can show a conflict instead of
 * overwriting someone else's work.
 */
export async function saveMap(
  mapPath: string,
  body: string,
  current: MapRecord,
  ifMatch: string | undefined,
): Promise<SaveOutcome> {
  if (body.length > MAX_MAP_BYTES) return { status: 413, error: 'map_too_large' }

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return { status: 400, error: 'invalid_json' }
  }

  const parsed = parseMapFile(raw)
  if (!parsed.ok) return { status: 422, error: 'invalid_map', issues: parsed.issues }

  // A client that never read a revision (first save, older build) is allowed
  // through; one that read a STALE revision is not.
  if (ifMatch && ifMatch !== current.revision)
    return { status: 409, error: 'stale_revision', revision: current.revision }

  const next = record(parsed.map)
  // Unchanged content is a no-op ONLY if the artifact is already on disk —
  // the first save of an empty map must still create the file.
  if (next.revision === current.revision && existsSync(mapPath))
    return { status: 200, record: current }

  await mkdir(dirname(mapPath), { recursive: true })
  // Temp + rename: a crash mid-write can never leave a half-written map.
  const tmp = join(dirname(mapPath), `.map.${process.pid}.${Date.now().toString(36)}.tmp`)
  await writeFile(tmp, JSON.stringify(next.map), 'utf8')
  await rename(tmp, mapPath)
  return { status: 200, record: next }
}
