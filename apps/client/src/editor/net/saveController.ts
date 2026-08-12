/**
 * Everything between the document and the server: save, revision conflicts,
 * remote adoption, drafts and asset uploads.
 *
 * Kept out of the composition root because it is the one part with real
 * sequencing — upload masks, then serialise, then If-Match, then interpret
 * the status — and because "did this overwrite someone else's work?" is
 * worth being able to read in one place.
 */
import {
  canonicalizeMapFile,
  describeDiff,
  diffMapFileV2,
  emptyMapV2,
  parseMapFile,
  type MapFileV2,
  type MapModelV2,
  type MapTextureEntry,
} from '@hobo/content'
import type { EditorDocument } from '../document/editorDocument.js'
import type { CommandHistory } from '../history/commandHistory.js'
import type { PaintMask } from '../materials/paintMask.js'
import { DraftStore, indexedDbDraftStorage } from '../recovery/draftStore.js'

export interface SaveControllerOptions {
  doc: EditorDocument
  history: CommandHistory<EditorDocument>
  bootRevision: string
  models: () => readonly MapModelV2[]
  textures: () => readonly MapTextureEntry[]
  /** Adopt a whole remote/imported/restored document. */
  onAdopt: (map: MapFileV2) => void
  /** The live paint mask for a terrain, if it has one. */
  maskOf: (id: string) => PaintMask | null
  setMessage: (m: string) => void
}

export interface SaveController {
  save: () => Promise<void>
  pollRemote: () => Promise<void>
  isDirty: () => boolean
  revision: () => string
  serialize: () => MapFileV2
  exportMap: () => void
  importMap: (file: File) => Promise<void>
  conflict: () => { open: boolean; summary: string[] }
  resolveConflict: (choice: 'theirs' | 'mine' | 'export') => void
  restoreDraftIfAny: () => Promise<void>
  onChange: (fn: () => void) => void
}

