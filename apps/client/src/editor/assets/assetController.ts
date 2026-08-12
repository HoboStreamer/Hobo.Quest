/**
 * Importing, renaming and removing map assets.
 *
 * The map's model and texture METADATA lives in `EditorDocument` like every
 * other part of the wire; this is the code that mutates it, always through
 * `CommandHistory` so an import or a rename is undoable like anything else.
 * Loaded Babylon textures and parsed `AssetContainer`s are a transient cache
 * (see `ModelCache`) and deliberately not a second copy of the metadata.
 *
 * Bytes go to the content-addressed store, so the same texture imported twice
 * is one blob and one URL. Nothing is ever embedded as base64 any more: a map
 * that inlines every asset grows without bound and re-ships identical bytes on
 * every save.
 */
import type { MapModelV2, MapTextureEntry } from '@hobo/content'
import type { EditorDocument } from '../document/editorDocument.js'
import type { CommandHistory } from '../history/commandHistory.js'
import { newId } from '../catalog.js'
import type { ModelCache } from '../../render/modelCache.js'

export interface UploadedAsset {
  url: string
  hash: string
  bytes: number
  mime: string
}

export interface AssetControllerOptions {
  doc: EditorDocument
  history: CommandHistory<EditorDocument>
  modelCache: ModelCache
  editorKey: () => string
  /** Re-register custom textures with the renderer after a change. */
  onAssetsChanged: () => void
  setMessage: (m: string) => void
}

/** Where a texture reference can appear in the document. */
export interface TextureUsage {
  count: number
  ids: string[]
}

const CUSTOM = 'custom:'

/**
 * Every place a texture reference lives.
 *
 * The previous scan looked at terrain surfaces and `static.tex` only, so a
 * texture used exclusively by a painted box face or a per-face override
 * counted as unused — and "delete is refused while referenced" is worthless
 * if the reference count is wrong.
 */
export function collectTextureUsage(doc: EditorDocument): Map<string, TextureUsage> {
  const out = new Map<string, TextureUsage>()
  const note = (ref: string | undefined, id: string): void => {
    // 'none' is the plain-colour sentinel, not an asset.
    if (!ref || ref === 'none') return
    const entry = out.get(ref) ?? { count: 0, ids: [] }
    entry.count++
    if (!entry.ids.includes(id)) entry.ids.push(id)
    out.set(ref, entry)
  }
  const noteSurface = (surface: unknown, id: string): void => {
    const s = surface as
      { base?: { tex?: string }; paint?: { layers?: { tex?: string }[] } } | undefined
    if (!s) return
    note(s.base?.tex, id)
    for (const layer of s.paint?.layers ?? []) note(layer.tex, id)
  }

  for (const t of doc.listByKind('terrain')) noteSurface(t.surface, t.id)
  for (const s of doc.listByKind('static')) {
    const any = s as unknown as {
      tex?: string
      uv?: { tex?: string }
      faces?: Record<string, { tex?: string }>
      surface?: unknown
      surfaces?: Record<string, unknown>
    }
    note(any.tex, s.id)
    note(any.uv?.tex, s.id)
    for (const face of Object.values(any.faces ?? {})) note(face.tex, s.id)
    noteSurface(any.surface, s.id)
    for (const surface of Object.values(any.surfaces ?? {})) noteSurface(surface, s.id)
  }
  return out
}

export function collectModelUsage(doc: EditorDocument): Map<string, TextureUsage> {
  const out = new Map<string, TextureUsage>()
  for (const s of doc.listByKind('static')) {
    const model = (s as { model?: string }).model
    if (!model) continue
    const entry = out.get(model) ?? { count: 0, ids: [] }
    entry.count++
    entry.ids.push(s.id)
    out.set(model, entry)
  }
  return out
}

