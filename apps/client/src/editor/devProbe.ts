/**
 * The acceptance harness's window surface.
 *
 * `window.__editor` is how `e2e/editorCheck.ts` and `e2e/editorCollabCheck.ts`
 * observe and drive the editor. It is NOT a public API and nothing in the app
 * may call it — it exists so the browser suites can talk to the editor through
 * one named seam instead of reaching into internals whose shape changes.
 *
 * It lives here rather than in the composition root for the obvious reason:
 * the harness surface is not composition, and it was a fifth of that file.
 *
 * Two rules it must keep, both learned the hard way:
 *
 *  - A probe that MUTATES goes through the same gate the UI does. `groupMove`
 *    once bypassed `withLock`, which made the collaboration suite prove
 *    nothing at all.
 *  - Screen coordinates crossing this boundary are PAGE coordinates, because
 *    that is what a real cursor uses. The canvas sits in a grid cell, so
 *    canvas space and page space differ by the canvas offset.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import type { AssetController } from './assets/assetController.js'
import type { EditorConnection } from './collaboration/editorConnection.js'
import type { EditorDocument } from './document/editorDocument.js'
import { transformOf } from './document/editorObject.js'
import type { CommandHistory } from './history/commandHistory.js'
import { setProperties } from './history/commands.js'
import type { InteractionController } from './interaction/interactionController.js'
import type { ViewportInteraction } from './interaction/viewportInteraction.js'
import type { SaveController } from './net/saveController.js'
import { editorPerf } from './perf/editorProfiler.js'
import type { FaceOverlayManager, FaceSelection } from './selection/faceSelection.js'
import type { SelectionManager } from './selection/selectionManager.js'
import type { ToolManager } from './tools/toolManager.js'
import type { Tool } from './catalog.js'
import type { EditorCameraController } from './viewport/editorCameraController.js'
import type { EditorViewRegistry } from './viewport/editorViewRegistry.js'
import type { GizmoController } from './viewport/gizmoController.js'
import type { TransformSession } from './viewport/transformSession.js'
import { TerrainView } from './viewport/views/index.js'
import type { EditorUi } from './ui/editorUi.js'

/** Everything the probe reads. Live references, resolved at call time. */
export interface EditorProbeDeps {
  doc: EditorDocument
  views: EditorViewRegistry
  selection: SelectionManager
  history: CommandHistory
  tools: ToolManager
  gizmo: GizmoController
  xform: TransformSession
  interaction: InteractionController
  viewport: ViewportInteraction
  cameraController: EditorCameraController
  camera: FreeCamera
  canvas: HTMLCanvasElement
  scene: Scene
  faceSelection: FaceSelection
  faceOverlays: FaceOverlayManager
  saveController: SaveController
  connection: EditorConnection
  assets: AssetController
  ui: EditorUi
  /** The terrain a stroke is currently targeting — mutable, hence a getter. */
  strokeTargetId: () => string | null
  placeModel: (modelId: string) => void
  withLock: (ids: readonly string[], then: () => void) => boolean
  refreshPivot: () => void
}

