/**
 * The editor's composition root.
 *
 * This is the ONLY file that knows about all the pieces. It owns no rules of
 * its own: the document owns map data, the view registry owns Babylon
 * objects, the selection manager owns what is selected, the command history
 * owns undo, the tool manager owns modes. Everything here is wiring, and if
 * a behaviour lives here that could live in one of those, it is in the wrong
 * place.
 *
 * The previous `main.ts` was 171 KB because there was nowhere else to put
 * anything.
 */
import { Engine } from '@babylonjs/core/Engines/engine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import {
  MAX_PAINT_LAYERS,
  allocateLayer,
  createContent,
  emptyMapV2,
  parseMapFile,
  setMapOverride,
  type MapFileV2,
  type MapTextureEntry,
  type SurfaceMaterialData,
} from '@hobo/content'
import { Environment } from '../render/environment.js'
import { registerCustomTextures } from '../render/mapStyle.js'
import { ModelCache } from './assets/modelCache.js'
import { ENTITY_DEFS, PLACEABLES, newId, type Placeable, type Tool } from './catalog.js'
import { EditorDocument } from './document/editorDocument.js'
import { transformOf } from './document/editorObject.js'
import { CommandHistory } from './history/commandHistory.js'
import {
  addObject,
  heightDelta,
  paintStroke,
  removeObjects,
  setProperties,
  terrainSculpt,
  transformObjects,
} from './history/commands.js'
import { InteractionController } from './interaction/interactionController.js'
import { ViewportInteraction, type SelectMode } from './interaction/viewportInteraction.js'
import { FaceOverlayManager, FaceSelection } from './selection/faceSelection.js'
import { SelectionManager } from './selection/selectionManager.js'
import { SelectionVisuals } from './selection/selectionVisuals.js'
import { ToolManager } from './tools/toolManager.js'
import { PlacementTool, objectForPlacement } from './tools/placementTool.js'
import { sculptDab, toTerrainLocal, type SculptMode } from './tools/terrainTool.js'
import { EditorCameraController } from './viewport/editorCameraController.js'
import { EditorViewRegistry } from './viewport/editorViewRegistry.js'
import { GizmoController, type GizmoMode } from './viewport/gizmoController.js'
import { TransformSession, type TransformAccessor } from './viewport/transformSession.js'
import { centroidOf, type EditorTransform } from './viewport/transformMath.js'
import { TerrainView, createViewFactory } from './viewport/views/index.js'
import { readPreferences, savePreferences } from './viewport/editorPreferences.js'
import { planarUV, toPaintUV } from './materials/paintableSurface.js'
import { buildShell } from './ui/editorShell.js'
import { createEditorUi } from './ui/editorUi.js'
import { createSaveController } from './net/saveController.js'
import { ActionRouter } from './input/actionRouter.js'
import { ACTIONS, loadBindings, type Binding } from './bindings.js'

const content = createContent()

