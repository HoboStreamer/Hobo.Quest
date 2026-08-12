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
  createContent,
  emptyMapV2,
  parseMapFile,
  setMapOverride,
  type MapFileV2,
  type MapTextureEntry,
} from '@hobo/content'
import { Environment } from '../render/environment.js'
import { registerCustomTextures } from '../render/mapStyle.js'
import { ModelCache } from '../render/modelCache.js'
import { AssetController } from './assets/assetController.js'
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
import {
  PaintController,
  surfaceDataFor,
  writeSurfaceData,
  type PaintHit,
} from './materials/paintController.js'
import { PaintSurfaceRegistry } from './materials/paintSurfaceRegistry.js'
import { buildShell } from './ui/editorShell.js'
import { createEditorUi } from './ui/editorUi.js'
import { createSaveController } from './net/saveController.js'
import { ActionRouter } from './input/actionRouter.js'
import { ACTIONS, loadBindings, type Binding } from './bindings.js'

const content = createContent()

/**
 * A readable name for other editors, remembered across sessions. Anonymous
 * "editor / editor / editor" in a lock badge tells nobody which tab to go
 * and ask.
 */
function defaultEditorName(): string {
  const stored = localStorage.getItem('hobo.editor.name')
  if (stored) return stored
  const minted = `editor-${Math.random().toString(36).slice(2, 6)}`
  try {
    localStorage.setItem('hobo.editor.name', minted)
  } catch {
    // Private mode: a per-session name is still better than none.
  }
  return minted
}

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

  const paintSurfaces = new PaintSurfaceRegistry(scene)

  const views: EditorViewRegistry = new EditorViewRegistry(
    doc,
    createViewFactory({
      scene,
      content,
      modelCache,
      wireMat,
      sampleGround,
      modelSource: (id) => doc.modelById(id)?.glb ?? null,
      maskFor: (ownerId, surfaceId, data) =>
        paintSurfaces.ensure(ownerId, surfaceId, data).mask.texture,
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
  const paint = new PaintController({ scene, doc, views, registry: paintSurfaces, newId })

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
    models: () => doc.models(),
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
      const ids = selection.ids().filter((id) => transformOf(doc, id) !== null)
      // A transform cannot begin unless the server has granted every member.
      // If the request is still in flight, the drag simply does not start —
      // mutating optimistically is what a lock is meant to prevent.
      let allowed = false
      withLock(ids, () => {
        allowed = true
      })
      if (!allowed) ui.setMessage('🔒 waiting for the edit lock — try again in a moment')
      return allowed && startTransform(mode)
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

  const startTransform = (mode: GizmoMode): boolean => {
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
  }

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

  /**
   * The gate every mutation goes through.
   *
   * "Nobody else holds it" is NOT permission — that is exactly how a
   * server-authoritative lock system ends up never being acquired, with both
   * editors deciding they may proceed and the arbitration never running. A
   * mutation happens only once the server has actually granted the lock.
   *
   * Returns true when the caller may proceed NOW. Otherwise it has either
   * requested the lock (and `then` will run on the grant) or reported why
   * not.
   */
  const withLock = (ids: readonly string[], then: () => void): boolean => {
    const wanted = ids.filter((id) => doc.has(id))
    if (wanted.length === 0) return false
    // No session means nobody to arbitrate with. Refusing to edit offline
    // would make the editor unusable without a collaboration token, and
    // there is no one whose work could be trampled.
    if (!connection.connected() || connection.ownsAll(wanted)) {
      then()
      return true
    }
    const blocked = wanted.find((id) => connection.isLockedByOther(id))
    if (blocked !== undefined) {
      ui.setMessage(
        `🔒 ${blocked} is being edited by ${connection.lockOwner(blocked) ?? 'someone'}`,
      )
      return false
    }
    // All-or-nothing: a group edit that could only move half its members is
    // worse than one that does not start.
    connection.acquire(wanted, then)
    return false
  }

  /**
   * Locks follow the selection, and are given back when it shrinks.
   *
   * The COMPLETE selected edit set is requested atomically rather than
   * "whatever happens to be free": a group whose members are half locked
   * cannot be transformed anyway, and granting the free half would leave a
   * collaborator blocked on objects this editor can do nothing with.
   */
  let lockedForSelection: string[] = []
  const syncSelectionLocks = (): void => {
    const wanted = selection.ids().filter((id) => doc.has(id))
    const dropped = lockedForSelection.filter((id) => !wanted.includes(id))
    if (dropped.length > 0) connection.release(dropped)
    lockedForSelection = wanted
    // Selecting is intent to edit; hovering is not, and never acquires.
    if (wanted.length > 0) connection.acquire(wanted)
  }

  selection.onChange(() => {
    refreshPivot()
    refreshVisuals()
    ui.refreshSelection()
    connection.sendSelection(selection.ids())
    syncSelectionLocks()
  })

  /** Remote selections grouped by peer, for the highlight layer. */
  const remoteSelectionGroups = (): Map<number, { color: Color3; ids: string[] }> => {
    const out = new Map<number, { color: Color3; ids: string[] }>()
    for (const peer of connection.peers())
      out.set(peer.peerId, {
        color: Color3.FromHexString(peer.color),
        ids: peer.selection,
      })
    return out
  }

  let hoverId: string | null = null
  const refreshVisuals = (): void => {
    visuals.refresh({
      ids: selection.ids(),
      primary: selection.primaryId,
      hover: hoverId,
      remote: remoteSelectionGroups(),
      locks: connection.lockColors(),
      terrainHoverWire:
        tools.is('terrain') && hoverId && doc.typeOf(hoverId) === 'terrain' ? hoverId : null,
      strokeWire: strokeTargetId,
    })
  }

  // ── Terrain + paint strokes ─────────────────────────────────────────
  let strokeTargetId: string | null = null
  let strokeBefore: Float32Array | null = null
  /** The (object, surface) a paint stroke is committed to, for its duration. */
  let paintStrokeKey: string | null = null
  let paintStrokeHit: PaintHit | null = null

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
      // The press is edit intent: acquire BEFORE the first height changes,
      // and drop the dab if the lock is not ours yet.
      let allowed = false
      withLock([target.id], () => {
        allowed = true
      })
      if (!allowed) return
      strokeTargetId = target.id
      strokeBefore = target.view.heights.slice()
      refreshVisuals()
    }
    const mode = (document.getElementById('terrain-mode') as HTMLSelectElement).value as SculptMode
    sculptDab(target.view, target.local.x, target.local.z, sign, mode, brushSettings())
    target.view.refreshHeights()
  }

  /**
   * One brush dab, on whatever is under the cursor. The controller resolves
   * the pick to (object, surface) and the UV in that surface's mask, so this
   * is the same code for terrain, a box face, a cylinder and a model slot.
   */
  const paintAt = (): void => {
    const brush = brushSettings()
    const hit = paint.hitTest(brush.radius)
    if (!hit) return
    const key = `${hit.ownerId} ${hit.surfaceId}`
    if (paintStrokeKey && key !== paintStrokeKey) return // one surface per stroke
    let allowed = false
    withLock([hit.ownerId], () => {
      allowed = true
    })
    if (!allowed) return

    const tex = (document.getElementById('paint-tex') as HTMLSelectElement).value || 'none'
    const color = (document.getElementById('paint-color') as HTMLInputElement).value.toLowerCase()
    const tint = tex === 'none' || color !== '#ffffff' ? color : undefined
    const layer = paint.ensureLayer(hit, tex, tint)
    if (!layer) {
      ui.setMessage(`⛔ all ${paint.layerBudget} paint layers are in use — remove one first`)
      return
    }
    if (!paintStrokeKey) {
      paintStrokeKey = key
      paintStrokeHit = hit
      strokeTargetId = hit.ownerId
      hit.state.mask.beginStroke()
      refreshVisuals()
    }
    hit.state.mask.stamp(layer.channel as never, {
      u: hit.uv.u,
      v: hit.uv.v,
      radius: hit.uv.radiusPixels,
      strength: Math.min(1, brush.strength),
      feather: brush.feather,
      erase: (document.getElementById('paint-erase') as HTMLInputElement).checked,
    })
    // The surface may have just gained its first layer; re-read the material.
    views.viewOf(hit.ownerId)?.update(doc.get(hit.ownerId)!, ['surface'])
  }

  const endStroke = (): void => {
    if (tools.is('paint')) {
      strokeTargetId = null
      endPaintStroke()
      return
    }
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
    refreshVisuals()
    ui.refreshAll()
  }

  /** Finish a paint stroke: one history entry holding the mask delta. */
  const endPaintStroke = (): void => {
    const hit = paintStrokeHit
    paintStrokeKey = null
    paintStrokeHit = null
    if (!hit) return
    const patch = hit.state.mask.endStroke()
    if (!patch) return
    // The document keeps a self-contained mask at all times — an export, a
    // draft or a validation run must never see "paint layers without a
    // mask". Save replaces it with the hosted URL, and only for surfaces
    // that actually changed.
    const data = surfaceDataFor(doc, hit.ownerId, hit.surfaceId)
    writeSurfaceData(doc, hit.ownerId, hit.surfaceId, {
      ...data,
      paint: { ...(data.paint ?? { layers: [] }), mask: hit.state.mask.toDataURL() },
    })
    paintSurfaces.markDirty(hit.ownerId, hit.surfaceId)
    history.record(
      paintStroke(
        hit.ownerId,
        hit.surfaceId,
        patch.before,
        patch.after,
        (ownerId, surfaceId, p) => {
          const state = paintSurfaces.peek(ownerId, surfaceId)
          if (!state) return
          state.mask.applyPatch(p)
          const d = surfaceDataFor(doc, ownerId, surfaceId)
          writeSurfaceData(doc, ownerId, surfaceId, {
            ...d,
            paint: { ...(d.paint ?? { layers: [] }), mask: state.mask.toDataURL() },
          })
          paintSurfaces.markDirty(ownerId, surfaceId)
          views.viewOf(ownerId)?.update(doc.get(ownerId)!, ['surface'])
        },
      ),
    )
    refreshVisuals()
    ui.refreshAll()
  }

  // ── Placement ───────────────────────────────────────────────────────
  const activePlaceable = (): Placeable | null => {
    // An armed imported model wins until something else is chosen.
    if (armedModelId !== null && tools.is('mesh')) {
      const armed = importedPlaceables.get(armedModelId)
      if (armed && doc.modelById(armedModelId)) return armed
      armedModelId = null
    }
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
    const made = objectForPlacement(def, pose, doc.models())
    if (!made) return
    // Spawn is a singleton: placing it again moves the one that exists.
    if (made.kind === 'spawn' && doc.has('spawn')) {
      const cmd = setProperties(doc, 'spawn', made.object, 'move spawn')
      if (cmd) history.apply(cmd)
    } else {
      history.apply(addObject(made.kind, made.object as never, `place ${made.kind}`))
    }
    selection.replace(String(made.object['id']))
    // One click places one model; picking again is deliberate.
    armedModelId = null
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
    onAdopt: (map) => {
      doc.replaceFromRemote(map)
      registerCustomTextures(doc.textures() as MapTextureEntry[])
      history.rebase()
      selection.retain((id) => doc.has(id))
      ui.refreshAll()
    },
    paintSurfaces,
    setMessage: (m) => ui.setMessage(m),
  })

  const { createEditorConnection } = await import('./collaboration/editorConnection.js')
  const connection = createEditorConnection({
    scene,
    peersEl: document.getElementById('peers') as HTMLElement,
    camera,
    keyOf: () => (document.getElementById('key') as HTMLInputElement).value.trim(),
    nameOf: defaultEditorName,
    onRemoteSaved: () => void saveController.pollRemote(),
    onLockDenied: (owner) => ui.setMessage(`🔒 held by ${owner} — you have read-only access`),
    onChange: () => {
      refreshVisuals()
      ui.refreshAll()
    },
    onLockLost: () => {
      // The lease went away mid-gesture: restore the exact starting state
      // rather than leaving half-applied local edits the server disagrees
      // with.
      if (xform.active) xform.cancel()
      selection.unfreeze()
      lockedForSelection = []
      ui.setMessage('⚠ edit lock lost — reselect to reacquire')
    },
  })

  // ── UI ──────────────────────────────────────────────────────────────
  const bindings = loadBindings(localStorage.getItem('hobo.editor.bindings'))
  const bindingOf = (action: string): Binding => bindings[action] ?? { code: 'F24' }

  const assets = new AssetController({
    doc,
    history,
    modelCache,
    editorKey: () => (document.getElementById('key') as HTMLInputElement).value.trim(),
    onAssetsChanged: () => {
      registerCustomTextures(doc.textures() as MapTextureEntry[])
      ui.refreshAll()
    },
    setMessage: (m) => ui.setMessage(m),
  })

  /**
   * Arm the Geometry tool with an imported model, so "Place" in the Asset
   * browser actually places it.
   */
  const placeModel = (modelId: string): void => {
    const model = doc.modelById(modelId)
    if (!model) return
    importedPlaceables.set(modelId, {
      name: `🗿 ${model.name}`,
      kind: 'model',
      modelId,
    })
    armedModelId = modelId
    tools.set('mesh')
    ui.setMessage(`🗿 "${model.name}" armed — click in the viewport to place it`)
  }
  /** Placeables minted from imported models, keyed by model id. */
  const importedPlaceables = new Map<string, Placeable>()
  let armedModelId: string | null = null

  const ui = createEditorUi({
    shell,
    assets,
    placeModel,
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
    onPreferences: applyPreferences,
    focusObject: (id) => {
      selection.replace(id)
      const t = transformOf(doc, id)
      if (t) cameraController.frame(new Vector3(...t.position), 6)
    },
    deleteSelection: () => {
      const ids = selection.ids()
      withLock(ids, () => {
        const cmd = removeObjects(doc, ids)
        if (!cmd) return
        history.apply(cmd)
        selection.clear()
        ui.refreshAll()
      })
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
      withLock(ids, () => {
        history.apply({ label: `edit ${key}`, ...buildPropertyCommand(doc, [...ids], key, value) })
        ui.refreshAll()
      })
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

  // Seed the credential from the last session so collaboration connects on
  // boot rather than only after someone retypes the token. Changing it
  // reconnects deliberately — the socket must not stay authenticated as
  // whoever was there before.
  const keyInput = document.getElementById('key') as HTMLInputElement
  keyInput.value = localStorage.getItem('hobo.editorkey') ?? ''
  keyInput.addEventListener('change', () => {
    localStorage.setItem('hobo.editorkey', keyInput.value.trim())
    connection.connect()
  })
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
      // Goes through the SAME gate the gizmo does. A probe that could move
      // an object the server has not granted would make the collaboration
      // suite prove nothing.
      const ids = selection.ids().filter((id) => transformOf(doc, id) !== null)
      let allowed = false
      withLock(ids, () => {
        allowed = true
      })
      if (!allowed) return
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
    /** Collaboration state, for the two-editor acceptance suite. */
    collab: () => ({
      connected: connection.connected(),
      peerId: connection.myPeerId(),
      peers: connection.peers().map((p) => ({ ...p, selection: [...p.selection] })),
      peerCount: connection.peerCount(),
      lockOwners: Object.fromEntries(connection.lockOwners()),
      owns: selection.ids().filter((id) => connection.owns(id)),
    }),
    inspectorLockedBy: () =>
      selection.primaryId ? connection.lockOwner(selection.primaryId) : null,
    setProperty: (ids: string[], key: string, value: unknown) => ui.setProperty(ids, key, value),
    deleteSelection: () => ui.remove(),
    colorOf: (id: string) => (doc.get(id) as { color?: string } | null)?.color ?? null,
    /** Asset metadata straight from the document (no parallel array). */
    assetState: () => ({
      textures: doc.textures().map((t) => ({ name: t.name, url: t.url ?? null })),
      models: doc.models().map((m) => ({ id: m.id, name: m.name, glb: m.glb })),
      textureUsage: Object.fromEntries(
        [...assets.textureUsage()].map(([ref, u]) => [ref, u.count]),
      ),
      modelUsage: Object.fromEntries([...assets.modelUsage()].map(([id, u]) => [id, u.count])),
    }),
    importTextureBytes: async (name: string, bytes: number[]) => {
      const file = new File([new Uint8Array(bytes)], name, { type: 'image/png' })
      return assets.importTexture(file)
    },
    renameTexture: (from: string, to: string) => assets.renameTexture(from, to),
    deleteTexture: (name: string) => assets.deleteTexture(name),
    textureRefsOf: (id: string) => JSON.stringify(doc.get(id) ?? null),
    /** Painted surfaces of an object, keyed by surface id (paint E2E). */
    paintedSurfaces: (id: string) => {
      const o = doc.get(id) as {
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
    maskUploadCount: () => saveController.maskUploadCount(),
    save: () => saveController.save(),
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