/** A filesystem-ish, collision-free texture name. */
export function sanitizeTextureName(raw: string, taken: (name: string) => boolean): string {
  const base =
    raw
      .replace(/\.[a-z0-9]+$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'texture'
  let name = base
  for (let n = 2; taken(name); n++) name = `${base}_${n}`
  return name
}

export class AssetController {
  constructor(private readonly opts: AssetControllerOptions) {}

  /** POST raw bytes to the content-addressed store. */
  private async upload(blob: Blob): Promise<UploadedAsset | 'forbidden' | null> {
    try {
      const resp = await fetch('/api/map-assets', {
        method: 'POST',
        headers: { 'x-editor-key': this.opts.editorKey() },
        body: blob,
      })
      if (resp.status === 403) return 'forbidden'
      if (!resp.ok) return null
      return (await resp.json()) as UploadedAsset
    } catch {
      return null
    }
  }

  textureUsage(): Map<string, TextureUsage> {
    return collectTextureUsage(this.opts.doc)
  }

  modelUsage(): Map<string, TextureUsage> {
    return collectModelUsage(this.opts.doc)
  }

  // ── Import ──────────────────────────────────────────────────────────

  async importTexture(file: File): Promise<string | null> {
    const { doc, history, setMessage } = this.opts
    setMessage('🖼 uploading texture…')
    const uploaded = await this.upload(file)
    if (uploaded === 'forbidden') {
      setMessage('⛔ import needs your admin token (top right)')
      return null
    }
    if (!uploaded) {
      setMessage('⛔ upload failed — check the connection and try again')
      return null
    }
    const name = sanitizeTextureName(file.name, (n) => doc.textureByName(n) !== null)
    const entry: MapTextureEntry = { name, url: uploaded.url, scale: 2 }
    history.apply({
      label: `import texture ${name}`,
      execute: (d) => d.addTextureAsset(entry),
      undo: (d) => d.removeTextureAsset(name),
    })
    this.opts.onAssetsChanged()
    setMessage(`🖼 "${name}" imported — pick it in any texture list`)
    return name
  }

  /**
   * Import a GLB. Bounds are DERIVED by instantiating it once through the
   * cache, which also warms it — placing the model afterwards needs no second
   * parse — rather than asking the user for numbers they cannot know.
   */
  async importModel(file: File): Promise<string | null> {
    const { history, modelCache, setMessage } = this.opts
    setMessage('🗿 uploading model…')
    const uploaded = await this.upload(file)
    if (uploaded === 'forbidden') {
      setMessage('⛔ import needs your admin token (top right)')
      return null
    }
    if (!uploaded) {
      setMessage('⛔ upload failed — check the connection and try again')
      return null
    }
    const id = newId('model')
    const probe = await modelCache.instantiate(id, uploaded.url)
    if (!probe) {
      modelCache.forget(id)
      setMessage('⛔ that file could not be parsed as a glb')
      return null
    }
    const { min, max } = probe.root.getHierarchyBoundingVectors(true)
    const bounds: [number, number, number] = [
      Math.max(0.2, max.x - min.x),
      Math.max(0.2, max.y - min.y),
      Math.max(0.2, max.z - min.z),
    ]
    probe.dispose()

    const name = file.name.replace(/\.(glb|gltf)$/i, '').slice(0, 24) || 'model'
    const model: MapModelV2 = { id, name, glb: uploaded.url, bounds }
    history.apply({
      label: `import model ${name}`,
      execute: (d) => d.addModelAsset(model),
      undo: (d) => d.removeModelAsset(id),
    })
    this.opts.onAssetsChanged()
    setMessage(`🗿 "${name}" imported (${bounds.map((b) => b.toFixed(1)).join('×')} m)`)
    return id
  }

  // ── Mutation ────────────────────────────────────────────────────────

  deleteTexture(name: string): boolean {
    const { doc, history, setMessage } = this.opts
    const usage = this.textureUsage().get(`${CUSTOM}${name}`)
    if (usage && usage.count > 0) {
      // Refused rather than done-and-repaired: the repair would be silently
      // retexturing objects nobody selected.
      setMessage(`⛔ "${name}" is used by ${usage.count} object(s) — replace them first`)
      return false
    }
    const entry = doc.textureByName(name)
    if (!entry) return false
    const value = structuredClone(entry)
    history.apply({
      label: `delete texture ${name}`,
      execute: (d) => d.removeTextureAsset(name),
      undo: (d) => d.addTextureAsset(value),
    })
    this.opts.onAssetsChanged()
    setMessage(`🗑 "${name}" removed from the map`)
    return true
  }

  deleteModel(id: string): boolean {
    const { doc, history, modelCache, setMessage } = this.opts
    const usage = this.modelUsage().get(id)
    if (usage && usage.count > 0) {
      setMessage(`⛔ that model is placed ${usage.count} time(s) — delete those first`)
      return false
    }
    const model = doc.modelById(id)
    if (!model) return false
    const value = structuredClone(model)
    history.apply({
      label: `delete model ${model.name}`,
      execute: (d) => {
        d.removeModelAsset(id)
        modelCache.forget(id)
      },
      undo: (d) => d.addModelAsset(value),
    })
    this.opts.onAssetsChanged()
    setMessage(`🗑 "${model.name}" removed from the map`)
    return true
  }

  /**
   * Rename a texture and EVERY reference to it, atomically.
   *
   * References are `custom:<name>` strings scattered through terrain and
   * static surfaces, so renaming the entry alone would leave every user of it
   * pointing at a texture that no longer exists. One history entry, and undo
   * restores all of it.
   */
  renameTexture(from: string, to: string): boolean {
    const { doc, history, setMessage } = this.opts
    const clean = sanitizeTextureName(to, () => false)
    if (clean === from) return false
    if (doc.textureByName(clean)) {
      setMessage(`⛔ a texture called "${clean}" already exists`)
      return false
    }
    if (!doc.textureByName(from)) return false

    const oldRef = `${CUSTOM}${from}`
    const newRef = `${CUSTOM}${clean}`
    // Snapshot every object that mentions it, so undo is exact.
    const affected = this.textureUsage().get(oldRef)?.ids ?? []
    const before = new Map(affected.map((id) => [id, doc.snapshot(id)]))
    const beforeTextures = structuredClone([...doc.textures()])

    history.apply({
      label: `rename texture ${from} → ${clean}`,
      execute: (d) => {
        d.renameTextureAsset(from, clean)
        for (const id of affected) {
          const value = d.snapshot(id)
          if (value) d.replace(id, retargetTexture(value, oldRef, newRef) as never)
        }
      },
      undo: (d) => {
        d.replaceAssets(d.models(), beforeTextures)
        for (const [id, value] of before)
          if (value && d.has(id)) d.replace(id, structuredClone(value) as never)
      },
    })
    this.opts.onAssetsChanged()
    setMessage(`✏ renamed to "${clean}"`)
    return true
  }
}

/** Rewrite every texture reference in one document object. */
function retargetTexture(object: unknown, from: string, to: string): unknown {
  const swap = (v: unknown): unknown => (v === from ? to : v)
  const surface = (s: unknown): unknown => {
    if (s === null || typeof s !== 'object') return s
    const value = s as { base?: { tex?: string }; paint?: { layers?: { tex?: string }[] } }
    return {
      ...value,
      ...(value.base ? { base: { ...value.base, tex: swap(value.base.tex) as string } } : {}),
      ...(value.paint
        ? {
            paint: {
              ...value.paint,
              layers: (value.paint.layers ?? []).map((l) => ({ ...l, tex: swap(l.tex) as string })),
            },
          }
        : {}),
    }
  }
  const o = structuredClone(object) as Record<string, unknown>
  if (typeof o['tex'] === 'string') o['tex'] = swap(o['tex'])
  const uv = o['uv'] as { tex?: string } | undefined
  if (uv?.tex) o['uv'] = { ...uv, tex: swap(uv.tex) as string }
  const faces = o['faces'] as Record<string, { tex?: string }> | undefined
  if (faces)
    o['faces'] = Object.fromEntries(
      Object.entries(faces).map(([k, f]) => [k, { ...f, tex: swap(f.tex) as string }]),
    )
  if (o['surface']) o['surface'] = surface(o['surface'])
  const surfaces = o['surfaces'] as Record<string, unknown> | undefined
  if (surfaces)
    o['surfaces'] = Object.fromEntries(Object.entries(surfaces).map(([k, v]) => [k, surface(v)]))
  return o
}