export function createSaveController(opts: SaveControllerOptions): SaveController {
  const { doc, history, setMessage } = opts
  let baseRevision = opts.bootRevision
  let remoteDoc: MapFileV2 = doc.serialize()
  let nonHistoryDirt = false
  let conflictSummary: string[] = []
  let conflictOpen = false
  const listeners = new Set<() => void>()
  const notify = (): void => listeners.forEach((f) => f())

  const drafts = new DraftStore({
    storage: indexedDbDraftStorage(),
    mapKey: `${location.origin}/map.json`,
  })

  const isDirty = (): boolean => nonHistoryDirt || history.isDirty()

  const serialize = (): MapFileV2 => {
    const map = doc.serialize()
    map.models = [...opts.models()] as MapFileV2['models']
    map.textures = [...opts.textures()] as MapFileV2['textures']
    return map
  }

  const editorKey = (): string =>
    (document.getElementById('key') as HTMLInputElement | null)?.value.trim() ?? ''

  /**
   * Masks stay canvases while editing and become content-addressed assets on
   * save. An unchanged mask hashes the same, so the second save uploads
   * nothing — which is the whole reason not to embed them as data URLs.
   */
  const uploadMasks = async (): Promise<void> => {
    for (const terrain of doc.listByKind('terrain')) {
      const mask = opts.maskOf(terrain.id)
      const surface = terrain.surface
      if (!mask || !surface?.paint) continue
      const blob = await mask.toBlob()
      if (!blob) continue
      try {
        const resp = await fetch('/api/map-assets', {
          method: 'POST',
          headers: { 'x-editor-key': editorKey() },
          body: blob,
        })
        if (!resp.ok) continue
        const asset = (await resp.json()) as { url: string }
        doc.update(terrain.id, {
          surface: { ...surface, paint: { ...surface.paint, mask: asset.url } },
        })
      } catch {
        // Offline: keep whatever the mask already had rather than losing it.
      }
    }
  }

  const save = async (): Promise<void> => {
    const key = editorKey()
    localStorage.setItem('hobo.editorkey', key)
    setMessage('saving…')
    await uploadMasks()
    const file = serialize()
    let resp: Response
    try {
      resp = await fetch('/api/map', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-editor-key': key,
          // The revision we last loaded: the server 409s a stale save rather
          // than letting it overwrite another admin's work.
          ...(baseRevision ? { 'if-match': baseRevision } : {}),
        },
        body: JSON.stringify(file),
      })
    } catch {
      setMessage('⛔ server unreachable — your work is kept locally')
      return
    }
    const served = resp.headers.get('etag')?.replace(/"/g, '')
    if (served) baseRevision = served
    if (resp.ok) {
      history.markSaved()
      nonHistoryDirt = false
      remoteDoc = file
      void drafts.markSaved()
      setMessage('✅ saved — live in game')
      notify()
      return
    }
    if (resp.status === 409) {
      await openConflict()
      setMessage('⚠ another admin saved first — your revision is stale')
      return
    }
    if (resp.status === 422) {
      const j = (await resp.json().catch(() => null)) as { issues?: string[] } | null
      setMessage(`⛔ map rejected: ${(j?.issues ?? ['invalid']).slice(0, 2).join('; ')}`)
      return
    }
    setMessage(
      resp.status === 403
        ? '⛔ not authorized (admin token/key required)'
        : resp.status === 413
          ? '⛔ map too large'
          : `save failed (${resp.status})`,
    )
  }

  /**
   * A remote save landed. When the local copy is CLEAN the document is
   * adopted; when it is dirty nothing is touched and the conflict panel
   * opens — silently replacing unsaved work is never acceptable.
   */
  const pollRemote = async (): Promise<void> => {
    try {
      const resp = await fetch('/map.json')
      const served = resp.headers.get('etag')?.replace(/"/g, '')
      if (served && served === baseRevision) return
      const parsed = parseMapFile(await resp.json())
      if (!parsed.ok) return
      if (diffMapFileV2(remoteDoc, parsed.map).empty) return
      if (isDirty()) {
        remoteDoc = parsed.map
        await openConflict()
        setMessage('⚠ another admin saved while you have unsaved changes')
        return
      }
      remoteDoc = parsed.map
      if (served) baseRevision = served
      opts.onAdopt(parsed.map)
      setMessage('🔄 merged edits from another admin')
      notify()
    } catch {
      // Offline poll; the next one will pick it up.
    }
  }

  const openConflict = async (): Promise<void> => {
    conflictOpen = true
    try {
      const resp = await fetch('/map.json')
      const parsed = parseMapFile(await resp.json())
      conflictSummary = parsed.ok
        ? describeDiff(diffMapFileV2(serialize(), parsed.map))
        : ['Could not read the remote map to compare.']
    } catch {
      conflictSummary = ['Could not fetch the remote map to compare.']
    }
    notify()
  }

  const download = (map: MapFileV2, name: string): void => {
    const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }

  const noteDraft = (): void => {
    if (isDirty()) drafts.noteChange(serialize(), baseRevision)
  }
  // Drafts follow BOTH the document and the history.
  //
  // A gesture mutates the document first and records its command on release,
  // so at document-change time the history is not yet dirty — watching only
  // the document meant a drag was never drafted at all.
  doc.subscribe(() => {
    noteDraft()
    notify()
  })
  history.onChange(() => {
    noteDraft()
    notify()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void drafts.flush()
  })
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault()
  })
  setInterval(() => void pollRemote(), 6000)

  return {
    save,
    pollRemote,
    isDirty,
    revision: () => baseRevision,
    serialize,
    exportMap: () => download(serialize(), `hoboquest-map-${Date.now()}.json`),
    importMap: async (file) => {
      let raw: unknown
      try {
        raw = JSON.parse(await file.text())
      } catch {
        setMessage('⛔ that file is not JSON')
        return
      }
      // v1 migrates, v2 validates; either way the issues are reported BEFORE
      // anything local is replaced.
      const parsed = parseMapFile(raw)
      if (!parsed.ok) {
        setMessage(`⛔ import rejected: ${parsed.issues.slice(0, 3).join('; ')}`)
        return
      }
      if (isDirty() && !confirm('Replace your unsaved work with the imported map?')) return
      opts.onAdopt(parsed.map)
      nonHistoryDirt = true
      setMessage(
        parsed.migrated ? '📥 imported (migrated from v1)' : '📥 imported — Save to publish',
      )
      notify()
    },
    conflict: () => ({ open: conflictOpen, summary: conflictSummary }),
    resolveConflict: (choice) => {
      if (choice === 'export') {
        download(serialize(), `hoboquest-map-local-${Date.now()}.json`)
        return
      }
      conflictOpen = false
      if (choice === 'mine') {
        setMessage('keeping your version — Save stays refused until you reload')
        notify()
        return
      }
      nonHistoryDirt = false
      history.markSaved()
      remoteDoc = emptyMapV2()
      void drafts.discard()
      void pollRemote()
      notify()
    },
    restoreDraftIfAny: async () => {
      const draft = await drafts.pendingDraft(baseRevision)
      if (draft) {
        const age = Math.max(1, Math.round((Date.now() - draft.savedAt) / 60_000))
        if (
          confirm(
            `Unsaved local work found from ~${age} minute(s) ago.\n\n` +
              'OK: restore it (it is NOT published until you Save).\n' +
              'Cancel: discard it and keep the server version.',
          )
        ) {
          opts.onAdopt(draft.map)
          nonHistoryDirt = true
          setMessage('↩ restored your unsaved draft — Save to publish it')
          notify()
          return
        }
        await drafts.discard()
        return
      }
      const stale = await drafts.staleDraft(baseRevision)
      if (
        stale &&
        confirm(
          'An unsaved draft exists, but the map has been saved by someone else since.\n\n' +
            'OK: download the draft so nothing is lost.\nCancel: discard it.',
        )
      ) {
        download(stale.map, `hoboquest-map-draft-${stale.savedAt}.json`)
      }
      await drafts.discard()
    },
    onChange: (fn) => listeners.add(fn),
  }
}

export { canonicalizeMapFile }
