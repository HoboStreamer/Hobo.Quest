/**
 * Content-addressed store for map assets (textures, paint masks, models).
 *
 * What it replaces: `POST /api/texture` named uploads
 * `tex-<timestamp>-<random>.<ext>`, took the extension from a query
 * parameter, and wrote them with `writeFileSync` on the request thread.
 * So the same texture uploaded twice cost twice the disk and produced two
 * unrelated URLs that no map could ever be shown to share; a client could
 * claim `ext=png` for arbitrary bytes; and a slow disk blocked the event loop
 * for every other player on the server.
 *
 * Here the NAME IS THE CONTENT: sha256 of the actual bytes, with the
 * extension decided by sniffing those bytes rather than believing the client.
 * Identical uploads collapse to one file and one URL for free, which is what
 * makes "save the map again without touching the paint mask" cost nothing.
 * Files are immutable, so they can be served with a permanent cache header.
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Big enough for a detailed 4K texture or a scene model; not unbounded. */
export const MAX_ASSET_BYTES = 48 * 1024 * 1024

export interface AssetKind {
  mime: string
  ext: string
}

/** Every type the editor may upload. Anything else is refused. */
const SIGNATURES: { kind: AssetKind; match: (b: Buffer) => boolean }[] = [
  {
    kind: { mime: 'image/png', ext: 'png' },
    match: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    kind: { mime: 'image/jpeg', ext: 'jpg' },
    match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    kind: { mime: 'image/webp', ext: 'webp' },
    match: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    // glTF binary container: magic 'glTF', then a uint32 version.
    kind: { mime: 'model/gltf-binary', ext: 'glb' },
    match: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'glTF',
  },
]

/**
 * What these bytes actually are, or null.
 *
 * Deliberately does NOT consult the filename or a client-supplied type: an
 * uploader that can pick the stored extension can pick what the server will
 * later serve it as.
 */
export function sniffAsset(bytes: Buffer): AssetKind | null {
  return SIGNATURES.find((s) => s.match(bytes))?.kind ?? null
}

export interface StoredAsset {
  /** `sha256-<hex>` — the content identity the map document references. */
  hash: string
  /** `/map-assets/<hash>.<ext>` */
  url: string
  bytes: number
  mime: string
}

export type StoreOutcome =
  | { ok: true; asset: StoredAsset; deduplicated: boolean }
  | { ok: false; status: 400 | 413; error: string }

export const hashOf = (bytes: Buffer): string =>
  `sha256-${createHash('sha256').update(bytes).digest('hex')}`

/** The stored filename for a hash. Ids are server-generated; never client input. */
export const assetFileName = (hash: string, ext: string): string => `${hash}.${ext}`

/**
 * Store `bytes` under their content hash. Returns the existing asset without
 * writing when the content is already present — the dedupe that lets an
 * unchanged paint mask be re-saved for free.
 */
export async function storeAsset(assetsDir: string, bytes: Buffer): Promise<StoreOutcome> {
  if (bytes.length === 0) return { ok: false, status: 400, error: 'empty' }
  if (bytes.length > MAX_ASSET_BYTES) return { ok: false, status: 413, error: 'too_large' }

  const kind = sniffAsset(bytes)
  if (!kind) return { ok: false, status: 400, error: 'unsupported_type' }

  const hash = hashOf(bytes)
  const name = assetFileName(hash, kind.ext)
  const asset: StoredAsset = {
    hash,
    url: `/map-assets/${name}`,
    bytes: bytes.length,
    mime: kind.mime,
  }

  const full = join(assetsDir, name)
  if (await exists(full)) return { ok: true, asset, deduplicated: true }

  await mkdir(assetsDir, { recursive: true })
  // Temp + rename: a reader can never observe a half-written asset, and two
  // concurrent uploads of the same content cannot interleave into one file.
  const tmp = join(assetsDir, `.${hash}.${process.pid}.${counter++}.tmp`)
  await writeFile(tmp, bytes)
  await rename(tmp, full)
  return { ok: true, asset, deduplicated: false }
}

let counter = 0

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Whether a `/map-assets/<name>` request is for a content-addressed asset,
 * which is immutable and can therefore be cached forever.
 */
export const isContentAddressed = (name: string): boolean =>
  /^sha256-[0-9a-f]{64}\.[a-z0-9]+$/.test(name)