export async function bootEditor(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const mount = document.getElementById('shell') as HTMLElement
  const shell = buildShell(mount, canvas)

  const engine = new Engine(canvas, true)
  const scene = new Scene(engine)
  const env = new Environment(scene, engine)
  const camera = new FreeCamera('cam', new Vector3(0, 45, -55), scene)
  camera.setTarget(Vector3.Zero())
  env.attachCamera(camera)

  // ── Document ────────────────────────────────────────────────────────
  // /map.json is native v2; parseMapFile migrates a legacy v1 artifact on
  // the way in, so the editor only ever holds v2 — and a missing or invalid
  // map is emptyMapV2(), never a fabricated starter heightfield.
  const bootResp = await fetch('/map.json')
  const bootRevision = bootResp.headers.get('etag')?.replace(/"/g, '') ?? ''
  const bootParsed = parseMapFile(await bootResp.json().catch(() => null))
  if (!bootParsed.ok) console.warn('[editor] map rejected, starting empty:', bootParsed.issues)
  const bootMap: MapFileV2 = bootParsed.ok ? bootParsed.map : emptyMapV2()
  const doc = new EditorDocument(bootMap)
  // The editor renders its own terrain from the document; nothing samples a
  // procedural world here.
  setMapOverride({ terrains: [] })
  registerCustomTextures(bootMap.textures as MapTextureEntry[])

  let mapModels = [...bootMap.models]
  let mapTextures = [...bootMap.textures] as MapTextureEntry[]

  // ── Views ───────────────────────────────────────────────────────────
  const modelCache = new ModelCache(scene)
  const wireMat = new StandardMaterial('wiremat', scene)
  wireMat.wireframe = true
  wireMat.emissiveColor = new Color3(0.35, 0.75, 1)
  wireMat.alpha = 0.16
  wireMat.disableLighting = true

  /** Highest authored terrain at (x, z), or 0 — a reference, not ground. */
  const sampleGround = (x: number, z: number): number => {
    let h = 0
    for (const t of doc.listByKind('terrain')) {
      if (t.rot && (Math.abs(t.rot[0]) > 0.02 || Math.abs(t.rot[2]) > 0.02)) continue
      const view = views.viewOf(t.id)
      if (!(view instanceof TerrainView)) continue
      const lx = x - t.pos[0]
      const lz = z - t.pos[2]
      if (Math.abs(lx) > t.halfExtent || Math.abs(lz) > t.halfExtent) continue
      const cell = (t.halfExtent * 2) / t.sub
      const i = Math.max(0, Math.min(t.sub, Math.round((lx + t.halfExtent) / cell)))
      const j = Math.max(0, Math.min(t.sub, Math.round((lz + t.halfExtent) / cell)))
      const ph = (view.heights[j * (t.sub + 1) + i] ?? 0) + t.pos[1]
      if (ph > h) h = ph
    }
    return h
  }

  const views: EditorViewRegistry = new EditorViewRegistry(
    doc,
    createViewFactory({
      scene,
      content,
      modelCache,
      wireMat,
      sampleGround,
      modelSource: (id) => mapModels.find((m) => m.id === id)?.glb ?? null,
      reindex: (id) => views.reindex(id),
      newId,
    }),
  )
  views.start()

  // Base world statics as unpickable context, so the map is placed in
  // something recognisable without being editable here.
  for (const s of content.world.statics) {
    const { meshForShape } = await import('../render/sceneSetup.js')
    const m = meshForShape(scene, `world:${Math.random()}`, s.shape, s.color)
    m.position.set(s.pos[0], s.pos[1], s.pos[2])
    m.rotation.set(s.rot?.[0] ?? 0, s.rot?.[1] ?? s.yaw, s.rot?.[2] ?? 0)
    m.isPickable = false
  }

  // ── Selection, history, transforms ──────────────────────────────────
  const selection = new SelectionManager()
  const visuals = new SelectionVisuals(scene, views)
  const history = new CommandHistory<EditorDocument>(doc)
  const interaction = new InteractionController()
  const prefs = { current: readPreferences() }

  const accessor: TransformAccessor = {
    get: (id) => transformOf(doc, id),
    set: (id, t) => {
      const command = transformObjects([id], [transformOf(doc, id) ?? t], [t])
      command.execute(doc)
    },
  }
  const xform = new TransformSession<undefined>(accessor, history as never)

  const tools = new ToolManager({
    onLeave: (t) => {
      if (t === 'mesh' || t === 'entity') placement.clearGhost()
      if (t === 'face') faceSelection.clear()
    },
  })

  const placement = new PlacementTool({
    scene,
    authoredCount: () => doc.listByKind('static').length + doc.listByKind('terrain').length,
    models: () => mapModels,
    snapStep: () => Number((document.getElementById('snap') as HTMLInputElement).value),
    snapBypassed: () => router.holding('xf.nosnap'),
  })

  const faceSelection = new FaceSelection()
  const faceOverlays = new FaceOverlayManager(scene)

  // ── Gizmo ───────────────────────────────────────────────────────────
  const gizmo = new GizmoController({
    scene,
    interaction,
    onDragStart: (mode) => {
      selection.freeze()
      const started = xform.begin(selection.ids(), mode, {
        label: `${mode} ${selection.size > 1 ? `${selection.size} objects` : ''}`.trim(),
      })
      if (!started) {
        selection.unfreeze()
        ui.setMessage('nothing here can be transformed')
        return false
      }
      return true
    },
    onDrag: (pivot) => {
      if (xform.active) xform.update(pivot)
    },
    onDragEnd: () => {
      if (xform.active) xform.commit()
      selection.unfreeze()
      refreshPivot()
      ui.refreshInspectorValues()
    },
  })

  /**
   * The gizmo belongs to selection, not to every tool. Leaving it attached
   * while painting or picking faces puts a grabbable handle over the exact
   * point the brush is aimed at, and the handle wins the press — so the
   * first stroke on a selected object silently did nothing.
   */
  const gizmoAllowed = (): boolean => tools.active === null || tools.active === 'select'

  const refreshPivot = (): void => {
    const ids = selection.ids()
    const transforms = ids
      .map((id) => transformOf(doc, id))
      .filter((t): t is EditorTransform => !!t)
    if (transforms.length === 0 || !gizmoAllowed()) {
      gizmo.attach(false)
      return
    }
    gizmo.setPivot(centroidOf(transforms), transforms.length === 1 ? transforms[0] : undefined)
    gizmo.attach(true)
  }

  const applyPreferences = (): void => {
    const p = prefs.current
    gizmo.setSpace(p.space)
    gizmo.setSnap(
      p.snap.translate.on ? p.snap.translate.step : 0,
      p.snap.rotate.on ? (p.snap.rotate.step * Math.PI) / 180 : 0,
      p.snap.scale.on ? p.snap.scale.step : 0,
    )
    savePreferences(p)
    refreshPivot()
    ui.refreshStatus()
  }

  // ── Camera ──────────────────────────────────────────────────────────
  const cameraController = new EditorCameraController({
    scene,
    camera,
    canvas,
    interaction,
    holding: (a) => router.holding(a),
    // While a placement tool is active the wheel rotates the preview; that
    // is the tool's context, not the camera's, and the strip says so.
    wheelIsClaimed: () => {
      const t = tools.active
      if (t !== 'mesh' && t !== 'entity') return false
      placement.rotatePreview(0.18)
      return true
    },
  })

  // ── Selection helpers ───────────────────────────────────────────────
  const applySelect = (id: string | null, mode: SelectMode): void => {
    if (!id) {
      // Ctrl/Alt on empty space keeps the selection: a modifier click is an
      // adjustment, and losing everything to a slightly-off click is the
      // most annoying possible outcome.
      if (mode === 'replace') selection.clear()
      return
    }
    if (mode === 'add') selection.add(id)
    else if (mode === 'subtract') selection.remove(id)
    else selection.replace(id)
  }

  selection.onChange(() => {
    refreshPivot()
    refreshVisuals()
    ui.refreshSelection()
    connection.sendSelection(selection.ids())
  })

  let hoverId: string | null = null
  const refreshVisuals = (): void => {
    visuals.refresh({
      ids: selection.ids(),
      primary: selection.primaryId,
      hover: hoverId,
      remote: connection.remoteSelections(),
      locks: connection.lockColors(),
      terrainHoverWire:
        tools.is('terrain') && hoverId && doc.typeOf(hoverId) === 'terrain' ? hoverId : null,
      strokeWire: strokeTargetId,
    })
  }

  // ── Terrain + paint strokes ─────────────────────────────────────────
  let strokeTargetId: string | null = null
  let strokeBefore: Float32Array | null = null
  let paintLayerChannel: string | null = null

  const terrainUnderCursor = (): { id: string; view: TerrainView; local: Vector3 } | null => {
    const hit = viewport.pickPoint()
    if (!hit?.id) return null
    const view = views.viewOf(hit.id)
    if (!(view instanceof TerrainView)) return null
    const t = doc.get(hit.id, 'terrain')
    if (!t) return null
    const l = toTerrainLocal(hit.point, t.pos, t.rot, t.scale)
    return { id: hit.id, view, local: new Vector3(l.x, l.y, l.z) }
  }

  const brushSettings = (): { radius: number; strength: number; feather: number } => ({
    radius: Number((document.getElementById('radius') as HTMLInputElement).value),
    strength: Number((document.getElementById('strength') as HTMLInputElement).value),
    feather: Number((document.getElementById('feather') as HTMLInputElement).value),
  })

  const sculptAt = (sign: number): void => {
    const target = terrainUnderCursor()
    if (!target) return
    if (strokeTargetId && target.id !== strokeTargetId) return // one target per stroke
    if (!strokeTargetId) {
      if (!connection.canEdit(target.id)) {
        ui.setMessage(`🔒 terrain locked by ${connection.lockOwner(target.id)}`)
        return
      }
      strokeTargetId = target.id
      strokeBefore = target.view.heights.slice()
      refreshVisuals()
    }
    const mode = (document.getElementById('terrain-mode') as HTMLSelectElement).value as SculptMode
    sculptDab(target.view, target.local.x, target.local.z, sign, mode, brushSettings())
    target.view.refreshHeights()
  }

  const paintAt = (): void => {
    const target = terrainUnderCursor()
    if (!target) return
    if (strokeTargetId && target.id !== strokeTargetId) return
    const surface = ensurePaintLayer(target.id)
    if (!surface) return
    if (!strokeTargetId) {
      strokeTargetId = target.id
      target.view.mask.beginStroke()
      refreshVisuals()
    }
    const t = doc.get(target.id, 'terrain')!
    const uv = planarUV({ x: target.local.x, z: target.local.z }, t.halfExtent)
    const brush = brushSettings()
    const p = toPaintUV(uv, target.view.mask.size, brush.radius, t.halfExtent * 2)
    target.view.mask.stamp(surface.channel as never, {
      u: p.u,
      v: p.v,
      radius: p.radiusPixels,
      strength: Math.min(1, brush.strength),
      feather: brush.feather,
      erase: (document.getElementById('paint-erase') as HTMLInputElement).checked,
    })
  }

  /** Allocate (or reuse) the layer the brush is painting into. */
  const ensurePaintLayer = (id: string): { channel: string } | null => {
    const tex = (document.getElementById('paint-tex') as HTMLSelectElement).value || 'none'
    const colorInput = document.getElementById('paint-color') as HTMLInputElement
    const color = colorInput.value.toLowerCase()
    const tint = tex === 'none' || color !== '#ffffff' ? color : undefined
    const view = views.viewOf(id)
    if (!(view instanceof TerrainView)) return null
    const data: SurfaceMaterialData = structuredClone(view.surfaceData())
    const alloc = allocateLayer(data.paint, tex, () => newId('pl'), tint)
    if (!alloc) {
      ui.setMessage(`⛔ all ${MAX_PAINT_LAYERS} paint layers are in use — remove one first`)
      return null
    }
    data.paint = alloc.paint
    if (alloc.created) {
      // A new layer is a document change in its own right; the mask stroke
      // that follows is the separate, undoable part.
      doc.update(id, { surface: data })
      view.refreshSurface(view.surfaceData())
    }
    paintLayerChannel = alloc.layer.channel
    return { channel: alloc.layer.channel }
  }

  const endStroke = (): void => {
    const id = strokeTargetId
    strokeTargetId = null
    if (!id) return
    const view = views.viewOf(id)
    if (!(view instanceof TerrainView)) return

    if (tools.is('terrain') && strokeBefore) {
      const delta = heightDelta(strokeBefore, view.heights, view.sub + 1)
      strokeBefore = null
      if (delta) {
        // The document holds encoded heights; the view holds the working
        // buffer. One command keeps them in step, both ways.
        doc.update(id, { heights: view.encodedHeights() })
        history.record(
          terrainSculpt(id, delta, view.sub + 1, (tid, apply) => {
            const v = views.viewOf(tid)
            if (!(v instanceof TerrainView)) return
            apply(v.heights)
            v.refreshHeights()
            doc.update(tid, { heights: v.encodedHeights() })
          }),
        )
      }
    }
    if (tools.is('paint') && paintLayerChannel) {
      const patch = view.mask.endStroke()
      if (patch) {
        const data = structuredClone(view.surfaceData())
        data.paint = { ...(data.paint ?? { layers: [] }), mask: view.mask.toDataURL() }
        doc.update(id, { surface: data })
        history.record(
          paintStroke(id, 'surface', patch.before, patch.after, (tid, _sid, p) => {
            const v = views.viewOf(tid)
            if (!(v instanceof TerrainView)) return
            v.mask.applyPatch(p)
            const d = structuredClone(v.surfaceData())
            d.paint = { ...(d.paint ?? { layers: [] }), mask: v.mask.toDataURL() }
            doc.update(tid, { surface: d })
          }),
        )
      }
      paintLayerChannel = null
    }
    refreshVisuals()
    ui.refreshAll()
  }

  // ── Placement ───────────────────────────────────────────────────────
  const activePlaceable = (): Placeable | null => {
    if (tools.is('entity'))
      return (
        ENTITY_DEFS[Number((document.getElementById('entity-sel') as HTMLSelectElement).value)] ??
        null
      )
    if (tools.is('mesh'))
      return (
        PLACEABLES[Number((document.getElementById('mesh-sel') as HTMLSelectElement).value)] ?? null
      )
    return null
  }

  const placeNow = (): void => {
    const def = activePlaceable()
    const pose = placement.computePose(def)
    if (!def || !pose) return
    const made = objectForPlacement(def, pose, mapModels)
    if (!made) return
    // Spawn is a singleton: placing it again moves the one that exists.
    if (made.kind === 'spawn' && doc.has('spawn')) {
      const cmd = setProperties(doc, 'spawn', made.object, 'move spawn')
      if (cmd) history.apply(cmd)
    } else {
      history.apply(addObject(made.kind, made.object as never, `place ${made.kind}`))
    }
    selection.replace(String(made.object['id']))
    ui.refreshAll()
  }

  // ── Face tool ───────────────────────────────────────────────────────
  const pickFace = (mode: SelectMode): void => {
    const hit = viewport.pickPoint()
    if (!hit?.id) {
      if (mode === 'replace') faceSelection.clear()
    } else {
      const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => pickable(m))
      const ref = { objectId: hit.id, face: Math.floor((pick?.faceId ?? 0) / 2) }
      if (mode === 'replace') faceSelection.replace(ref)
      else faceSelection.toggle(ref)
    }
    faceOverlays.sync(faceSelection.refs(), (id) => views.meshesOf(id)[0] ?? null)
    ui.refreshStatus()
  }

  // ── Pointer routing ─────────────────────────────────────────────────
  const pickable = (m: AbstractMesh): boolean =>
    m.isEnabled() && m.isPickable && m !== placement.preview && m !== brushCursor

  const viewport = new ViewportInteraction({
    canvas,
    scene,
    interaction,
    tool: () => tools.active,
    ownerOf: (m) => views.ownerOf(m),
    pickable,
    handlers: {
      onSelect: applySelect,
      onPlace: placeNow,
      onSculptStart: (sign) => sculptAt(sign),
      onSculptMove: () => sculptAt(viewport.painting),
      onPaintStart: paintAt,
      onPaintMove: paintAt,
      onStrokeEnd: endStroke,
      onFacePick: pickFace,
      onFrame: () => undefined,
    },
  })

  // ── Brush cursor ────────────────────────────────────────────────────
  const brushCursor = CreateSphere('brush', { diameter: 1, segments: 8 }, scene)
  const brushMat = new StandardMaterial('brushmat', scene)
  brushMat.emissiveColor = new Color3(0.4, 0.8, 1)
  brushMat.alpha = 0.3
  brushMat.disableLighting = true
  brushCursor.material = brushMat
  brushCursor.isPickable = false
  brushCursor.setEnabled(false)

  // ── Save / draft / collaboration ────────────────────────────────────
  const saveController = createSaveController({
    doc,
    history,
    bootRevision,
    models: () => mapModels,
    textures: () => mapTextures,
    onAdopt: (map) => {
      mapModels = [...map.models]
      mapTextures = [...map.textures] as MapTextureEntry[]
      registerCustomTextures(mapTextures)
      doc.replaceFromRemote(map)
      history.rebase()
      selection.retain((id) => doc.has(id))
      ui.refreshAll()
    },
    maskOf: (id) => {
      const v = views.viewOf(id)
      return v instanceof TerrainView ? v.mask : null
    },
    setMessage: (m) => ui.setMessage(m),
  })

  const { createEditorConnection } = await import('./collaboration/editorConnection.js')
  const connection = createEditorConnection({
    scene,
    peersEl: document.getElementById('peers') as HTMLElement,
    camera,
    keyOf: () => (document.getElementById('key') as HTMLInputElement).value.trim(),
    onRemoteSaved: () => void saveController.pollRemote(),
    onChange: () => {
      refreshVisuals()
      ui.refreshAll()
    },
    onLockLost: () => {
      if (xform.active) xform.cancel()
      selection.unfreeze()
      ui.setMessage('⚠ edit lock lost — reselect to reacquire')
    },
  })

  // ── UI ──────────────────────────────────────────────────────────────
  const bindings = loadBindings(localStorage.getItem('hobo.editor.bindings'))
  const bindingOf = (action: string): Binding => bindings[action] ?? { code: 'F24' }

  const ui = createEditorUi({
    shell,
    doc,
    views,
    selection,
    history,
    tools,
    prefs,
    gizmo,
    env,
    connection,
    saveController,
    bindings,
    bindingOf,
    textures: () => mapTextures,
    models: () => mapModels,
    onPreferences: applyPreferences,
    focusObject: (id) => {
      selection.replace(id)
      const t = transformOf(doc, id)
      if (t) cameraController.frame(new Vector3(...t.position), 6)
    },
    deleteSelection: () => {
      const ids = selection.ids().filter((id) => connection.canEdit(id))
      const cmd = removeObjects(doc, ids)
      if (!cmd) return
      history.apply(cmd)
      selection.clear()
      ui.refreshAll()
    },
    duplicateSelection: () => {
      const made = selection
        .ids()
        .map((id) => {
          const kind = doc.typeOf(id)
          const value = doc.snapshot(id) as unknown as Record<string, unknown> | null
          if (!kind || !value || kind === 'spawn') return null
          const copy: Record<string, unknown> = { ...value, id: newId(kind.slice(0, 2)) }
          const pos = copy['pos']
          if (Array.isArray(pos)) copy['pos'] = [pos[0] + 2, pos[1], pos[2] + 2]
          return { kind, object: copy as never }
        })
        .filter((v): v is NonNullable<typeof v> => v !== null)
      if (made.length === 0) return
      history.apply({
        label: `duplicate ${made.length}`,
        execute: (d) => made.forEach((m) => d.add(m.kind, m.object)),
        undo: (d) => made.forEach((m) => d.remove((m.object as { id: string }).id)),
      })
      selection.replaceMany(made.map((m) => (m.object as { id: string }).id))
      ui.refreshAll()
    },
    setProperty: (ids, key, value) => {
      const editable = ids.filter((id) => connection.canEdit(id))
      if (editable.length === 0) return
      history.apply({ label: `edit ${key}`, ...buildPropertyCommand(doc, editable, key, value) })
      ui.refreshAll()
    },
  })

  // ── Actions ─────────────────────────────────────────────────────────
  const router = new ActionRouter(ACTIONS, bindingOf, (id) => runAction(id))

  const runAction = (action: string): boolean => {
    if (action.startsWith('tool.')) {
      tools.toggle(action.slice(5) as Tool)
      return true
    }
    switch (action) {
      case 'xf.move':
      case 'xf.rotate':
      case 'xf.scale':
        gizmo.setMode(action.slice(3) as GizmoMode)
        ui.refreshStatus()
        return true
      case 'transform.worldLocal':
        prefs.current.space = prefs.current.space === 'world' ? 'local' : 'world'
        applyPreferences()
        return true
      case 'transform.toggleSnap':
        prefs.current.snap.translate.on = !prefs.current.snap.translate.on
        applyPreferences()
        return true
      case 'edit.undo':
        history.undo()
        ui.refreshAll()
        return true
      case 'edit.redo':
        history.redo()
        ui.refreshAll()
        return true
      case 'edit.duplicate':
        ui.duplicate()
        return true
      case 'edit.delete':
        ui.remove()
        return true
      case 'edit.cancel':
        if (xform.active) xform.cancel()
        else if (tools.active) tools.clear()
        else selection.clear()
        ui.refreshAll()
        return true
      case 'edit.save':
        void saveController.save()
        return true
      case 'cam.freelook':
        cameraController.toggleFreeLook()
        return true
      case 'cam.frame': {
        const id = selection.primaryId
        const t = id ? transformOf(doc, id) : null
        if (t) cameraController.frame(new Vector3(...t.position), 6)
        return true
      }
      case 'workspace.outliner':
      case 'workspace.inspector':
        ui.togglePanel(action.slice(10) as 'outliner' | 'inspector')
        return true
      case 'workspace.assets':
      case 'workspace.issues':
      case 'workspace.history':
      case 'workspace.scene':
        ui.showDockTab(action.slice(10))
        return true
      case 'ui.sidebar':
        ui.togglePanel('outliner')
        return true
      case 'ui.settings':
        ui.openSettings()
        return true
      default:
        return false
    }
  }

  window.addEventListener('keydown', (e) => router.keyDown(e))
  window.addEventListener('keyup', (e) => router.keyUp(e))
  window.addEventListener('blur', () => router.clear())

  tools.subscribe(() => {
    placement.resetYaw()
    refreshPivot()
    ui.refreshTools()
    refreshVisuals()
  })

  // ── Frame loop ──────────────────────────────────────────────────────
  let frameTick = 0
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000
    env.update(dt, camera.position)
    if (interaction.flightAllowed()) {
      const m = router.movement()
      if (m.x !== 0 || m.y !== 0 || m.z !== 0)
        cameraController.fly(m.z, m.x, m.y, (m.fast ? 34 : 11) * dt)
    }

    const tool = tools.active
    const sculpting = tool === 'terrain' || tool === 'paint'
    if (sculpting) {
      const hit = viewport.pickPoint()
      if (hit) {
        brushCursor.setEnabled(true)
        brushCursor.position.copyFrom(hit.point)
        const r = brushSettings().radius
        brushCursor.scaling.set(r * 2, r * 2, r * 2)
      } else brushCursor.setEnabled(false)
    } else brushCursor.setEnabled(false)

    if (tool === 'mesh' || tool === 'entity') {
      const def = activePlaceable()
      placement.updatePreview(def, `${tool}:${def?.name ?? ''}`)
    }

    // Hover highlight, every sixth frame — a full pick per frame is the
    // single most expensive thing this loop could do.
    if (interaction.pickingAllowed() && ++frameTick % 6 === 0) {
      const next =
        tool === null || tool === 'select' || tool === 'terrain'
          ? viewport.pickIdAt(scene.pointerX, scene.pointerY)
          : null
      if (next !== hoverId) {
        hoverId = next
        refreshVisuals()
      }
    }
  })

  engine.runRenderLoop(() => scene.render())
  window.addEventListener('resize', () => engine.resize())
  // The canvas fills a grid cell, so dragging a panel resizes it too.
  new ResizeObserver(() => engine.resize()).observe(shell.viewport)

  ui.refreshAll()
  connection.connect()
  // Offer any unsaved work from a previous session. Never automatic: a
  // crash recovering itself into everyone else's world would be worse than
  // losing it, so this restores locally and leaves the map dirty.
  void saveController.restoreDraftIfAny()

  // ── Probe (harness only; NOT a public API) ──────────────────────────
  ;(window as unknown as { __editor: unknown }).__editor = {
    selectionIds: () => selection.ids(),
    primaryId: () => selection.primaryId,
    interactionState: () => interaction.state,
    gizmoState: () => ({
      mode: gizmo.currentMode,
      attached: gizmo.active,
      dragging: xform.active,
    }),
    gizmoHandleScreenPos: (axis: 'x' | 'y' | 'z') => {
      // The spiral search works in CANVAS space (it picks the utility
      // layer); the harness needs page coordinates to move a real mouse.
      const canvasPoint = gizmo.handleScreenPoint(axis, (p) => {
        const [px, py] = cameraController.worldToScreen(p)
        return cameraController.toCanvasSpace(px, py)
      })
      if (!canvasPoint) return null
      const rect = canvas.getBoundingClientRect()
      return [Math.round(canvasPoint[0] + rect.left), Math.round(canvasPoint[1] + rect.top)]
    },
    cameraSnapshot: () => ({
      pos: [camera.position.x, camera.position.y, camera.position.z],
      rot: [camera.rotation.x, camera.rotation.y, camera.rotation.z],
    }),
    history: () => ({ depth: history.depth, redo: history.redoDepth }),
    terrainWires: () => {
      const out: Record<string, boolean> = {}
      for (const t of doc.listByKind('terrain')) {
        const v = views.viewOf(t.id)
        if (v instanceof TerrainView) out[t.id] = v.wireVisible()
      }
      return out
    },
    faceSelKeys: () => faceSelection.keys(),
    faceOverlayCount: () => faceOverlays.count,
    // The harness works in page coordinates, like a real cursor does.
    pickIdAt: (x: number, y: number) => viewport.pickIdAt(...cameraController.toCanvasSpace(x, y)),
    surfaceMaterialOf: (id: string) => {
      const v = views.viewOf(id)
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
    paintSurface: () => (strokeTargetId ? { objectId: strokeTargetId } : null),
    setPaintTexture: (tex: string) => {
      ;(document.getElementById('paint-tex') as HTMLSelectElement).value = tex
    },
    setPaintColor: (hex: string) => {
      ;(document.getElementById('paint-color') as HTMLInputElement).value = hex
    },
    setInspectorTexture: (tex: string) => {
      const id = selection.primaryId
      if (!id) return
      const v = views.viewOf(id)
      if (v instanceof TerrainView) {
        const data = structuredClone(v.surfaceData())
        data.base = { ...data.base, tex }
        const cmd = setProperties(doc, id, { surface: data }, 'set base texture')
        if (cmd) history.apply(cmd)
      } else {
        const cmd = setProperties(doc, id, { tex }, 'set texture')
        if (cmd) history.apply(cmd)
      }
      ui.refreshAll()
    },
    terrainIds: () => doc.listByKind('terrain').map((t) => t.id),
    transformOf: (id: string) => {
      const t = transformOf(doc, id)
      return t ? { position: t.position, rotation: t.rotation } : null
    },
    worldToScreen: (p: [number, number, number]) =>
      cameraController.worldToScreen(new Vector3(p[0], p[1], p[2])),
    setToolByName: (t: string) => tools.set(t as Tool),
    selectByIds: (ids: string[]) => selection.replaceMany(ids),
    undo: () => {
      history.undo()
      ui.refreshAll()
    },
    redo: () => {
      history.redo()
      ui.refreshAll()
    },
    setCameraPose: (pos: number[], rot: number[]) => {
      camera.position.set(pos[0]!, pos[1]!, pos[2]!)
      camera.rotation.set(rot[0]!, rot[1]!, rot[2]!)
    },
    objectCounts: () => ({
      statics: doc.listByKind('static').length,
      terrains: doc.listByKind('terrain').length,
      nodes: doc.listByKind('node').length,
      props: doc.listByKind('prop').length,
      lights: doc.listByKind('light').length,
      zones: doc.listByKind('zone').length,
    }),
    terrainMeshCount: () => doc.listByKind('terrain').length,
    sceneMeshNames: () => scene.meshes.map((m) => m.name),
    get dirty() {
      return saveController.isDirty()
    },
    get tool() {
      return tools.active
    },
    groupMove: (dx: number, dy: number, dz: number) => {
      const started = xform.begin(selection.ids(), 'move', { label: 'group move' })
      if (!started) return
      const p = started.pivotStart
      xform.update({
        ...p,
        position: [p.position[0] + dx, p.position[1] + dy, p.position[2] + dz],
      })
      xform.commit()
      refreshPivot()
      ui.refreshAll()
    },
    hasSky: () => scene.meshes.some((m) => m.name.includes('sky') || m.name.includes('cloud')),
  }
}

