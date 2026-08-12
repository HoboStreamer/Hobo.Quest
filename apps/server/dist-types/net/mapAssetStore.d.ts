/** Big enough for a detailed 4K texture or a scene model; not unbounded. */
export declare const MAX_ASSET_BYTES: number
export interface AssetKind {
  mime: string
  ext: string
}
/**
 * What these bytes actually are, or null.
 *
 * Deliberately does NOT consult the filename or a client-supplied type: an
 * uploader that can pick the stored extension can pick what the server will
 * later serve it as.
 */
export declare function sniffAsset(bytes: Buffer): AssetKind | null
export interface StoredAsset {
  /** `sha256-<hex>` — the content identity the map document references. */
  hash: string
  /** `/map-assets/<hash>.<ext>` */
  url: string
  bytes: number
  mime: string
}
export type StoreOutcome =
  | {
      ok: true
      asset: StoredAsset
      deduplicated: boolean
    }
  | {
      ok: false
      status: 400 | 413
      error: string
    }
export declare const hashOf: (bytes: Buffer) => string
/** The stored filename for a hash. Ids are server-generated; never client input. */
export declare const assetFileName: (hash: string, ext: string) => string
/**
 * Store `bytes` under their content hash. Returns the existing asset without
 * writing when the content is already present — the dedupe that lets an
 * unchanged paint mask be re-saved for free.
 */
export declare function storeAsset(assetsDir: string, bytes: Buffer): Promise<StoreOutcome>
/**
 * Whether a `/map-assets/<name>` request is for a content-addressed asset,
 * which is immutable and can therefore be cached forever.
 */
export declare const isContentAddressed: (name: string) => boolean
//# sourceMappingURL=mapAssetStore.d.ts.map
