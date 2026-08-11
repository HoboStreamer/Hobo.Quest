import { type MapFile, type MapFileV2 } from '@hobo/content'
export interface MapRecord {
  map: MapFileV2
  /** v1 projection for consumers that have not migrated yet. */
  wire: MapFile
  /** SHA-256 of the canonical form — the ETag clients send back as If-Match. */
  revision: string
  canonical: string
}
export type SaveOutcome =
  | {
      status: 200
      record: MapRecord
    }
  | {
      status: 400 | 409 | 413 | 422
      error: string
      issues?: string[]
      revision?: string
    }
/** 24 MB of JSON is far more than any real map; refuse rather than buffer it. */
export declare const MAX_MAP_BYTES: number
export declare function revisionOf(canonical: string): string
/**
 * Load the artifact, migrating v1 on the way in. A missing or unreadable file
 * yields an empty v2 map rather than throwing — a fresh server should boot to
 * a blank world, not fail.
 */
export declare function loadMap(mapPath: string): Promise<MapRecord>
/**
 * Validate and persist a save. `ifMatch` is the revision the editor last
 * loaded; a mismatch is a 409 so the client can show a conflict instead of
 * overwriting someone else's work.
 */
export declare function saveMap(
  mapPath: string,
  body: string,
  current: MapRecord,
  ifMatch: string | undefined,
): Promise<SaveOutcome>
//# sourceMappingURL=mapStore.d.ts.map