/**
 * Turn an inspector edit into a command. Vector components arrive as
 * `pos[1]`, and nested rule flags as `rules.pvp`, so both are written back
 * into a whole-object replacement — which is also what makes undo restore an
 * absent key rather than a zeroed one.
 */
function buildPropertyCommand(
  doc: EditorDocument,
  ids: readonly string[],
  key: string,
  value: unknown,
): { execute: (d: EditorDocument) => void; undo: (d: EditorDocument) => void } {
  const before = new Map(ids.map((id) => [id, doc.snapshot(id)]))
  const after = new Map(
    ids.map((id) => {
      const copy = structuredClone(doc.snapshot(id)) as Record<string, unknown> | null
      if (copy) writePath(copy, key, value)
      return [id, copy]
    }),
  )
  return {
    execute: (d) => {
      for (const [id, v] of after) if (v && d.has(id)) d.replace(id, structuredClone(v) as never)
    },
    undo: (d) => {
      for (const [id, v] of before) if (v && d.has(id)) d.replace(id, structuredClone(v) as never)
    },
  }
}

const INDEXED = /^(.+)\[(\d+)\]$/

function writePath(target: Record<string, unknown>, key: string, value: unknown): void {
  const indexed = INDEXED.exec(key)
  if (indexed) {
    const arr = target[indexed[1]!]
    if (Array.isArray(arr)) arr[Number(indexed[2])] = value
    return
  }
  const parts = key.split('.')
  let node: Record<string, unknown> = target
  for (const part of parts.slice(0, -1)) {
    const next = node[part]
    if (next === null || typeof next !== 'object') return
    node = next as Record<string, unknown>
  }
  const last = parts[parts.length - 1]!
  if (value === undefined) delete node[last]
  else node[last] = value
}