/** Attach the harness surface to `window`. Called once, at the end of boot. */
export function installEditorProbe(d: EditorProbeDeps): void {
  ;(window as unknown as { __editor: unknown }).__editor = {
    selectionIds: () => d.selection.ids(),
    primaryId: () => d.selection.primaryId,
    interactionState: () => d.interaction.state,
    gizmoState: () => ({
      mode: d.gizmo.currentMode,
      attached: d.gizmo.active,
      dragging: d.xform.active,
    }),
    gizmoHandleScreenPos: (axis: 'x' | 'y' | 'z') => {
      // The spiral search works in CANVAS space (it picks the utility
      // layer); the harness needs page coordinates to move a real mouse.
      const canvasPoint = d.gizmo.handleScreenPoint(axis, (p) => {
        const [px, py] = d.cameraController.worldToScreen(p)
        return d.cameraController.toCanvasSpace(px, py)
      })
      if (!canvasPoint) return null
      const rect = d.canvas.getBoundingClientRect()
      return [Math.round(canvasPoint[0] + rect.left), Math.round(canvasPoint[1] + rect.top)]
    },
    cameraSnapshot: () => ({
      pos: [d.camera.position.x, d.camera.position.y, d.camera.position.z],
      rot: [d.camera.rotation.x, d.camera.rotation.y, d.camera.rotation.z],
    }),
    history: () => ({ depth: d.history.depth, redo: d.history.redoDepth }),
    terrainWires: () => {
      const out: Record<string, boolean> = {}
      for (const t of d.doc.listByKind('terrain')) {
        const v = d.views.viewOf(t.id)
        if (v instanceof TerrainView) out[t.id] = v.wireVisible()
      }
      return out
    },
    faceSelKeys: () => d.faceSelection.keys(),
    faceOverlayCount: () => d.faceOverlays.count,
    // The harness works in page coordinates, like a real cursor does.
    pickIdAt: (x: number, y: number) =>
      d.viewport.pickIdAt(...d.cameraController.toCanvasSpace(x, y)),
    surfaceMaterialOf: (id: string) => {
      const v = d.views.viewOf(id)
      if (!(v instanceof TerrainView)) return null
      const data = v.surfaceData()
      return {
        base: data.base.tex ?? null,
        layers: (data.paint?.layers ?? []).map((l) => ({
          tex: l.tex,
          channel: l.channel,
          hidden: l.hidden === true,
          color: l.color ?? null,
        })),
        hasMask: Boolean(data.paint?.mask),
      }
    },
    paintSurface: () => (d.strokeTargetId() ? { objectId: d.strokeTargetId() } : null),
    setPaintTexture: (tex: string) => {
      ;(document.getElementById('paint-tex') as HTMLSelectElement).value = tex
    },
    setPaintColor: (hex: string) => {
      ;(document.getElementById('paint-color') as HTMLInputElement).value = hex
    },
    setInspectorTexture: (tex: string) => {
      const id = d.selection.primaryId
      if (!id) return
      const v = d.views.viewOf(id)
      if (v instanceof TerrainView) {
        const data = structuredClone(v.surfaceData())
        data.base = { ...data.base, tex }
        const cmd = setProperties(d.doc, id, { surface: data }, 'set base texture')
        if (cmd) d.history.apply(cmd)
      } else {
        const cmd = setProperties(d.doc, id, { tex }, 'set texture')
        if (cmd) d.history.apply(cmd)
      }
      d.ui.refreshAll()
    },
    terrainIds: () => d.doc.listByKind('terrain').map((t) => t.id),
    transformOf: (id: string) => {
      const t = transformOf(d.doc, id)
      return t ? { position: t.position, rotation: t.rotation } : null
    },
    worldToScreen: (p: [number, number, number]) =>
      d.cameraController.worldToScreen(new Vector3(p[0], p[1], p[2])),
    setToolByName: (t: string) => d.tools.set(t as Tool),
    selectByIds: (ids: string[]) => d.selection.replaceMany(ids),
    undo: () => {
      d.history.undo()
      d.ui.refreshAll()
    },
    redo: () => {
      d.history.redo()
      d.ui.refreshAll()
    },
    setCameraPose: (pos: number[], rot: number[]) => {
      d.camera.position.set(pos[0]!, pos[1]!, pos[2]!)
      d.camera.rotation.set(rot[0]!, rot[1]!, rot[2]!)
    },
    objectCounts: () => ({
      statics: d.doc.listByKind('static').length,
      terrains: d.doc.listByKind('terrain').length,
      nodes: d.doc.listByKind('node').length,
      props: d.doc.listByKind('prop').length,
      lights: d.doc.listByKind('light').length,
      zones: d.doc.listByKind('zone').length,
    }),
    terrainMeshCount: () => d.doc.listByKind('terrain').length,
    sceneMeshNames: () => d.scene.meshes.map((m) => m.name),
    get dirty() {
      return d.saveController.isDirty()
    },
    get tool() {
      return d.tools.active
    },
    groupMove: (dx: number, dy: number, dz: number) => {
      // Goes through the SAME gate the d.gizmo does. A probe that could move
      // an object the server has not granted would make the collaboration
      // suite prove nothing.
      const ids = d.selection.ids().filter((id) => transformOf(d.doc, id) !== null)
      let allowed = false
      d.withLock(ids, () => {
        allowed = true
      })
      if (!allowed) return
      const started = d.xform.begin(d.selection.ids(), 'move', { label: 'group move' })
      if (!started) return
      const p = started.pivotStart
      d.xform.update({
        ...p,
        position: [p.position[0] + dx, p.position[1] + dy, p.position[2] + dz],
      })
      d.xform.commit()
      d.refreshPivot()
      d.ui.refreshAll()
    },
    hasSky: () => d.scene.meshes.some((m) => m.name.includes('sky') || m.name.includes('cloud')),
    /** Collaboration state, for the two-editor acceptance suite. */
    collab: () => ({
      connected: d.connection.connected(),
      peerId: d.connection.myPeerId(),
      peers: d.connection.peers().map((p) => ({ ...p, selection: [...p.selection] })),
      peerCount: d.connection.peerCount(),
      lockOwners: Object.fromEntries(d.connection.lockOwners()),
      owns: d.selection.ids().filter((id) => d.connection.owns(id)),
    }),
    inspectorLockedBy: () =>
      d.selection.primaryId ? d.connection.lockOwner(d.selection.primaryId) : null,
    setProperty: (ids: string[], key: string, value: unknown) => d.ui.setProperty(ids, key, value),
    deleteSelection: () => d.ui.remove(),
    colorOf: (id: string) => (d.doc.get(id) as { color?: string } | null)?.color ?? null,
    /** Asset metadata straight from the document (no parallel array). */
    assetState: () => ({
      textures: d.doc.textures().map((t) => ({ name: t.name, url: t.url ?? null })),
      models: d.doc.models().map((m) => ({ id: m.id, name: m.name, glb: m.glb })),
      textureUsage: Object.fromEntries(
        [...d.assets.textureUsage()].map(([ref, u]) => [ref, u.count]),
      ),
      modelUsage: Object.fromEntries([...d.assets.modelUsage()].map(([id, u]) => [id, u.count])),
    }),
    importTextureBytes: async (name: string, bytes: number[]) => {
      const file = new File([new Uint8Array(bytes)], name, { type: 'image/png' })
      return d.assets.importTexture(file)
    },
    importModelBytes: async (name: string, bytes: number[]) => {
      const file = new File([new Uint8Array(bytes)], name, { type: 'model/gltf-binary' })
      return d.assets.importModel(file)
    },
    /** Arm an imported model for placement, exactly as the Assets panel does. */
    armModel: (modelId: string) => d.placeModel(modelId),
    renameTexture: (from: string, to: string) => d.assets.renameTexture(from, to),
    deleteTexture: (name: string) => d.assets.deleteTexture(name),
    textureRefsOf: (id: string) => JSON.stringify(d.doc.get(id) ?? null),
    /** Painted surfaces of an object, keyed by surface id (paint E2E). */
    paintedSurfaces: (id: string) => {
      const o = d.doc.get(id) as {
        surface?: { paint?: { layers: unknown[]; mask?: string } }
        surfaces?: Record<string, { paint?: { layers: unknown[]; mask?: string } }>
      } | null
      const out: Record<string, { layers: number; hasMask: boolean }> = {}
      if (o?.surface?.paint)
        out['surface'] = {
          layers: o.surface.paint.layers.length,
          hasMask: Boolean(o.surface.paint.mask),
        }
      for (const [sid, data] of Object.entries(o?.surfaces ?? {}))
        if (data.paint)
          out[sid] = { layers: data.paint.layers.length, hasMask: Boolean(data.paint.mask) }
      return out
    },
    /** Paint at a screen point with the current brush, as a user drag does. */
    maskUploadCount: () => d.saveController.maskUploadCount(),
    zoneOf: (id: string) => {
      const z = d.doc.get(id, 'zone')
      return z ? { min: [...z.min], max: [...z.max], rules: { ...z.rules } } : null
    },
    setLightType: (t: string) => {
      ;(document.getElementById('light-type') as HTMLSelectElement).value = t
    },
    lightSummaries: () =>
      d.doc.listByKind('light').map((l) => ({
        type: l.type,
        // A light with neither reach nor direction lights nothing.
        ok: (l.range ?? 0) > 0 || l.dir !== undefined || l.type === 'hemi',
        hasAngle: l.angle !== undefined,
      })),
    save: () => d.saveController.save(),
    /**
     * Performance counters. Off unless something turns them on, so the
     * measurement never costs anything in normal use.
     */
    perf: {
      start: () => {
        editorPerf.reset()
        editorPerf.setEnabled(true)
      },
      stop: () => editorPerf.setEnabled(false),
      snapshot: () => editorPerf.snapshot(),
    },
    /** Object/mesh counts, for scaling assertions against map size. */
    sceneStats: () => ({
      objects: d.doc.list().length,
      views: d.views.size,
      meshes: d.views.allMeshes().length,
      sceneMeshes: d.scene.meshes.length,
    }),
  }
}
