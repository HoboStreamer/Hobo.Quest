import { Engine } from '@babylonjs/core/Engines/engine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js'
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager.js'
import { TerrainMaterial } from '@babylonjs/materials/terrain/terrainMaterial.js'
import '@babylonjs/core/Culling/ray.js'
import '@babylonjs/core/Rendering/outlineRenderer.js'
import {
  buildPatchGrid,
  buildTerrainGrid,
  createContent,
  decodeHeights,
  encodeHeights,
  setMapOverride,
  type FaceStyle,
  type MapLight,
  type MapTextureEntry,
  MAX_PAINT_LAYERS,
  allocateLayer,
  migrateLegacyMix,
  removeLayer,
  type PaintLayer,
  type SurfaceMaterialData,
  validateSurface,
  emptyMapV2,
  parseMapFile,
  type MapFileV2,
  type MapLightV2,
  type MapNodeV2,
  type MapPropV2,
  type MapZoneV2,
  type StaticObjectV2,
} from '@hobo/content'
import { HighlightLayer } from '@babylonjs/core/Layers/highlightLayer.js'
import { meshForShape } from '../render/sceneSetup.js'
import { Environment } from '../render/environment.js'
import {
  LIGHT_DEFAULTS,
  applyStaticStyle,
  instantiateMapLight,
  prettyTexName,
  registerCustomTextures,
} from '../render/mapStyle.js'
import {
  createTexPicker,
  downscaleImage,
  makeScrubbable,
  scrubAllNumbers,
  type TexOption,
} from './ui.js'
import { InteractionController } from './interaction/interactionController.js'
import { CommandHistory } from './history/commandHistory.js'
import { TransformSession, type TransformAccessor } from './viewport/transformSession.js'
import {
  centroidOf,
  eulerOf,
  transformFromEuler,
  type EditorTransform,
} from './viewport/transformMath.js'
import { EditorPicker, type MeshOwner } from './interaction/editorPicker.js'
import { SelectionManager, selectModeFromEvent } from './selection/selectionManager.js'
import { FaceOverlayManager, FaceSelection } from './selection/faceSelection.js'
import { LayeredSurfaceMaterial } from '../render/layeredSurface.js'
import { PaintMask } from './materials/paintMask.js'
import { ACTIONS, bindingMatches, formatBinding, loadBindings, type Binding } from './bindings.js'

/**
 * Hobo.Quest map editor (/editor): the world ships as a blank floor and
 * EVERYTHING is authored here — sculpt the heightfield, paint the splat,
 * place statics and resource nodes, then save; the game applies it live.
 *
 * Editing model: every tool mutates one MapFile-shaped state with full
 * undo/redo, and co-editors are live on a presence channel (floating
 * eyeballs) with instant merge on every save.
 */

const content = createContent()
const world = content.world
const HALF = world.groundHalfExtent
const SUB = 128
const MIX = 512

import {
  ENTITY_DEFS,
  NODE_LOOKS,
  PLACEABLES,
  TEXTURES,
  newId,
  type Placeable,
  type Tool,
} from './catalog.js'
import type { PatchState, UndoOp } from './document/editorTypes.js'
import { createSettingsPanel } from './ui/settingsPanel.js'
import { PeerAvatars } from './collaboration/peerAvatars.js'
import { createIssuesPanel, type EditorIssue } from './ui/issuesPanel.js'
import { ModelCache } from './assets/modelCache.js'

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const engine = new Engine(canvas, true)
  const scene = new Scene(engine)
  scene.clearColor = new Color4(0.45, 0.58, 0.72, 1)
  // The game's full sky: Preetham dome + drifting clouds + moon + flares +
  // day/night lighting. The editor shares it so lighting previews match.
  const env = new Environment(scene, engine)
  env.setDayFraction(0.35)

  // ── Camera: WASD+QE fly; Z toggles pointer-locked free-look ─────────
  const camera = new FreeCamera('cam', new Vector3(0, 45, -55), scene)
  camera.setTarget(new Vector3(0, 0, 0))
  camera.minZ = 0.1
  env.attachCamera(camera)
  // No Babylon camera inputs at all — the editor's action system drives
  // flight, and pointer handlers below drive orbit/pan/zoom. Nothing to
  // fight with, everything remappable.
  camera.inputs.clear()
  let freeLook = false
  document.addEventListener('pointerlockchange', () => {
    freeLook = document.pointerLockElement === canvas
  })
  // MMB navigation with POINTER CAPTURE: the drag keeps working even when
  // the cursor leaves the canvas, and browser autoscroll never fires.
  let mmb: 'orbit' | 'pan' | null = null
  let lastMX = 0
  let lastMY = 0
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault()
  })
  canvas.addEventListener('auxclick', (e) => e.preventDefault())
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 1) {
      e.preventDefault()
      // The camera is a gesture like any other: it must claim the pointer,
      // and it cannot start while a gizmo/brush gesture owns it.
      const want = holding('cam.pan') || e.shiftKey ? 'pan' : 'orbit'
      if (
        !interaction.begin(want === 'pan' ? 'camera-pan' : 'camera-orbit', {
          x: e.clientX,
          y: e.clientY,
          pointerId: e.pointerId,
        })
      )
        return
      mmb = want
      lastMX = e.clientX
      lastMY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
  })
  canvas.addEventListener('pointerup', (e) => {
    if (e.button === 1) {
      if (mmb) interaction.end()
      mmb = null
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    }
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!mmb || !interaction.cameraMayMove()) return
    const dx = e.clientX - lastMX
    const dy = e.clientY - lastMY
    lastMX = e.clientX
    lastMY = e.clientY
    if (mmb === 'orbit') {
      camera.rotation.y += dx * 0.0038
      camera.rotation.x = Math.max(-1.5, Math.min(1.5, camera.rotation.x + dy * 0.0038))
    } else {
      const right = camera.getDirection(new Vector3(1, 0, 0))
      const up = camera.getDirection(new Vector3(0, 1, 0))
      camera.position.addInPlace(right.scale(-dx * 0.05))
      camera.position.addInPlace(up.scale(dy * 0.05))
    }
  })
  canvas.addEventListener('mousemove', (e) => {
    if (freeLook && interaction.cameraMayMove()) {
      camera.rotation.y += e.movementX * 0.0032
      camera.rotation.x = Math.max(-1.5, Math.min(1.5, camera.rotation.x + e.movementY * 0.0032))
    }
  })

  // ── Load the map ────────────────────────────────────────────────────
  // /map.json is native v2. parseMapFile migrates a legacy v1 artifact on
  // the way in, so the editor only ever holds v2 — and a missing or invalid
  // map is emptyMapV2(), NOT a fabricated starter heightfield.
  const bootResp = await fetch('/map.json')
  const bootRevision = bootResp.headers.get('etag')?.replace(/"/g, '') ?? ''
  const bootParsed = parseMapFile(await bootResp.json().catch(() => null))
  const bootDoc: MapFileV2 = bootParsed.ok ? bootParsed.map : emptyMapV2()
  if (!bootParsed.ok && bootParsed.issues.length > 0)
    console.warn('[editor] map rejected, starting empty:', bootParsed.issues.slice(0, 5))
  // Ids are guaranteed by `parseMapFile` (see `normalizeMapIds`): every
  // editable object arrives with stable document identity, so nothing here
  // has to invent one after the fact.
  let placedStatics: StaticObjectV2[] = bootDoc.statics
  let placedNodes: MapNodeV2[] = bootDoc.nodes
  // The legacy top-level heightfield is gone: every terrain is an ordinary
  // object in `patches` below. This buffer only feeds the old main-terrain
  // mesh, which is retired — it stays flat and disabled.
  const heights: Float32Array = new Float32Array((SUB + 1) * (SUB + 1)).fill(-6)
  const savedMix: string | undefined = undefined

  // ── Terrain mesh (game-proven winding) + hover wireframe overlay ────
  // The runtime override carries TERRAIN OBJECTS only — there is no
  // top-level heightfield any more. The editor keeps its own `patches` in
  // sync through refreshGroundSampling() below.
  setMapOverride({ terrains: [] })
  const grid = buildTerrainGrid(world)
  const terrain = new Mesh('terrain', scene)
  const vd = new VertexData()
  vd.positions = grid.positions
  vd.indices = grid.indices
  vd.uvs = grid.uvs
  const normals: number[] = []
  VertexData.ComputeNormals(grid.positions, grid.indices, normals)
  vd.normals = normals
  vd.applyToMesh(terrain, true)
  terrain.isPickable = true
  const cell = (HALF * 2) / SUB

  const wire = new Mesh('wire', scene)
  vd.applyToMesh(wire, true)
  const wireMat = new StandardMaterial('wiremat', scene)
  wireMat.wireframe = true
  wireMat.emissiveColor = new Color3(0.35, 0.75, 1)
  wireMat.alpha = 0.16
  wireMat.disableLighting = true
  wire.material = wireMat
  wire.isPickable = false
  wire.position.y = 0.03
  wire.parent = terrain
  wire.setEnabled(false)

  // ── Splat paint ─────────────────────────────────────────────────────
  const mixTex = new DynamicTexture('mix', MIX, scene, false)
  const mixCtx = mixTex.getContext() as CanvasRenderingContext2D
  if (savedMix) {
    const img = new Image()
    img.onload = () => {
      mixCtx.drawImage(img, 0, 0, MIX, MIX)
      mixTex.update()
    }
    img.src = savedMix
  } else {
    mixCtx.fillStyle = '#ff0000'
    mixCtx.fillRect(0, 0, MIX, MIX)
    mixTex.update()
  }
  const mat = new TerrainMaterial('terrain', scene)
  mat.mixTexture = mixTex
  const tile = (n: string, s: number) => {
    const tx = new Texture(`/assets/tex/${n}.jpg`, scene)
    tx.uScale = tx.vScale = s
    return tx
  }
  mat.diffuseTexture1 = tile('leafy_grass', 70)
  mat.diffuseTexture2 = tile('gray_rocks', 55)
  mat.diffuseTexture3 = tile('brown_mud_dry', 60)
  mat.specularColor = new Color3(0.02, 0.02, 0.02)
  terrain.material = mat

  // ── Placed objects (statics + node stand-ins) ───────────────────────
  const modelCache = new ModelCache(scene)
  const staticMeshes = new Map<Mesh, StaticObjectV2>()
  const nodeMeshes = new Map<Mesh, MapNodeV2>()
  const applyBodyToMesh = (mesh: Mesh, s: Omit<StaticObjectV2, 'id'>): void => {
    mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
    mesh.rotationQuaternion = null
    if (s.rot) mesh.rotation.set(s.rot[0], s.rot[1], s.rot[2])
    else mesh.rotation.set(0, s.yaw, 0)
  }
  const renderStatic = (s: StaticObjectV2): Mesh => {
    const mesh = meshForShape(scene, `s:${Math.random()}`, s.shape, s.color)
    applyStaticStyle(scene, mesh, s) // textures + per-face styles render here too
    applyBodyToMesh(mesh, s)
    staticMeshes.set(mesh, s)
    if (s.model) {
      const model = mapModels.find((mm) => mm.id === s.model)
      if (model) {
        // Parsed once and instanced per placement (see assets/modelCache.ts).
        void modelCache.instantiate(model.id, model.glb).then((inst) => {
          if (!inst) return
          if (!staticMeshes.has(mesh)) {
            inst.dispose()
            return
          }
          inst.root.parent = mesh
          mesh.visibility = 0.12 // faint proxy so it stays selectable
          // Child meshes never absorb picks; EditorPicker resolves the owner
          // through the parent chain instead.
          for (const m of inst.root.getChildMeshes()) m.isPickable = false
          mesh.onDisposeObservable.addOnce(() => inst.dispose())
        })
      }
    }
    return mesh
  }
  const propMeshes = new Map<Mesh, MapPropV2>()
  const renderProp = (pr: MapPropV2): Mesh => {
    const rep = content.worldRepOf(pr.item)
    const mesh = meshForShape(scene, `pr:${Math.random()}`, rep.shape, rep.color)
    const h =
      rep.shape.type === 'box'
        ? rep.shape.size[1]
        : rep.shape.type === 'cylinder'
          ? rep.shape.height
          : rep.shape.radius * 2
    mesh.position.set(pr.pos[0], pr.pos[1] + sampleH(pr.pos[0], pr.pos[2]) + h / 2, pr.pos[2])
    mesh.rotation.y = pr.yaw ?? 0
    propMeshes.set(mesh, pr)
    return mesh
  }
  const renderNode = (n: MapNodeV2): Mesh => {
    const look = NODE_LOOKS[n.node] ?? {
      color: '#888888',
      shape: { type: 'sphere', radius: 0.6 } as const,
    }
    const mesh = meshForShape(scene, `n:${Math.random()}`, look.shape, look.color)
    const h =
      look.shape.type === 'box'
        ? look.shape.size[1]
        : look.shape.type === 'cylinder'
          ? look.shape.height
          : look.shape.radius * 2
    mesh.position.set(n.pos[0], n.pos[1] + sampleH(n.pos[0], n.pos[2]) + h / 2, n.pos[2])
    nodeMeshes.set(mesh, n)
    return mesh
  }
  const sampleH = (x: number, z: number): number => {
    const i = Math.max(0, Math.min(SUB, Math.round((x + HALF) / cell)))
    const j = Math.max(0, Math.min(SUB, Math.round((z + HALF) / cell)))
    let h = heights[j * (SUB + 1) + i] ?? 0
    for (const pp of patches) {
      if (pp.rot && (Math.abs(pp.rot[0]) > 0.02 || Math.abs(pp.rot[2]) > 0.02)) continue
      const lx = x - pp.origin[0]
      const lz = z - pp.origin[2]
      if (Math.abs(lx) > pp.halfExtent || Math.abs(lz) > pp.halfExtent) continue
      const pc = (pp.halfExtent * 2) / pp.sub
      const pi = Math.max(0, Math.min(pp.sub, Math.round((lx + pp.halfExtent) / pc)))
      const pj = Math.max(0, Math.min(pp.sub, Math.round((lz + pp.halfExtent) / pc)))
      const ph = (pp.heights[pj * (pp.sub + 1) + pi] ?? 0) + pp.origin[1]
      if (ph > h) h = ph
    }
    return h
  }
  for (const s of world.statics) {
    const m = meshForShape(scene, `w:${Math.random()}`, s.shape, s.color)
    applyBodyToMesh(m, s)
    m.isPickable = false
  }
  for (const s of placedStatics) renderStatic(s)
  for (const n of placedNodes) renderNode(n)

  // ── UI ──────────────────────────────────────────────────────────────
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement
  const $e = (id: string) => document.getElementById(id) as HTMLElement
  let tool: Tool | null = null
  const toolsEl = $e('tools')
  const bindings = loadBindings(localStorage.getItem('hobo.editor.bindings'))
  const bindingOf = (action: string): Binding => bindings[action] ?? { code: 'F24' }
  const TOOLS: [Tool, string][] = [
    ['terrain', '⛰ Terrain'],
    ['paint', '🖌 Paint'],
    ['entity', '🌱 Entity'],
    ['mesh', '🧱 Mesh'],
    ['select', '🖱 Select'],
    ['face', '🎨 Face'],
    ['light', '💡 Light'],
  ]
  const terrainMode = (): 'sculpt' | 'smooth' | 'flatten' =>
    (document.getElementById('terrain-mode') as HTMLSelectElement).value as
      'sculpt' | 'smooth' | 'flatten'
  /** Toggle semantics: activating the active tool deactivates it (null). */
  const setTool = (want: Tool | null): void => {
    const id = want === tool ? null : want
    tool = id
    toolsEl
      .querySelectorAll('button')
      .forEach((x) => x.classList.toggle('active', x.dataset['tool'] === id))
    $e('paint-row').style.display = id === 'paint' ? 'flex' : 'none'
    $e('mesh-row').style.display = id === 'mesh' ? 'flex' : 'none'
    $e('entity-row').style.display = id === 'entity' ? 'flex' : 'none'
    $e('light-row').style.display = id === 'light' ? 'flex' : 'none'
    // Brush widget floats bottom-left, only for brush-driven tools.
    $e('brush').style.display = id === 'terrain' || id === 'paint' ? 'flex' : 'none'
    $e('mode-row').style.display = id === 'terrain' ? 'flex' : 'none'
    $e('snap-row').style.display =
      id === 'mesh' || id === 'entity' || id === 'select' ? 'flex' : 'none'
    $e('face').style.display = id === 'face' ? 'flex' : 'none'
    if (id !== 'face') clearFaceSel()
    if (id !== 'select') deselect()
    if (id !== 'mesh' && id !== 'entity') ghost?.setEnabled(false)
    status.textContent =
      id === null
        ? 'no tool active — camera only'
        : id === 'face'
          ? 'Face Edit: click a face (Shift adds) · RMB paints with current settings'
          : id === 'light'
            ? 'Light: click to place the selected light type · Select tool edits lights'
            : ''
  }
  for (const [id, label] of TOOLS) {
    const b = document.createElement('button')
    b.dataset['tool'] = id
    const icon = label.slice(0, label.indexOf(' '))
    b.innerHTML = `${icon} <span class="tool-label">${label.slice(label.indexOf(' ') + 1)}</span><span class="hk">${formatBinding(bindingOf(`tool.${id}`))}</span>`
    b.title = label
    b.addEventListener('click', () => setTool(id))
    toolsEl.appendChild(b)
  }
  const placeSel = document.getElementById('mesh-sel') as HTMLSelectElement
  const entitySel = document.getElementById('entity-sel') as HTMLSelectElement
  ENTITY_DEFS.forEach((pp, i) => {
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = pp.name
    entitySel.appendChild(o)
  })
  const texSel = document.getElementById('p-tex') as HTMLSelectElement
  const faceTexSel = document.getElementById('f-tex') as HTMLSelectElement
  const fillTexSelect = (sel: HTMLSelectElement): void => {
    const prev = sel.value
    sel.replaceChildren()
    for (const t of [...TEXTURES, ...mapTextures.map((tt) => `custom:${tt.name}`)]) {
      const o = document.createElement('option')
      o.value = t
      o.textContent = t === '' ? 'Plain Color' : prettyTexName(t)
      sel.appendChild(o)
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev
  }
  const status = $e('status')
  $('key').value = localStorage.getItem('hobo.editorkey') ?? localStorage.getItem('hq_sso') ?? ''
  const bindVal = (id: string): void => {
    const upd = () => ($e(`${id}-val`).textContent = $(id).value)
    $(id).addEventListener('input', upd)
    upd()
  }
  bindVal('radius')
  bindVal('strength')
  bindVal('feather')

  // ── Undo/redo: ONE CommandHistory ───────────────────────────────────
  // Legacy UndoOps are bridged into it as commands, so transform sessions,
  // numeric scrubs and every older mutation share a single stack, a single
  // undo/redo path and a single dirty flag.
  const history = new CommandHistory<undefined>(undefined)
  let dirty = false
  /** Mutations that bypass history entirely (texture imports, renames). */
  let nonHistoryDirt = false
  const saveBtn = document.getElementById('save') as HTMLButtonElement
  const updateDirty = (): void => {
    dirty = nonHistoryDirt || history.isDirty()
    saveBtn.textContent = dirty ? '💾 Save map ● (unsaved changes)' : '💾 Save map (applies live)'
  }
  history.onChange(() => updateDirty())
  const markDirty = (): void => {
    nonHistoryDirt = true
    updateDirty()
  }
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault()
  })
  /** Rough retained size, so paint/terrain strokes obey the memory budget. */
  const opBytes = (op: UndoOp): number => {
    if (op.kind === 'terrain') return op.before.byteLength * 2
    if (op.kind === 'paint') return op.before.data.length * 2
    // Paint deltas are a rectangle, so a small stroke costs a few KB.
    if (op.kind === 'maskpaint') return op.before.data.length + op.after.data.length
    if (op.kind === 'mainconvert') return op.prev.byteLength
    if (op.kind === 'group') return op.ops.reduce((n, o) => n + opBytes(o), 0)
    return 1024
  }
  /** Record an already-applied mutation. */
  const pushUndo = (op: UndoOp): void => {
    history.record({
      label: op.kind,
      estimatedBytes: opBytes(op),
      execute: () => applyOp(op, 'redo'),
      undo: () => applyOp(op, 'undo'),
    })
    updateDirty()
  }
  const findMesh = (body?: StaticObjectV2, node?: MapNodeV2): Mesh | null => {
    if (body) for (const [m, b] of staticMeshes) if (b === body) return m
    if (node) for (const [m, n] of nodeMeshes) if (n === node) return m
    return null
  }
  const applyOp = (op: UndoOp, dir: 'undo' | 'redo'): void => {
    if (op.kind === 'group') {
      // Compound ops apply members in order (reversed for undo).
      const seq = dir === 'undo' ? [...op.ops].reverse() : op.ops
      for (const sub of seq) applyOp(sub, dir)
      return
    }
    if (op.kind === 'terrain') {
      const t = terrainTargets.find((tt) => tt.id === op.target)
      if (t) {
        t.heights.set(dir === 'undo' ? op.before : op.after)
        refreshTarget(t)
      }
    } else if (op.kind === 'nodemove') {
      const src = dir === 'undo' ? op.before : op.after
      op.node.pos = [src[0], src[1], src[2]]
      const m = findMesh(undefined, op.node)
      if (m) m.position.set(src[0], src[1] + sampleH(src[0], src[2]) + 0.4, src[2])
    } else if (op.kind === 'patchedit') {
      const patch = patches.find((pp) => pp.id === op.id)
      if (patch) {
        const src = dir === 'undo' ? op.before : op.after
        patch.origin = [...src.origin]
        if (src.rot) patch.rot = [...src.rot]
        else delete patch.rot
        for (const [m, pp] of patchMeshes) {
          if (pp === patch) {
            m.position.set(patch.origin[0], patch.origin[1], patch.origin[2])
            m.rotationQuaternion = null
            const r = patch.rot ?? [0, 0, 0]
            m.rotation.set(r[0], r[1], r[2])
          }
        }
      }
    } else if (op.kind === 'patchadd' || op.kind === 'patchdelete') {
      const removing = (op.kind === 'patchadd') === (dir === 'undo')
      if (removing) {
        patches = patches.filter((pp) => pp !== op.patch)
        for (const [m, pp] of patchMeshes) {
          if (pp === op.patch) {
            if (selectedPatch?.mesh === m) deselect()
            patchMeshes.delete(m)
            m.dispose()
          }
        }
        const ti = terrainTargets.findIndex((t) => t.patch === op.patch)
        if (ti >= 0) terrainTargets.splice(ti, 1)
      } else {
        patches.push(op.patch)
        buildPatchMesh(op.patch)
      }
    } else if (op.kind === 'propedit') {
      const removing = op.add === (dir === 'undo')
      if (removing) {
        placedProps = placedProps.filter((x) => x !== op.prop)
        for (const [m, pr] of propMeshes) {
          if (pr === op.prop) {
            propMeshes.delete(m)
            m.dispose()
          }
        }
      } else {
        placedProps.push(op.prop)
        renderProp(op.prop)
      }
    } else if (op.kind === 'propmove') {
      const src = dir === 'undo' ? op.before : op.after
      op.prop.pos = [src[0], src[1], src[2]]
      for (const [m, pr] of propMeshes) {
        if (pr === op.prop) m.position.set(src[0], sampleH(src[0], src[2]) + 0.5, src[2])
      }
    } else if (op.kind === 'spawnedit') {
      const src = dir === 'undo' ? op.before : op.after
      spawnPos = src ? [src[0], src[1], src[2]] : null
      placeSpawnFlag()
    } else if (op.kind === 'mainconvert') {
      const main = terrainTargets.find((t) => t.id === 'main')!
      if (dir === 'undo') {
        heights.set(op.prev)
        if (op.patch) {
          patches = patches.filter((pp) => pp !== op.patch)
          for (const [m, pp] of patchMeshes) {
            if (pp === op.patch) {
              if (selectedPatch?.mesh === m) deselect()
              patchMeshes.delete(m)
              m.dispose()
            }
          }
          const ti = terrainTargets.findIndex((t) => t.patch === op.patch)
          if (ti >= 0) terrainTargets.splice(ti, 1)
        }
      } else {
        heights.fill(-6)
        if (op.patch) {
          patches.push(op.patch)
          buildPatchMesh(op.patch)
        }
      }
      refreshTarget(main)
    } else if (op.kind === 'patchprop') {
      const src = dir === 'undo' ? op.before : op.after
      if (src.tex) op.patch.tex = src.tex
      else delete op.patch.tex
      if (src.color) op.patch.color = src.color
      else delete op.patch.color
      if (src.uv) op.patch.uv = src.uv
      else delete op.patch.uv
      for (const pp of patchMeshes.values()) {
        if (pp === op.patch) applyPatchMaterial(null, op.patch)
      }
    } else if (op.kind === 'lightadd' || op.kind === 'lightdelete') {
      const removing = (op.kind === 'lightadd') === (dir === 'undo')
      if (removing) {
        if (selectedLight?.light === op.light) deselect()
        mapLightsArr = mapLightsArr.filter((l) => l !== op.light)
        removeLightRender(op.light)
      } else {
        mapLightsArr.push(op.light)
        renderLight(op.light)
      }
    } else if (op.kind === 'lightedit') {
      const src = dir === 'undo' ? op.before : op.after
      Object.assign(op.light, JSON.parse(JSON.stringify(src)) as MapLight)
      for (const k of Object.keys(op.light) as (keyof MapLight)[]) {
        if (!(k in src)) delete op.light[k]
      }
      refreshLightRender(op.light)
    } else if (op.kind === 'batchdelete') {
      const removing = dir === 'redo'
      if (removing) {
        for (const b of op.bodies) {
          placedStatics = placedStatics.filter((x) => x !== b)
          const m = findMesh(b)
          if (m) {
            staticMeshes.delete(m)
            m.dispose()
          }
        }
      } else {
        for (const b of op.bodies) {
          placedStatics.push(b)
          renderStatic(b)
        }
      }
    } else if (op.kind === 'batch') {
      for (const it of op.items) {
        const src = dir === 'undo' ? it.before : it.after
        Object.assign(it.body, JSON.parse(JSON.stringify(src)) as StaticObjectV2)
        const m = findMesh(it.body)
        if (m) rebuildSelectedMesh(it.body, m)
      }
    } else if (op.kind === 'maskpaint') {
      // Paint undo stores only the changed rectangle, not a full canvas.
      const rt = surfaces.get(op.patchId)
      if (rt) {
        rt.mask.applyPatch(dir === 'undo' ? op.before : op.after)
        const patch = patches.find((pp) => pp.id === op.patchId)
        if (patch) surfaceDataOf(patch).paint!.mask = rt.mask.toDataURL()
      }
    } else if (op.kind === 'paint') {
      mixCtx.putImageData(dir === 'undo' ? op.before : op.after, 0, 0)
      mixTex.update()
    } else if (op.kind === 'place' || op.kind === 'delete') {
      const removing = (op.kind === 'place') === (dir === 'undo')
      if (removing) {
        const m = findMesh(op.body, op.node)
        if (op.body) placedStatics = placedStatics.filter((s) => s !== op.body)
        if (op.node) placedNodes = placedNodes.filter((n) => n !== op.node)
        if (m) {
          if (selected?.mesh === m) deselect()
          staticMeshes.delete(m)
          nodeMeshes.delete(m)
          m.dispose()
        }
      } else {
        if (op.body) {
          placedStatics.push(op.body)
          renderStatic(op.body)
        }
        if (op.node) {
          placedNodes.push(op.node)
          renderNode(op.node)
        }
      }
    } else {
      const src = dir === 'undo' ? op.before : op.after
      Object.assign(op.body, JSON.parse(JSON.stringify(src)) as StaticObjectV2)
      const m = findMesh(op.body)
      if (m) {
        rebuildSelectedMesh(op.body, m)
      }
    }
  }
  /**
   * Undo/redo no longer deselect everything. Commands rebuild meshes, so the
   * VIEW state has to be re-derived — but the selection itself is stable ids,
   * and only ids whose object actually disappeared are dropped.
   */
  const objectExists = (oid: string): boolean => {
    if (oid === 'spawn') return spawnPos !== null
    if (oid === 'terrain:main') return true
    if (oid.startsWith('terrain:')) return patches.some((p) => `terrain:${p.id}` === oid)
    return (
      placedStatics.some((b) => b.id === oid) ||
      placedNodes.some((n) => n.id === oid) ||
      placedProps.some((pr) => pr.id === oid) ||
      mapLightsArr.some((l) => l.id === oid)
    )
  }
  const afterHistoryStep = (label: string): void => {
    clearFaceSel()
    selectionMgr.retain(objectExists)
    rebuildSelectionViews()
    updateDirty()
    status.textContent = label
  }
  const undo = (): void => {
    if (xform.active) xform.cancel()
    if (!history.undo()) return
    afterHistoryStep('↶ undo')
  }
  const redo = (): void => {
    if (!history.redo()) return
    afterHistoryStep('↷ redo')
  }

  // ── Terrain targets: the main ground plus free-floating patches ─────
  interface TerrainTarget {
    id: string
    mesh: Mesh
    heights: Float32Array
    sub: number
    half: number
    patch: PatchState | null
  }
  const terrainTargets: TerrainTarget[] = []
  const patchMeshes = new Map<Mesh, PatchState>()
  /** Sculpt wireframe overlay per patch (main terrain has `wire`). */
  const patchWires = new Map<Mesh, Mesh>()
  // v2 terrain objects: `pos` is the transform, `origin` is the editor's
  // in-memory name for the same thing.
  let patches: PatchState[] = bootDoc.terrains.map((t) => ({
    id: t.id,
    origin: t.pos,
    halfExtent: t.halfExtent,
    sub: t.sub,
    heights: decodeHeights(t.heights),
    ...(t.rot ? { rot: t.rot } : {}),
    ...(t.scale ? { scale: t.scale } : {}),
    ...(t.surface ? { surface: t.surface as SurfaceMaterialData } : {}),
  }))
  let mapModels: { id: string; name: string; glb: string; bounds: [number, number, number] }[] =
    bootDoc.models
  let mapTextures: MapTextureEntry[] = bootDoc.textures as MapTextureEntry[]
  registerCustomTextures(mapTextures)
  let mapLightsArr: MapLightV2[] = bootDoc.lights
  let mapZones: MapZoneV2[] = bootDoc.zones
  let placedProps: MapPropV2[] = bootDoc.props
  let spawnPos: [number, number, number] | null = bootDoc.spawn ?? null
  let spawnYaw = bootDoc.spawnYaw ?? 0

  // Spawn flag marker (pole + pennant), moved by the Spawn placeable.
  const spawnFlag = new TransformNode('spawnflag', scene)
  {
    const pole = CreateCylinder('spawnpole', { diameter: 0.12, height: 3 }, scene)
    pole.parent = spawnFlag
    pole.position.y = 1.5
    const flag = meshForShape(
      scene,
      'spawnpennant',
      { type: 'box', size: [1.2, 0.5, 0.06] },
      '#e8b54a',
    )
    flag.parent = spawnFlag
    flag.position.set(0.65, 2.6, 0)
    for (const m of [pole, flag]) m.isPickable = true
  }
  const placeSpawnFlag = (): void => {
    if (spawnPos) {
      spawnFlag.setEnabled(true)
      spawnFlag.position.set(spawnPos[0], spawnPos[1], spawnPos[2])
      spawnFlag.rotation.y = spawnYaw
    } else spawnFlag.setEnabled(false)
  }
  placeSpawnFlag()
  for (const pr of placedProps) renderProp(pr)

  // ── Editor-placed lights: widget mesh + LIVE Babylon light preview ──
  const lightMeshes = new Map<Mesh, MapLight>()
  const lightInstances = new Map<string, ReturnType<typeof instantiateMapLight>>()
  const lightQuat = (l: MapLight): Quaternion =>
    l.dir
      ? Quaternion.FromUnitVectorsToRef(
          new Vector3(0, -1, 0),
          new Vector3(l.dir[0], l.dir[1], l.dir[2]).normalize(),
          new Quaternion(),
        )
      : Quaternion.Identity()
  const syncLightInstance = (l: MapLight): void => {
    lightInstances.get(l.id)?.dispose()
    const inst = instantiateMapLight(scene, l)
    lightInstances.set(l.id, inst)
  }
  const renderLight = (l: MapLight): Mesh => {
    const mesh = CreateSphere(`light:${l.id}`, { diameter: 0.55, segments: 10 }, scene)
    const lm = new StandardMaterial(`lightm:${l.id}`, scene)
    lm.emissiveColor = Color3.FromHexString(l.color ?? '#ffffff')
    lm.disableLighting = true
    mesh.material = lm
    if (l.type !== 'point') {
      // Direction cone (apex points along the light's -Y "beam" axis).
      const arrow = CreateCylinder(
        `lighta:${l.id}`,
        { diameterTop: 0.26, diameterBottom: 0.02, height: 0.7, tessellation: 10 },
        scene,
      )
      arrow.parent = mesh
      arrow.position.y = -0.65
      arrow.material = lm
      arrow.isPickable = false
    }
    mesh.position.set(l.pos[0], l.pos[1], l.pos[2])
    mesh.rotationQuaternion = lightQuat(l)
    lightMeshes.set(mesh, l)
    syncLightInstance(l)
    return mesh
  }
  const removeLightRender = (l: MapLight): void => {
    for (const [m, ll] of lightMeshes) {
      if (ll === l) {
        lightMeshes.delete(m)
        m.dispose(false, true)
      }
    }
    lightInstances.get(l.id)?.dispose()
    lightInstances.delete(l.id)
  }
  /** Re-sync widget + live light after property/pose edits. */
  const refreshLightRender = (l: MapLight): void => {
    for (const [m, ll] of lightMeshes) {
      if (ll === l) {
        m.position.set(l.pos[0], l.pos[1], l.pos[2])
        m.rotationQuaternion = lightQuat(l)
        ;(m.material as StandardMaterial).emissiveColor = Color3.FromHexString(l.color ?? '#ffffff')
      }
    }
    syncLightInstance(l)
  }
  for (const l of mapLightsArr) renderLight(l)

  /**
   * Layered surface per terrain object: base texture (never touched by
   * painting) + up to four paint layers blended through one RGBA mask.
   * Replaces the TerrainMaterial splat, whose three slots were hard-wired to
   * grass/rock/mud and which overwrote the surface's own texture the moment
   * the Paint tool was used.
   */
  interface SurfaceRuntime {
    material: LayeredSurfaceMaterial
    mask: PaintMask
  }
  const surfaces = new Map<string, SurfaceRuntime>()
  /** The document-side surface data for a terrain patch. */
  const surfaceDataOf = (patch: PatchState): SurfaceMaterialData => {
    if (!patch.surface) {
      // Legacy patches carry `tex`/`color` and an old three-way `mix`.
      patch.surface = {
        base: {
          ...(patch.tex && patch.tex !== 'none' ? { tex: patch.tex } : {}),
          ...(patch.color ? { color: patch.color } : {}),
          ...(patch.uv ? { uv: patch.uv } : {}),
        },
        ...(patch.mix ? { paint: migrateLegacyMix(patch.mix, () => newId('pl'))! } : {}),
      }
    }
    return patch.surface
  }
  const ensureSurface = (patch: PatchState, mesh: Mesh): SurfaceRuntime => {
    const existing = surfaces.get(patch.id)
    if (existing) {
      if (mesh.material !== existing.material.material) mesh.material = existing.material.material
      return existing
    }
    const data = surfaceDataOf(patch)
    const mask = new PaintMask(scene, `pmask:${patch.id}`)
    if (data.paint?.mask) {
      const img = new Image()
      img.onload = () => mask.drawImage(img)
      img.src = data.paint.mask
    }
    const material = new LayeredSurfaceMaterial(scene, `psurf:${patch.id}`, data, {
      baseTiling: Math.max(2, patch.halfExtent / 2),
      layerTiling: Math.max(2, patch.halfExtent / 2),
      backFaceCulling: false,
    })
    material.setMaskTexture(mask.texture)
    mesh.material = material.material
    const rt: SurfaceRuntime = { material, mask }
    surfaces.set(patch.id, rt)
    return rt
  }
  /** Re-read a surface after a base-texture or layer change. */
  const refreshSurface = (patch: PatchState): void => {
    const rt = surfaces.get(patch.id)
    if (!rt) return
    rt.material.update(surfaceDataOf(patch))
    rt.material.setMaskTexture(rt.mask.texture)
  }
  /**
   * Push a patch's legacy tex/color/uv fields into its surface BASE and
   * re-read the material. Painting is unaffected: layers and mask are
   * separate data, so a base change never disturbs what has been painted.
   */
  const applyPatchMaterial = (_unused: unknown, patch: PatchState): void => {
    const data = surfaceDataOf(patch)
    data.base = {
      ...(patch.tex && patch.tex !== 'none' ? { tex: patch.tex } : {}),
      ...(patch.color ? { color: patch.color } : {}),
      ...(patch.uv ? { uv: patch.uv } : {}),
    }
    refreshSurface(patch)
  }
  const buildPatchMesh = (patch: PatchState): Mesh => {
    const grid = buildPatchGrid(patch.halfExtent, patch.sub, patch.heights)
    const mesh = new Mesh(`patch:${patch.id}`, scene)
    const pvd = new VertexData()
    pvd.positions = grid.positions.slice()
    pvd.indices = grid.indices
    pvd.uvs = grid.uvs
    const pn: number[] = []
    VertexData.ComputeNormals(pvd.positions, grid.indices, pn)
    pvd.normals = pn
    pvd.applyToMesh(mesh, true)
    // Wireframe overlay (same grid, +3cm) — every terrain type gets one.
    const pw = new Mesh(`pwire:${patch.id}`, scene)
    const wvd = new VertexData()
    wvd.positions = (pvd.positions as number[] | Float32Array).slice() as number[]
    wvd.indices = grid.indices
    wvd.applyToMesh(pw, true)
    pw.material = wireMat
    pw.isPickable = false
    pw.position.y = 0.03
    pw.parent = mesh
    pw.setEnabled(false)
    patchWires.set(mesh, pw)
    mesh.onDisposeObservable.add(() => patchWires.delete(mesh))
    mesh.position.set(patch.origin[0], patch.origin[1], patch.origin[2])
    if (patch.rot) mesh.rotation.set(patch.rot[0], patch.rot[1], patch.rot[2])
    // Every terrain gets the layered surface — painted or not. Its base
    // texture stays authoritative and paint layers sit on top of it.
    ensureSurface(patch, mesh)
    patchMeshes.set(mesh, patch)
    terrainTargets.push({
      id: patch.id,
      mesh,
      heights: patch.heights,
      sub: patch.sub,
      half: patch.halfExtent,
      patch,
    })
    return mesh
  }
  for (const patch of patches) buildPatchMesh(patch)

  const mainGone = (): boolean => {
    for (const h of heights) if (h > -4.5) return false
    return true
  }
  const refreshTarget = (t: TerrainTarget): void => {
    if (t.id === 'main') {
      terrain.setEnabled(!mainGone())
      terrain.isPickable = !mainGone()
    }
    const buf = t.mesh.getVerticesData(VertexBuffer.PositionKind) as Float32Array
    const n = t.sub
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        buf[((n - j) * (n + 1) + i) * 3 + 1] = t.heights[j * (n + 1) + i] ?? 0
      }
    }
    t.mesh.updateVerticesData(VertexBuffer.PositionKind, buf, true)
    const idx = t.mesh.getIndices() as Uint32Array
    const nn: number[] = []
    VertexData.ComputeNormals(buf, idx, nn)
    t.mesh.updateVerticesData(VertexBuffer.NormalKind, nn, true)
    if (t.id === 'main') wire.updateVerticesData(VertexBuffer.PositionKind, buf, true)
    patchWires.get(t.mesh)?.updateVerticesData(VertexBuffer.PositionKind, buf, true)
  }

  // ── Sculpt core ─────────────────────────────────────────────────────
  terrainTargets.push({ id: 'main', mesh: terrain, heights, sub: SUB, half: HALF, patch: null })
  if (mainGone()) terrain.setEnabled(false)
  let shift = false
  let strokeBefore: Float32Array | null = null
  let strokeTarget: TerrainTarget | null = null
  let paintBefore: ImageData | null = null
  let paintTarget: TerrainTarget | null = null

  function sculpt(target: TerrainTarget, px: number, pz: number, sign: number): void {
    const radius = Number($('radius').value)
    const strength = Number($('strength').value) * sign
    const feather = Number($('feather').value)
    const mode = terrainMode()
    const n = target.sub
    const half = target.half
    const tcell = (half * 2) / n
    const hs = target.heights
    let flatH = 0
    if (mode === 'flatten') {
      const ci = Math.round((px + half) / tcell)
      const cj = Math.round((pz + half) / tcell)
      flatH = hs[cj * (n + 1) + ci] ?? 0
    }
    const iMin = Math.max(0, Math.floor((px - radius + half) / tcell))
    const iMax = Math.min(n, Math.ceil((px + radius + half) / tcell))
    const jMin = Math.max(0, Math.floor((pz - radius + half) / tcell))
    const jMax = Math.min(n, Math.ceil((pz + radius + half) / tcell))
    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        const x = -half + i * tcell
        const z = -half + j * tcell
        const d = Math.hypot(x - px, z - pz)
        if (d > radius) continue
        // Feather: exponent on the cos² falloff — low = wide soft skirt
        // (paths, gentle mounds), high = tight hard-edged plateau.
        const fall = Math.cos((d / radius) * Math.PI * 0.5) ** (2 * feather)
        const v = j * (n + 1) + i
        const h = hs[v] ?? 0
        if (mode === 'sculpt') hs[v] = h + strength * fall * 0.35
        else if (mode === 'flatten') hs[v] = h + (flatH - h) * Math.min(1, fall * 0.6)
        else if (mode === 'smooth') {
          const nb =
            ((hs[v - 1] ?? h) +
              (hs[v + 1] ?? h) +
              (hs[v - (n + 1)] ?? h) +
              (hs[v + (n + 1)] ?? h)) /
            4
          hs[v] = h + (nb - h) * Math.min(1, fall * 0.8)
        }
      }
    }
    refreshTarget(target)
  }

  function paint(px: number, pz: number): void {
    const radius = Number($('radius').value)
    const strength = Math.min(1, Number($('strength').value))
    const feather = Number($('feather').value)
    const u = ((px + HALF) / (HALF * 2)) * MIX
    const vpix = (1 - (pz + HALF) / (HALF * 2)) * MIX
    const r = (radius / (HALF * 2)) * MIX
    // Feathered brush: radial gradient whose inner solid core shrinks as
    // feather drops, and whose alpha is the strength — low strength gives
    // faded, buildable washes for paths.
    const g = mixCtx.createRadialGradient(u, vpix, 0, u, vpix, r)
    const color = (document.getElementById('paint') as HTMLSelectElement).value
    const core = Math.max(0.05, Math.min(0.95, 1 - 1 / (0.4 + feather)))
    const alpha = Math.round(strength * 255)
      .toString(16)
      .padStart(2, '0')
    g.addColorStop(0, `${color}${alpha}`)
    g.addColorStop(core, `${color}${alpha}`)
    g.addColorStop(1, `${color}00`)
    mixCtx.fillStyle = g
    mixCtx.fillRect(u - r, vpix - r, r * 2, r * 2)
    mixTex.update()
  }

  // ── Placement: ghost preview, wheel rotate, surface align, snapping ─
  let ghost: Mesh | null = null
  let ghostFor = -1
  let placeYaw = 0
  const ensureGhost = (): Mesh | null => {
    const idx = tool === 'entity' ? 1000 + Number(entitySel.value) : Number(placeSel.value)
    const def =
      tool === 'entity' ? ENTITY_DEFS[Number(entitySel.value)] : PLACEABLES[Number(placeSel.value)]
    if (!def) return null
    if (ghost && ghostFor === idx) return ghost
    ghost?.dispose()
    const shape = placeableShape(def)
    const color =
      def.kind === 'static'
        ? def.color!
        : def.kind === 'node'
          ? (NODE_LOOKS[def.node!]?.color ?? '#888888')
          : '#e8b54a'
    ghost = meshForShape(scene, 'ghost', shape, color)
    ghost.visibility = 0.5
    ghost.isPickable = false
    ghostFor = idx
    return ghost
  }
  const placeableShape = (def: Placeable): StaticObjectV2['shape'] => {
    if (def.kind === 'static') return def.shape!
    if (def.kind === 'node') return NODE_LOOKS[def.node!]?.shape ?? { type: 'sphere', radius: 0.6 }
    if (def.kind === 'model') {
      const model = mapModels.find((mm) => mm.id === def.modelId)
      const b = model?.bounds ?? [1, 1, 1]
      return { type: 'box', size: [b[0], b[1], b[2]] }
    }
    return { type: 'box', size: [0.3, 3, 0.3] } // spawn flag pole
  }
  const shapeHeight = (shape: StaticObjectV2['shape']): number =>
    shape.type === 'box'
      ? shape.size[1]
      : shape.type === 'cylinder'
        ? shape.height
        : shape.radius * 2
  const snapVal = (v: number): number => {
    const snap = Number($('snap').value)
    if (shift || snap <= 0) return v
    return Math.round(v / snap) * snap
  }
  interface PlacePose {
    pos: Vector3
    rot: Quaternion
  }
  /**
   * A brand-new map has no geometry at all, so a placement ray hits nothing
   * and the first object could never be placed. When the authored count is
   * ZERO the first mesh/terrain/model commits at exactly the origin, wherever
   * the user clicks. Sky, water, grid and helpers do not count.
   */
  const authoredGeometryCount = (): number => placedStatics.length + patches.length
  const computePlacePose = (): PlacePose | null => {
    if (authoredGeometryCount() === 0) {
      const def0 =
        tool === 'entity'
          ? ENTITY_DEFS[Number(entitySel.value)]
          : PLACEABLES[Number(placeSel.value)]
      if (def0)
        return {
          pos: new Vector3(0, 0, 0),
          rot: Quaternion.RotationAxis(new Vector3(0, 1, 0), placeYaw),
        }
    }
    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (m) => m !== ghost && m !== wire && m.isEnabled() && m.isPickable,
    )
    if (!pick?.hit || !pick.pickedPoint) return null
    const def =
      tool === 'entity' ? ENTITY_DEFS[Number(entitySel.value)] : PLACEABLES[Number(placeSel.value)]
    if (!def) return null
    const shape = placeableShape(def)
    const n = pick.getNormal(true) ?? new Vector3(0, 1, 0)
    // Align local +Y to the surface normal (walls, slopes), then apply the
    // wheel yaw around that normal. Nodes always sit upright.
    const rot =
      def.kind === 'node' || def.kind === 'spawn' || def.kind === 'prop' || n.y > 0.95
        ? Quaternion.RotationAxis(new Vector3(0, 1, 0), placeYaw)
        : Quaternion.FromUnitVectorsToRef(
            new Vector3(0, 1, 0),
            n.normalizeToNew(),
            new Quaternion(),
          ).multiply(Quaternion.RotationAxis(new Vector3(0, 1, 0), placeYaw))
    const h = shapeHeight(shape as StaticObjectV2['shape'])
    const off = n.scale(h / 2 + 0.001)
    const pos = new Vector3(
      snapVal(pick.pickedPoint.x + off.x),
      pick.pickedPoint.y + off.y,
      snapVal(pick.pickedPoint.z + off.z),
    )
    return { pos, rot }
  }
  // Wheel: rotates the placement preview WHILE placing; otherwise it is
  // cursor-centric zoom — fly toward the picked point under the mouse
  // (or a pivot along the view direction over empty space), with speed
  // scaled by distance so close work is precise and travel is fast.
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      // No camera motion at all while an object gesture owns the pointer.
      if (!interaction.flightAllowed()) return
      if (tool === 'mesh' || tool === 'entity') {
        const step = holding('place.fine') || shift ? Math.PI / 60 : Math.PI / 12
        placeYaw += (e.deltaY > 0 ? 1 : -1) * step
        return
      }
      const pick = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (m) => m !== ghost && m !== wire && m.isEnabled() && m.isPickable,
      )
      const target =
        pick?.hit && pick.pickedPoint
          ? pick.pickedPoint
          : camera.position.add(camera.getForwardRay(1).direction.scale(40))
      const toTarget = target.subtract(camera.position)
      const dist = toTarget.length()
      const dirIn = e.deltaY < 0
      // 18% of the distance per notch, clamped so we neither crawl at
      // range nor teleport through the target.
      const step = Math.min(60, Math.max(0.4, dist * 0.18))
      const move = toTarget.normalize().scale(dirIn ? step : -step)
      if (dirIn && dist - step < 1.2) return // never zoom through the point
      camera.position.addInPlace(move)
    },
    { passive: false },
  )

  function placeAt(pose: PlacePose): void {
    const def =
      tool === 'entity' ? ENTITY_DEFS[Number(entitySel.value)] : PLACEABLES[Number(placeSel.value)]
    if (!def) return
    if (def.kind === 'spawn') {
      const before = spawnPos ? ([...spawnPos] as [number, number, number]) : null
      spawnPos = [pose.pos.x, pose.pos.y, pose.pos.z]
      spawnYaw = placeYaw
      placeSpawnFlag()
      pushUndo({ kind: 'spawnedit', before, after: [...spawnPos] as [number, number, number] })
      status.textContent = '🚩 spawn point set — players appear here after save'
      return
    }
    if (def.kind === 'model') {
      const model = mapModels.find((mm) => mm.id === def.modelId)
      if (!model) return
      const e = pose.rot.toEulerAngles()
      const body: StaticObjectV2 = {
        id: newId('s'),
        shape: { type: 'box', size: [model.bounds[0], model.bounds[1], model.bounds[2]] },
        pos: [pose.pos.x, pose.pos.y, pose.pos.z],
        yaw: e.y,
        ...(Math.abs(e.x) > 0.01 || Math.abs(e.z) > 0.01
          ? { rot: [e.x, e.y, e.z] as [number, number, number] }
          : {}),
        color: '#8a8d90',
        model: model.id,
      }
      placedStatics.push(body)
      renderStatic(body)
      pushUndo({ kind: 'place', body })
      return
    }
    if (def.kind === 'patch') {
      const half = 16
      const sub = 32
      const patch: PatchState = {
        id: `patch-${Date.now().toString(36)}`,
        origin: [snapVal(pose.pos.x), pose.pos.y, snapVal(pose.pos.z)],
        halfExtent: half,
        sub,
        heights: new Float32Array((sub + 1) * (sub + 1)),
      }
      patches.push(patch)
      buildPatchMesh(patch)
      pushUndo({ kind: 'patchadd', patch })
      status.textContent = '⛰ patch placed — sculpt it with the Terrain tool, Select to move/tilt'
      return
    }
    if (def.kind === 'prop') {
      const e = pose.rot.toEulerAngles()
      const pr = {
        id: newId('pr'),
        item: def.node!,
        pos: [pose.pos.x, 1, pose.pos.z] as [number, number, number],
        yaw: e.y,
      }
      placedProps.push(pr)
      renderProp(pr)
      pushUndo({ kind: 'propedit', add: true, prop: pr })
      status.textContent = `${def.name} placed — spawns live on save (physgun-movable in game)`
      return
    }
    if (def.kind === 'node') {
      const ground = sampleH(pose.pos.x, pose.pos.z)
      const node: MapNodeV2 = {
        id: newId('n'),
        node: def.node!,
        pos: [pose.pos.x, 0, pose.pos.z],
      }
      void ground
      placedNodes.push(node)
      renderNode(node)
      pushUndo({ kind: 'place', node })
      return
    }
    const e = pose.rot.toEulerAngles()
    const body: StaticObjectV2 = {
      id: newId('s'),
      shape: JSON.parse(JSON.stringify(def.shape)) as StaticObjectV2['shape'],
      pos: [pose.pos.x, pose.pos.y, pose.pos.z],
      yaw: e.y,
      ...(Math.abs(e.x) > 0.01 || Math.abs(e.z) > 0.01
        ? { rot: [e.x, e.y, e.z] as [number, number, number] }
        : {}),
      color: def.color!,
      ...(def.tex ? { tex: def.tex } : {}),
      ...(def.decor ? { decor: def.decor } : {}),
    }
    placedStatics.push(body)
    renderStatic(body)
    pushUndo({ kind: 'place', body })
  }

  // ── Selection: gizmos + properties popover ──────────────────────────
  // ── Central selection visuals: one HighlightLayer for everything.
  // Colors: primary orange, secondary lighter, hover faint white, remote
  // collaborators in their session color. Authored materials untouched.
  const hl = new HighlightLayer('sel', scene, { blurHorizontalSize: 0.6, blurVerticalSize: 0.6 })
  hl.innerGlow = false
  const C_PRIMARY = Color3.FromHexString('#ff9d2e')
  const C_SECONDARY = Color3.FromHexString('#ffd28f')
  const C_HOVER = Color3.FromHexString('#cfe8ff')
  const remoteSel = new Map<number, { color: Color3; ids: string[] }>()
  let hoverMesh: Mesh | null = null
  const meshById = (oid: string): Mesh | null => {
    for (const [m, b] of staticMeshes) if (b.id === oid) return m
    for (const [m, n] of nodeMeshes) if (n.id === oid) return m
    for (const [m, pr] of propMeshes) if (pr.id === oid) return m
    for (const [m, pp] of patchMeshes) if (`terrain:${pp.id}` === oid) return m
    for (const [m, l] of lightMeshes) if (l.id === oid) return m
    return null
  }
  /** Recompute every highlight from current local + remote selection. */
  const refreshSelectionVisuals = (): void => {
    hl.removeAllMeshes()
    let remoteMain: Color3 | null = null
    for (const [, r] of remoteSel) {
      for (const oid of r.ids) {
        if (oid === 'spawn') {
          for (const c of spawnFlag.getChildMeshes()) hl.addMesh(c as Mesh, r.color)
          continue
        }
        if (oid === 'terrain:main') {
          remoteMain = r.color
          continue
        }
        const m = meshById(oid)
        if (m) hl.addMesh(m, r.color)
      }
    }
    wireMat.emissiveColor = remoteMain ?? new Color3(0.35, 0.75, 1)
    if (remoteMain) wire.setEnabled(true)
    for (const it of multiSel)
      hl.addMesh(it.mesh, it.mesh === multiSel[0]?.mesh ? C_PRIMARY : C_SECONDARY)
    for (const it of multiPatches) hl.addMesh(it.mesh, C_SECONDARY)
    for (const it of multiNodes) hl.addMesh(it.mesh, C_SECONDARY)
    for (const it of multiProps) hl.addMesh(it.mesh, C_SECONDARY)
    if (selected) hl.addMesh(selected.mesh, C_PRIMARY)
    if (selectedNode) hl.addMesh(selectedNode.mesh, C_PRIMARY)
    if (selectedProp) hl.addMesh(selectedProp.mesh, C_PRIMARY)
    if (selectedPatch) hl.addMesh(selectedPatch.mesh, C_PRIMARY)
    if (selectedLight) hl.addMesh(selectedLight.mesh, C_PRIMARY)
    if (spawnSelected) for (const c of spawnFlag.getChildMeshes()) hl.addMesh(c as Mesh, C_PRIMARY)
    if (hoverMesh && tool === 'select') hl.addMesh(hoverMesh, C_HOVER)
    // Starter island: persistent wireframe while selected (not hover-only).
    wire.setEnabled(mainSelected || wireHover)
  }
  let wireHover = false

  // ── Collaboration locks (server-authoritative, transient) ───────────
  const lockOwners = new Map<string, { name: string; color: string }>()
  let myLockedIds: string[] = []
  let lockDenied: { owner: string } | null = null
  /** Explicit lock lifecycle: nothing mutates until the server says owned. */
  type LockState = 'unlocked' | 'pending' | 'owned' | 'denied' | 'lost'
  let lockState: LockState = 'unlocked'
  /** Deferred gizmo attach — runs only when the pending lock is GRANTED. */
  let onLockGranted: (() => void) | null = null
  const requestLock = (ids: string[], granted?: () => void): void => {
    if (myLockedIds.length && ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ t: 'unlock', ids: myLockedIds }))
    myLockedIds = ids
    lockDenied = null
    if (ids.length === 0) {
      lockState = 'unlocked'
      granted?.()
      return
    }
    lockState = 'pending'
    onLockGranted = granted ?? null
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'lock', ids }))
    else {
      // Offline/solo editing: no collab channel, no contention.
      lockState = 'owned'
      granted?.()
      onLockGranted = null
    }
  }
  const releaseLocks = (): void => {
    if (myLockedIds.length && ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ t: 'unlock', ids: myLockedIds }))
    myLockedIds = []
    lockDenied = null
    lockState = 'unlocked'
    onLockGranted = null
  }
  const sendSelection = (ids: string[]): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'sel', ids }))
  }
  const setInspectorLocked = (locked: boolean, owner?: string): void => {
    props.querySelectorAll('input,select,button').forEach((el) => {
      ;(el as HTMLInputElement).disabled = locked
    })
    const t = $e('props-title')
    if (locked && owner) t.textContent = `${t.textContent} · 🔒 editing by ${owner}`
  }

  const gizmos = new GizmoManager(scene)
  gizmos.usePointerToAttachGizmos = false
  gizmos.attachToMesh(null)

  /**
   * Gizmo pointer ownership, structurally.
   *
   * Babylon's UtilityLayerRenderer hooks `originalScene.onPrePointerObservable`
   * (top priority) and sets `skipOnPointerObservable` when a gizmo is hit —
   * but that only suppresses Babylon's OWN `scene.onPointerObservable`, which
   * this editor never used: it listens on the raw DOM instead, so the engine
   * had no way to tell it "the gizmo took this one".
   *
   * The ordering that fixes it: `new Scene(engine)` attaches Babylon's input
   * manager during construction, well before any editor listener is added
   * below. So the gizmo's drag-start observable has ALREADY run (synchronously
   * inside the same DOM pointerdown) by the time our canvas handler executes —
   * the gesture is claimed, `canStartGesture()` is false, and nothing behind
   * the gizmo can be picked. No hover flags, no timeouts.
   */
  const interaction = new InteractionController()

  /**
   * ONE selection authority (document ids), and ONE picker. The per-kind
   * `selected*` / `multi*` structures below are now a projection of this set
   * rather than the source of truth — `rebuildSelectionViews()` re-derives
   * them whenever the set changes.
   */
  const selectionMgr = new SelectionManager()
  /** True while rebuildSelectionViews() is re-deriving the view state. */
  let projectingSelection = false
  const ownerOf = (m: unknown): MeshOwner | null => {
    const mesh = m as Mesh
    const b = staticMeshes.get(mesh)
    if (b?.id) return { objectId: b.id, kind: b.model ? 'model' : 'static' }
    const n = nodeMeshes.get(mesh)
    if (n?.id) return { objectId: n.id, kind: 'node' }
    const pr = propMeshes.get(mesh)
    if (pr?.id) return { objectId: pr.id, kind: 'prop' }
    const pp = patchMeshes.get(mesh)
    if (pp) return { objectId: `terrain:${pp.id}`, kind: 'terrain' }
    const l = lightMeshes.get(mesh)
    if (l) return { objectId: l.id, kind: 'light' }
    if (mesh === terrain) return { objectId: 'terrain:main', kind: 'terrain' }
    if ((mesh as unknown) === (spawnFlag as unknown)) return { objectId: 'spawn', kind: 'spawn' }
    return null
  }
  const picker = new EditorPicker(scene, ownerOf as never)
  type GizmoMode = 'move' | 'rotate' | 'scale'
  let gizmoMode: GizmoMode = 'move'
  const setGizmoMode = (mode: GizmoMode): void => {
    // Selection kinds constrain modes: nodes only move; patches move/rotate.
    if (selectedNode && mode !== 'move') mode = 'move'
    if (selectedLight && mode === 'scale') mode = 'move'
    if (selectedLight?.light.type === 'point' && mode === 'rotate') mode = 'move'
    // Group scale is no longer statics-only: TransformSession applies one
    // delta to every kind, terrain included.
    gizmoMode = mode
    gizmos.positionGizmoEnabled = mode === 'move'
    gizmos.rotationGizmoEnabled = mode === 'rotate'
    gizmos.scaleGizmoEnabled = mode === 'scale'
    for (const [id, m] of [
      ['gm-move', 'move'],
      ['gm-rot', 'rotate'],
      ['gm-scale', 'scale'],
    ] as const) {
      document.getElementById(id)?.classList.toggle('active', m === mode)
    }
    // Re-wire drag hooks: gizmo instances are created lazily per mode.
    wireGizmoHooks()
  }
  document.getElementById('gm-move')?.addEventListener('click', () => setGizmoMode('move'))
  document.getElementById('gm-rot')?.addEventListener('click', () => setGizmoMode('rotate'))
  document.getElementById('gm-scale')?.addEventListener('click', () => setGizmoMode('scale'))
  const props = $e('props')
  let selected: { mesh: Mesh; body: StaticObjectV2; editBefore: StaticObjectV2 | null } | null =
    null
  let selectedNode: { mesh: Mesh; node: MapNodeV2; before: [number, number, number] } | null = null
  let selectedProp: {
    mesh: Mesh
    prop: MapPropV2
    before: [number, number, number]
  } | null = null
  let selectedPatch: { mesh: Mesh; patch: PatchState } | null = null
  let selectedLight: { mesh: Mesh; light: MapLight } | null = null
  let spawnSelected = false

  /** Legacy view teardown. Callers that mean "nothing is selected" should
   *  use clearSelection(); this only tears down the projected view state. */
  const deselect = (): void => {
    // Every legacy teardown path (undo, tool switch, delete, remote merge)
    // must also empty the authority, or it would keep stale ids alive.
    if (!projectingSelection) selectionMgr.clear()
    mainSelected = false
    spawnSelected = false
    clearMulti()
    gizmos.attachToMesh(null)
    props.style.display = 'none'
    $e('light-rows').style.display = 'none'
    selected = null
    selectedNode = null
    selectedProp = null
    selectedPatch = null
    selectedLight = null
    releaseLocks()
    sendSelection([])
    setInspectorLocked(false)
    refreshSelectionVisuals()
  }

  /**
   * Lock + broadcast + visuals. The gizmo/inspector stay read-only while
   * the lock is pending; `whenOwned` attaches them on grant.
   */
  const afterSelect = (ids: string[], whenOwned?: () => void): void => {
    setInspectorLocked(true)
    requestLock(ids, () => {
      setInspectorLocked(false)
      whenOwned?.()
      refreshSelectionVisuals()
    })
    sendSelection(ids)
    refreshSelectionVisuals()
  }

  /** Props select like nodes: move gizmo + inspector, Del removes. */
  const selectProp = (mesh: Mesh, prop: MapPropV2): void => {
    deselect()
    selectedProp = { mesh, prop, before: [prop.pos[0], prop.pos[1], prop.pos[2]] }
    setGizmoMode('move')
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = `prop: ${prop.item}`
    for (const id of ['dims-box', 'dims-cyl', 'dims-sph']) $e(id).style.display = 'none'
    $('p-x').value = String(prop.pos[0])
    $('p-y').value = '0'
    $('p-z').value = String(prop.pos[2])
    afterSelect(prop.id ? [prop.id] : [], attachGizmoToPivot)
  }

  const LIGHT_LABEL: Record<MapLight['type'], string> = {
    point: '💡 point light',
    spot: '🔦 spot light',
    directional: '🌞 directional light',
    hemi: '🌐 hemispheric light',
    rect: '🟨 rect area light',
  }
  const fillLightProps = (l: MapLight): void => {
    $e('props-title').textContent = LIGHT_LABEL[l.type]
    for (const id of ['dims-box', 'dims-cyl', 'dims-sph']) $e(id).style.display = 'none'
    $e('light-rows').style.display = 'flex'
    const deg = (r: number) => Math.round((r * 180) / Math.PI)
    $('p-x').value = String(Number(l.pos[0].toFixed(2)))
    $('p-y').value = String(Number(l.pos[1].toFixed(2)))
    $('p-z').value = String(Number(l.pos[2].toFixed(2)))
    const q = lightQuat(l)
    const e = q.toEulerAngles()
    $('r-x').value = String(deg(e.x))
    $('r-y').value = String(deg(e.y))
    $('r-z').value = String(deg(e.z))
    ;($('p-color') as HTMLInputElement).value = l.color ?? '#ffffff'
    ;($('l-spec') as HTMLInputElement).value = l.specular ?? l.color ?? '#ffffff'
    $('l-int').value = String(l.intensity ?? LIGHT_DEFAULTS.intensity[l.type])
    $('l-range').value = String(l.range ?? LIGHT_DEFAULTS.range)
    $('l-angle').value = String(deg(l.angle ?? LIGHT_DEFAULTS.angle))
    $('l-exp').value = String(l.exponent ?? LIGHT_DEFAULTS.exponent)
    ;($('l-ground') as HTMLInputElement).value = l.ground ?? LIGHT_DEFAULTS.ground
    $('l-w').value = String((l.size ?? LIGHT_DEFAULTS.size)[0])
    $('l-h').value = String((l.size ?? LIGHT_DEFAULTS.size)[1])
    ;($('l-shadows') as HTMLInputElement).checked = Boolean(l.shadows)
    $e('l-range-row').style.display = l.type === 'point' || l.type === 'spot' ? 'flex' : 'none'
    $e('l-angle-row').style.display = l.type === 'spot' ? 'flex' : 'none'
    $e('l-ground-row').style.display = l.type === 'hemi' ? 'flex' : 'none'
    $e('l-size-row').style.display = l.type === 'rect' ? 'flex' : 'none'
    $e('l-shadow-row').style.display =
      l.type === 'point' || l.type === 'spot' || l.type === 'directional' ? 'flex' : 'none'
  }
  const selectLight = (mesh: Mesh, l: MapLight): void => {
    deselect()
    selectedLight = { mesh, light: l }
    setGizmoMode(gizmoMode === 'scale' ? 'move' : gizmoMode)
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    fillLightProps(l)
    status.textContent =
      l.type === 'point'
        ? 'drag to move the light · edit properties in the panel'
        : 'G moves · R rotates the beam direction · edit properties in the panel'
    afterSelect([l.id], attachGizmoToPivot)
  }
  /** One-liner for light property edits: mutate + undo + live preview. */
  const editLight = (mutate: (l: MapLight) => void): void => {
    if (!selectedLight) return
    const light = selectedLight.light
    const before = JSON.parse(JSON.stringify(light)) as MapLight
    mutate(light)
    pushUndo({
      kind: 'lightedit',
      light,
      before,
      after: JSON.parse(JSON.stringify(light)) as MapLight,
    })
    refreshLightRender(light)
  }

  const selectSpawn = (): void => {
    deselect()
    spawnSelected = true
    setGizmoMode('move')
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = '🚩 player spawn'
    for (const id of ['dims-box', 'dims-cyl', 'dims-sph']) $e(id).style.display = 'none'
    afterSelect(['spawn'], attachGizmoToPivot)
  }

  /** Nodes: position-only gizmo; drag end re-grounds and records undo. */
  const selectNode = (mesh: Mesh, node: MapNodeV2): void => {
    deselect()
    selectedNode = { mesh, node, before: [node.pos[0], node.pos[1], node.pos[2]] }
    setGizmoMode('move')
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = `resource: ${node.node}`
    for (const id of ['dims-box', 'dims-cyl', 'dims-sph']) $e(id).style.display = 'none'
    $('p-x').value = String(node.pos[0])
    $('p-y').value = '0'
    $('p-z').value = String(node.pos[2])
    status.textContent = 'drag arrows to move the node · Del removes it'
    afterSelect(node.id ? [node.id] : [], attachGizmoToPivot)
  }

  // ── Multi-select: Shift+click accumulates statics; a pivot node carries
  // the gizmo and the meshes ride it, then transforms bake into each body
  // as one undoable batch.
  const multiSel: { mesh: Mesh; body: StaticObjectV2; before: StaticObjectV2 }[] = []
  const multiPatches: {
    mesh: Mesh
    patch: PatchState
    before: { origin: [number, number, number]; rot?: [number, number, number] }
  }[] = []
  const multiNodes: { mesh: Mesh; node: MapNodeV2; before: [number, number, number] }[] = []
  const multiProps: {
    mesh: Mesh
    prop: MapPropV2
    before: [number, number, number]
  }[] = []
  const multiTotal = (): number =>
    multiSel.length + multiPatches.length + multiNodes.length + multiProps.length
  const clearMulti = (): void => {
    for (const it of [...multiSel, ...multiPatches, ...multiNodes, ...multiProps])
      it.mesh.renderOutline = false
    multiSel.length = 0
    multiPatches.length = 0
    multiNodes.length = 0
    multiProps.length = 0
  }
  /**
   * Canonical transform access for every authored object kind. This is the
   * ONLY place that knows how a kind stores its pose, so TransformSession —
   * and therefore group move/rotate/scale — works identically across
   * statics, terrain, nodes, props, lights and the spawn point.
   */
  const transformAccessor: TransformAccessor = {
    get(id: string): EditorTransform | null {
      if (id === 'spawn')
        return spawnPos ? transformFromEuler([...spawnPos], [0, spawnYaw, 0]) : null
      if (id.startsWith('terrain:')) {
        const p = patches.find((pp) => `terrain:${pp.id}` === id)
        if (!p) return null
        return transformFromEuler([...p.origin], p.rot ?? [0, 0, 0], p.scale ?? [1, 1, 1])
      }
      const b = placedStatics.find((x) => x.id === id)
      if (b) return transformFromEuler([...b.pos], b.rot ?? [0, b.yaw, 0], b.scale ?? [1, 1, 1])
      const n = placedNodes.find((x) => x.id === id)
      if (n) return transformFromEuler([...n.pos], [0, 0, 0])
      const pr = placedProps.find((x) => x.id === id)
      if (pr) return transformFromEuler([...pr.pos], [0, pr.yaw ?? 0, 0])
      const l = mapLightsArr.find((x) => x.id === id)
      if (l) {
        const q = lightQuat(l)
        return { position: [...l.pos], rotation: [q.x, q.y, q.z, q.w], scale: [1, 1, 1] }
      }
      return null
    },
    set(id: string, t: EditorTransform): void {
      const e = eulerOf(t)
      if (id === 'spawn') {
        spawnPos = [t.position[0], t.position[1], t.position[2]]
        spawnYaw = e[1]
        placeSpawnFlag()
        return
      }
      if (id.startsWith('terrain:')) {
        const p = patches.find((pp) => `terrain:${pp.id}` === id)
        if (!p) return
        p.origin = [t.position[0], t.position[1], t.position[2]]
        if (Math.abs(e[0]) > 1e-4 || Math.abs(e[1]) > 1e-4 || Math.abs(e[2]) > 1e-4)
          p.rot = [e[0], e[1], e[2]]
        else delete p.rot
        if (t.scale.some((v) => Math.abs(v - 1) > 1e-4))
          p.scale = [t.scale[0], t.scale[1], t.scale[2]]
        else delete p.scale
        for (const [m, pp] of patchMeshes) {
          if (pp !== p) continue
          m.position.set(p.origin[0], p.origin[1], p.origin[2])
          m.rotationQuaternion = null
          const r = p.rot ?? [0, 0, 0]
          m.rotation.set(r[0], r[1], r[2])
          m.scaling.set(t.scale[0], t.scale[1], t.scale[2])
        }
        return
      }
      const b = placedStatics.find((x) => x.id === id)
      if (b) {
        b.pos = [t.position[0], t.position[1], t.position[2]]
        b.yaw = e[1]
        if (Math.abs(e[0]) > 1e-4 || Math.abs(e[2]) > 1e-4) b.rot = [e[0], e[1], e[2]]
        else delete b.rot
        if (t.scale.some((v) => Math.abs(v - 1) > 1e-4))
          b.scale = [t.scale[0], t.scale[1], t.scale[2]]
        else delete b.scale
        for (const [m, bb] of staticMeshes) {
          if (bb !== b) continue
          // A pose change is a cheap mesh update, never a rebuild.
          m.position.set(b.pos[0], b.pos[1], b.pos[2])
          m.rotationQuaternion = null
          m.rotation.set(e[0], e[1], e[2])
          m.scaling.set(t.scale[0], t.scale[1], t.scale[2])
        }
        return
      }
      const n = placedNodes.find((x) => x.id === id)
      if (n) {
        n.pos = [t.position[0], 0, t.position[2]]
        for (const [m, nn] of nodeMeshes)
          if (nn === n) m.position.set(n.pos[0], sampleH(n.pos[0], n.pos[2]) + 0.4, n.pos[2])
        return
      }
      const pr = placedProps.find((x) => x.id === id)
      if (pr) {
        pr.pos = [t.position[0], 1, t.position[2]]
        pr.yaw = e[1]
        for (const [m, p2] of propMeshes)
          if (p2 === pr) {
            m.position.set(pr.pos[0], sampleH(pr.pos[0], pr.pos[2]) + 0.5, pr.pos[2])
            m.rotation.y = pr.yaw ?? 0
          }
        return
      }
      const l = mapLightsArr.find((x) => x.id === id)
      if (l) {
        l.pos = [t.position[0], t.position[1], t.position[2]]
        if (l.type !== 'point') {
          const d = new Vector3(0, -1, 0)
          d.rotateByQuaternionToRef(
            new Quaternion(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]),
            d,
          )
          l.dir = [d.x, d.y, d.z]
        }
        refreshLightRender(l)
      }
    },
  }
  const xform = new TransformSession<undefined>(transformAccessor, history)
  /**
   * The gizmo always rides this node — single selection included. Nothing is
   * ever reparented, so a drag cannot disturb scene hierarchy, and the pivot
   * pose is the single input to the group delta.
   */
  const gizmoPivot = new TransformNode('gizmopivot', scene)
  const pivotTransform = (): EditorTransform => {
    const q = gizmoPivot.rotationQuaternion ?? Quaternion.Identity()
    return {
      position: [gizmoPivot.position.x, gizmoPivot.position.y, gizmoPivot.position.z],
      rotation: [q.x, q.y, q.z, q.w],
      scale: [gizmoPivot.scaling.x, gizmoPivot.scaling.y, gizmoPivot.scaling.z],
    }
  }
  /** Park the pivot on the selection centroid with an identity basis, so the
   *  gizmo reports pure deltas for the group inspector. */
  const attachGizmoToPivot = (): void => {
    refreshGizmoPivot()
    gizmos.attachToNode(gizmoPivot)
  }
  const refreshGizmoPivot = (): void => {
    const ts = selectionMgr
      .ids()
      .map((id) => transformAccessor.get(id))
      .filter((t): t is EditorTransform => t !== null)
    const c = centroidOf(ts)
    gizmoPivot.position.set(c[0], c[1], c[2])
    gizmoPivot.rotationQuaternion = Quaternion.Identity()
    gizmoPivot.scaling.setAll(1)
  }

  const outline = (mesh: Mesh): void => {
    mesh.renderOutline = true
    mesh.outlineColor = new Color3(0.4, 0.8, 1)
    mesh.outlineWidth = 0.06
  }
  /** Shared tail of every add/toggle: pivot, gizmo mode, locks, status. */
  const finishMultiChange = (): void => {
    if (multiTotal() === 0) {
      props.style.display = 'none'
      gizmos.attachToMesh(null)
      return
    }
    refreshGizmoPivot()
    const ids = [
      ...multiSel.map((it) => it.body.id).filter((x): x is string => Boolean(x)),
      ...multiPatches.map((it) => `terrain:${it.patch.id}`),
      ...multiNodes.map((it) => it.node.id).filter((x): x is string => Boolean(x)),
      ...multiProps.map((it) => it.prop.id).filter((x): x is string => Boolean(x)),
    ]
    fillMultiProps()
    afterSelect(ids, attachGizmoToPivot)
    status.textContent = `${multiTotal()} selected — move/rotate/scale together · Del deletes`
  }
  /** Group inspector: pivot position + delta rotation/scale inputs. */
  const fillMultiProps = (): void => {
    if (multiTotal() === 0) return
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = `${multiTotal()} objects (group)`
    for (const id of ['dims-box', 'dims-cyl', 'dims-sph']) $e(id).style.display = 'none'
    $e('light-rows').style.display = 'none'
    const r1 = (v: number): string => String(Number(v.toFixed(2)))
    $('p-x').value = r1(gizmoPivot.position.x)
    $('p-y').value = r1(gizmoPivot.position.y)
    $('p-z').value = r1(gizmoPivot.position.z)
    // Rotation and scale act as DELTAS applied to the whole group.
    $('r-x').value = '0'
    $('r-y').value = '0'
    $('r-z').value = '0'
    $('s-x').value = '1'
    $('s-y').value = '1'
    $('s-z').value = '1'
  }
  /** The starter island is placeholder — selectable so it can be wiped. */
  let mainSelected = false
  /**
   * The starter island is NOT special: transforming or deleting it
   * converts the top-level heightfield into a regular terrain patch (the
   * base grid sinks below the waterline). From then on it moves, tilts,
   * retextures and deletes like any other patch — and the ground sampler
   * follows patches, so spawns/nodes/props stay grounded.
   */
  const convertMainToPatch = (remove: boolean): PatchState | null => {
    const prev = heights.slice()
    let patch: PatchState | null = null
    if (!remove) {
      patch = {
        id: newId('patch'),
        origin: [0, 0, 0],
        halfExtent: HALF,
        sub: SUB,
        heights: heights.slice(),
      }
      patches.push(patch)
      buildPatchMesh(patch)
    }
    heights.fill(-6)
    const main = terrainTargets.find((t) => t.id === 'main')!
    refreshTarget(main)
    pushUndo({ kind: 'mainconvert', prev, patch })
    return patch
  }
  const selectMainTerrain = (): void => {
    deselect()
    mainSelected = true
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = 'starter island terrain'
    for (const id of ['dims-box', 'dims-cyl', 'dims-sph']) $e(id).style.display = 'none'
    status.textContent =
      'starter island — a normal terrain: move/tilt converts it to a patch, Del removes it'
    afterSelect(['terrain:main'], attachGizmoToPivot)
  }

  /** Patches: move + tilt the whole terrain patch. */
  /** Terrain inspector: a full transform — terrain scales like anything else. */
  const fillPatchProps = (patch: PatchState): void => {
    $e('props-title').textContent = `terrain (${patch.halfExtent * 2}m)`
    for (const id of ['dims-box', 'dims-cyl', 'dims-sph']) $e(id).style.display = 'none'
    $e('light-rows').style.display = 'none'
    const deg = (r: number): string => String(Math.round((r * 180) / Math.PI))
    const rot = patch.rot ?? [0, 0, 0]
    const sc = patch.scale ?? [1, 1, 1]
    $('p-x').value = String(patch.origin[0])
    $('p-y').value = String(patch.origin[1])
    $('p-z').value = String(patch.origin[2])
    $('r-x').value = deg(rot[0])
    $('r-y').value = deg(rot[1])
    $('r-z').value = deg(rot[2])
    $('s-x').value = String(sc[0])
    $('s-y').value = String(sc[1])
    $('s-z').value = String(sc[2])
    texSel.value = patch.tex === 'none' ? '' : (patch.tex ?? 'leafy_grass')
    texPicker.sync()
    ;($('p-color') as HTMLInputElement).value = patch.color ?? '#bfbfbf'
  }
  const selectPatch = (mesh: Mesh, patch: PatchState): void => {
    deselect()
    selectedPatch = { mesh, patch }
    setGizmoMode(gizmoMode)
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    fillPatchProps(patch)
    status.textContent = 'sculpt with the Terrain tool · move/rotate/SCALE like any object'
    afterSelect([`terrain:${patch.id}`], attachGizmoToPivot)
  }
  const rebuildSelectedMesh = (body: StaticObjectV2, oldMesh: Mesh): Mesh => {
    const wasSelected = selected?.mesh === oldMesh
    staticMeshes.delete(oldMesh)
    oldMesh.dispose()
    const m = renderStatic(body)
    if (wasSelected && selected) {
      selected.mesh = m
      gizmos.attachToMesh(m)
    }
    return m
  }
  const fillProps = (body: StaticObjectV2): void => {
    const deg = (r: number) => Math.round((r * 180) / Math.PI)
    const rot = body.rot ?? [0, body.yaw, 0]
    $('p-x').value = String(body.pos[0])
    $('p-y').value = String(body.pos[1])
    $('p-z').value = String(body.pos[2])
    $('r-x').value = String(deg(rot[0]))
    $('r-y').value = String(deg(rot[1]))
    $('r-z').value = String(deg(rot[2]))
    $e('dims-box').style.display = body.shape.type === 'box' ? 'flex' : 'none'
    $e('dims-cyl').style.display = body.shape.type === 'cylinder' ? 'flex' : 'none'
    $e('dims-sph').style.display = body.shape.type === 'sphere' ? 'flex' : 'none'
    if (body.shape.type === 'box') {
      $('d-x').value = String(body.shape.size[0])
      $('d-y').value = String(body.shape.size[1])
      $('d-z').value = String(body.shape.size[2])
    } else if (body.shape.type === 'cylinder') {
      $('d-r').value = String(body.shape.radius)
      $('d-h').value = String(body.shape.height)
    } else {
      $('d-sr').value = String(body.shape.radius)
    }
    const sc = body.scale ?? [1, 1, 1]
    $('s-x').value = String(sc[0])
    $('s-y').value = String(sc[1])
    $('s-z').value = String(sc[2])
    ;($('p-color') as HTMLInputElement).value = body.color
    texSel.value = body.tex ?? ''
    texPicker.sync()
    $e('light-rows').style.display = 'none'
    const lc = document.getElementById('p-lamp') as HTMLInputElement | null
    if (lc) lc.checked = body.decor === 'lamp'
  }
  const select = (mesh: Mesh, body: StaticObjectV2): void => {
    deselect()
    selected = { mesh, body, editBefore: null }
    setGizmoMode(gizmoMode)
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = `${body.shape.type} static`
    fillProps(body)
    afterSelect(body.id ? [body.id] : [], attachGizmoToPivot)
  }
  const snapshotBody = (b: StaticObjectV2): StaticObjectV2 =>
    JSON.parse(JSON.stringify(b)) as StaticObjectV2
  const commitEdit = (): void => {
    if (!selected?.editBefore) return
    pushUndo({
      kind: 'edit',
      body: selected.body,
      before: selected.editBefore,
      after: snapshotBody(selected.body),
    })
    selected.editBefore = null
  }
  const beginEdit = (): void => {
    if (selected && !selected.editBefore) selected.editBefore = snapshotBody(selected.body)
  }
  /**
   * Gizmo drags run through TransformSession: claim the gesture, snapshot the
   * selection's start transforms, recompute from those snapshots every frame,
   * and commit ONE history entry. There is no per-kind bake branch left, and
   * nothing is reparented.
   */
  /** Re-read the inspector fields for whatever single object is selected. */
  const refreshInspectorFor = (id: string, t: EditorTransform): void => {
    if (selected) return fillProps(selected.body)
    if (selectedLight) return fillLightProps(selectedLight.light)
    if (selectedPatch) return fillPatchProps(selectedPatch.patch)
    const deg = (r: number): string => String(Math.round((r * 180) / Math.PI))
    const e = eulerOf(t)
    $('p-x').value = String(Number(t.position[0].toFixed(3)))
    $('p-y').value = String(Number(t.position[1].toFixed(3)))
    $('p-z').value = String(Number(t.position[2].toFixed(3)))
    $('r-x').value = deg(e[0])
    $('r-y').value = deg(e[1])
    $('r-z').value = deg(e[2])
    void id
  }
  const wiredGizmos = new WeakSet<object>()
  function wireGizmoHooks(): void {
    for (const g of [
      gizmos.gizmos.positionGizmo,
      gizmos.gizmos.rotationGizmo,
      gizmos.gizmos.scaleGizmo,
    ]) {
      if (!g || wiredGizmos.has(g)) continue
      wiredGizmos.add(g)
      g.onDragStartObservable.add(() => {
        // Claimed BEFORE our canvas pointerdown handler runs (see the note at
        // the InteractionController) — this is what stops the click leaking
        // through to whatever sits behind the handle.
        interaction.begin('gizmo-drag', { x: scene.pointerX, y: scene.pointerY, pointerId: 0 })
        selectionMgr.freeze()
        const started = xform.begin(selectionMgr.ids(), gizmoMode, {
          isWritable: (id) => !lockOwners.has(id),
          label:
            `${gizmoMode} ${selectionMgr.size > 1 ? `${selectionMgr.size} objects` : ''}`.trim(),
        })
        if (!started) {
          // Nothing transformable (or a lock refused): let go of the gesture
          // rather than dragging a pivot that writes nowhere.
          selectionMgr.unfreeze()
          interaction.cancel()
          status.textContent = '🔒 selection is not editable'
        }
      })
      g.onDragObservable.add(() => {
        if (xform.active) xform.update(pivotTransform())
      })
      g.onDragEndObservable.add(() => {
        if (xform.active) {
          // Snap the committed pose for move drags (Alt bypasses).
          xform.commit()
          if (selectionMgr.size === 1) {
            const id = selectionMgr.primaryId!
            const t = transformAccessor.get(id)
            if (t) refreshInspectorFor(id, t)
          } else fillMultiProps()
        }
        interaction.end()
        selectionMgr.unfreeze()
        refreshGizmoPivot()
        refreshSelectionVisuals()
      })
    }
  }
  wireGizmoHooks()
  setGizmoMode('move')
  // Numeric property edits apply live.
  const applyManualPose = (): void => {
    // Group selection: pos is absolute pivot position; rot/scale are deltas
    // applied to the whole group, then baked as one compound undo entry.
    if (multiTotal() > 0) {
      const rad2 = (d: number) => (d * Math.PI) / 180
      const px = safeNum($('p-x').value)
      const py = safeNum($('p-y').value)
      const pz = safeNum($('p-z').value)
      if (px === null || py === null || pz === null) {
        fillMultiProps()
        return
      }
      const started = xform.begin(selectionMgr.ids(), 'move', { label: 'group transform' })
      if (!started) return
      const q = Quaternion.FromEulerAngles(
        rad2(Number($('r-x').value) || 0),
        rad2(Number($('r-y').value) || 0),
        rad2(Number($('r-z').value) || 0),
      )
      xform.update({
        position: [px, py, pz],
        rotation: [q.x, q.y, q.z, q.w],
        scale: [
          Number($('s-x').value) || 1,
          Number($('s-y').value) || 1,
          Number($('s-z').value) || 1,
        ],
      })
      xform.commit()
      refreshGizmoPivot()
      fillMultiProps()
      return
    }
    if (selectedLight) {
      const light = selectedLight.light
      const before = JSON.parse(JSON.stringify(light)) as MapLight
      light.pos = [Number($('p-x').value), Number($('p-y').value), Number($('p-z').value)]
      if (light.type !== 'point') {
        const rad2 = (d: number) => (d * Math.PI) / 180
        const q = Quaternion.FromEulerAngles(
          rad2(Number($('r-x').value) || 0),
          rad2(Number($('r-y').value) || 0),
          rad2(Number($('r-z').value) || 0),
        )
        const d = new Vector3(0, -1, 0)
        d.rotateByQuaternionToRef(q, d)
        light.dir = [d.x, d.y, d.z]
      }
      pushUndo({
        kind: 'lightedit',
        light,
        before,
        after: JSON.parse(JSON.stringify(light)) as MapLight,
      })
      refreshLightRender(light)
      return
    }
    // Manual numeric entry for the non-static selections.
    if (selectedNode) {
      const node = selectedNode.node
      const after: [number, number, number] = [Number($('p-x').value), 0, Number($('p-z').value)]
      pushUndo({ kind: 'nodemove', node, before: selectedNode.before, after })
      node.pos = after
      selectedNode.before = [after[0], after[1], after[2]]
      selectedNode.mesh.position.set(after[0], sampleH(after[0], after[2]) + 0.4, after[2])
    } else if (selectedPatch) {
      const patch = selectedPatch.patch
      const rad2 = (d: number) => (d * Math.PI) / 180
      patch.origin = [Number($('p-x').value), Number($('p-y').value), Number($('p-z').value)]
      const r: [number, number, number] = [
        rad2(Number($('r-x').value)),
        rad2(Number($('r-y').value)),
        rad2(Number($('r-z').value)),
      ]
      if (Math.abs(r[0]) > 0.001 || Math.abs(r[1]) > 0.001 || Math.abs(r[2]) > 0.001) patch.rot = r
      else delete patch.rot
      selectedPatch.mesh.position.set(patch.origin[0], patch.origin[1], patch.origin[2])
      selectedPatch.mesh.rotationQuaternion = null
      selectedPatch.mesh.rotation.set(r[0], r[1], r[2])
      markDirty()
    }
  }
  /** Reject NaN/Infinity (and non-positive dims) instead of corrupting. */
  const safeNum = (raw: string, positive = false): number | null => {
    const v = Number(raw)
    if (!Number.isFinite(v)) return null
    if (positive && v <= 0) return null
    if (Math.abs(v) > 100_000) return null
    return v
  }
  const propInput = (
    id: string,
    apply: (v: number, b: StaticObjectV2) => void,
    positive = false,
  ): void => {
    $(id).addEventListener('change', () => {
      const v = safeNum($(id).value, positive)
      if (v === null) {
        status.textContent = '⛔ invalid number'
        if (selected) fillProps(selected.body)
        return
      }
      if (!selected) {
        applyManualPose()
        return
      }
      beginEdit()
      apply(v, selected.body)
      rebuildSelectedMesh(selected.body, selected.mesh)
      commitEdit()
    })
  }
  const rad = (d: number) => (d * Math.PI) / 180
  propInput('p-x', (v, b) => (b.pos[0] = v))
  propInput('p-y', (v, b) => (b.pos[1] = v))
  propInput('p-z', (v, b) => (b.pos[2] = v))
  const setRot = (b: StaticObjectV2): void => {
    const r: [number, number, number] = [
      rad(Number($('r-x').value)),
      rad(Number($('r-y').value)),
      rad(Number($('r-z').value)),
    ]
    b.yaw = r[1]
    if (Math.abs(r[0]) > 0.001 || Math.abs(r[2]) > 0.001) b.rot = r
    else delete b.rot
  }
  for (const id of ['r-x', 'r-y', 'r-z'])
    $(id).addEventListener('change', () => {
      if (!selected) {
        applyManualPose()
        return
      }
      beginEdit()
      setRot(selected.body)
      rebuildSelectedMesh(selected.body, selected.mesh)
      commitEdit()
    })
  propInput('d-x', (v, b) => b.shape.type === 'box' && (b.shape.size[0] = v), true)
  propInput('d-y', (v, b) => b.shape.type === 'box' && (b.shape.size[1] = v), true)
  propInput('d-z', (v, b) => b.shape.type === 'box' && (b.shape.size[2] = v), true)
  propInput('d-r', (v, b) => b.shape.type === 'cylinder' && (b.shape.radius = v), true)
  propInput('d-h', (v, b) => b.shape.type === 'cylinder' && (b.shape.height = v), true)
  propInput('d-sr', (v, b) => b.shape.type === 'sphere' && (b.shape.radius = v), true)
  // Scale is a REAL transform component now, not a one-shot multiplier that
  // snapped back to 1. Dimensions live in their own Geometry fields; these
  // three write body.scale / patch.scale and go through the same accessor a
  // gizmo drag uses, so render and collision stay in step.
  for (const [id, axis] of [
    ['s-x', 0],
    ['s-y', 1],
    ['s-z', 2],
  ] as const) {
    $(id).addEventListener('change', () => {
      const v = safeNum($(id).value, true)
      const targetId = selectionMgr.size === 1 ? selectionMgr.primaryId : null
      if (v === null) {
        status.textContent = '⛔ scale must be a positive number'
        if (targetId) {
          const cur = transformAccessor.get(targetId)
          if (cur) $(id).value = String(cur.scale[axis])
        }
        return
      }
      if (selectionMgr.size > 1) {
        applyManualPose() // group: the three fields are a delta
        return
      }
      if (!targetId) return
      const cur = transformAccessor.get(targetId)
      if (!cur) return
      const next: EditorTransform = { ...cur, scale: [...cur.scale] as [number, number, number] }
      next.scale[axis] = v
      const started = xform.begin([targetId], 'scale', { label: 'scale' })
      if (!started) return
      xform.setOne(targetId, next)
      xform.commit()
      refreshGizmoPivot()
      const after = transformAccessor.get(targetId)
      if (after) refreshInspectorFor(targetId, after)
    })
  }
  /** Apply a color or texture change to EVERY selected object (one undo). */
  const groupApplyStyle = (change: { color?: string; tex?: string | null }): void => {
    const subOps: UndoOp[] = []
    const items: { body: StaticObjectV2; before: StaticObjectV2; after: StaticObjectV2 }[] = []
    for (const it of multiSel) {
      it.mesh.setParent(null)
      const before = snapshotBody(it.body)
      if (change.color !== undefined) it.body.color = change.color
      if (change.tex !== undefined) {
        if (change.tex) it.body.tex = change.tex
        else delete it.body.tex
      }
      it.mesh = rebuildSelectedMesh(it.body, it.mesh)
      items.push({ body: it.body, before, after: snapshotBody(it.body) })
      it.before = snapshotBody(it.body)
    }
    if (items.length > 0) subOps.push({ kind: 'batch', items })
    for (const it of multiPatches) {
      const patch = it.patch
      const before = {
        ...(patch.tex ? { tex: patch.tex } : {}),
        ...(patch.color ? { color: patch.color } : {}),
        ...(patch.uv ? { uv: { ...patch.uv } } : {}),
      }
      if (change.color !== undefined) patch.color = change.color
      if (change.tex !== undefined) patch.tex = change.tex ? change.tex : 'none'
      applyPatchMaterial(null, patch)
      subOps.push({
        kind: 'patchprop',
        patch,
        before,
        after: {
          ...(patch.tex ? { tex: patch.tex } : {}),
          ...(patch.color ? { color: patch.color } : {}),
          ...(patch.uv ? { uv: { ...patch.uv } } : {}),
        },
      })
    }
    if (subOps.length === 1) pushUndo(subOps[0]!)
    else if (subOps.length > 1) pushUndo({ kind: 'group', label: 'group style', ops: subOps })
    refreshGizmoPivot()
    refreshSelectionVisuals()
    status.textContent = `style applied to ${multiSel.length + multiPatches.length} objects`
  }
  $('p-color').addEventListener('change', () => {
    if (multiTotal() > 0) {
      groupApplyStyle({ color: ($('p-color') as HTMLInputElement).value })
      return
    }
    if (selectedLight) {
      const light = selectedLight.light
      const before = JSON.parse(JSON.stringify(light)) as MapLight
      light.color = ($('p-color') as HTMLInputElement).value
      pushUndo({
        kind: 'lightedit',
        light,
        before,
        after: JSON.parse(JSON.stringify(light)) as MapLight,
      })
      refreshLightRender(light)
      return
    }
    if (selectedPatch) {
      const patch = selectedPatch.patch
      const before = {
        ...(patch.tex ? { tex: patch.tex } : {}),
        ...(patch.color ? { color: patch.color } : {}),
      }
      patch.color = ($('p-color') as HTMLInputElement).value
      applyPatchMaterial(null, patch)
      pushUndo({
        kind: 'patchprop',
        patch,
        before,
        after: { ...(patch.tex ? { tex: patch.tex } : {}), color: patch.color },
      })
      return
    }
    if (!selected) return
    beginEdit()
    selected.body.color = ($('p-color') as HTMLInputElement).value
    rebuildSelectedMesh(selected.body, selected.mesh)
    commitEdit()
  })
  texSel.addEventListener('change', () => {
    if (multiTotal() > 0) {
      groupApplyStyle({ tex: texSel.value || null })
      return
    }
    if (selectedPatch) {
      const patch = selectedPatch.patch
      const before = {
        ...(patch.tex ? { tex: patch.tex } : {}),
        ...(patch.color ? { color: patch.color } : {}),
        ...(patch.uv ? { uv: { ...patch.uv } } : {}),
      }
      // '' from the picker = Plain Color (explicit 'none'; default is grass).
      patch.tex = texSel.value ? texSel.value : 'none'
      applyPatchMaterial(null, patch)
      pushUndo({
        kind: 'patchprop',
        patch,
        before,
        after: {
          ...(patch.tex ? { tex: patch.tex } : {}),
          ...(patch.color ? { color: patch.color } : {}),
          ...(patch.uv ? { uv: { ...patch.uv } } : {}),
        },
      })
      status.textContent = `patch texture: ${texSel.value ? prettyTexName(texSel.value) : 'plain color'}`
      return
    }
    if (!selected) return
    beginEdit()
    if (texSel.value) selected.body.tex = texSel.value
    else delete selected.body.tex
    rebuildSelectedMesh(selected.body, selected.mesh)
    commitEdit()
  })
  // Reset color: back to neutral (statics/lights) or untinted (patches).
  document.getElementById('p-color-reset')?.addEventListener('click', () => {
    if (multiTotal() > 0) {
      groupApplyStyle({ color: '#8a8d90' })
      return
    }
    if (selectedLight) {
      ;($('p-color') as HTMLInputElement).value = '#ffffff'
      $('p-color').dispatchEvent(new Event('change'))
      return
    }
    if (selectedPatch) {
      const patch = selectedPatch.patch
      const before = {
        ...(patch.tex ? { tex: patch.tex } : {}),
        ...(patch.color ? { color: patch.color } : {}),
        ...(patch.uv ? { uv: { ...patch.uv } } : {}),
      }
      delete patch.color
      applyPatchMaterial(null, patch)
      ;($('p-color') as HTMLInputElement).value = '#bfbfbf'
      pushUndo({
        kind: 'patchprop',
        patch,
        before,
        after: {
          ...(patch.tex ? { tex: patch.tex } : {}),
          ...(patch.uv ? { uv: { ...patch.uv } } : {}),
        },
      })
      status.textContent = 'patch tint reset'
      return
    }
    if (!selected) return
    ;($('p-color') as HTMLInputElement).value = '#8a8d90'
    $('p-color').dispatchEvent(new Event('change'))
  })
  const lampChk = document.getElementById('p-lamp') as HTMLInputElement | null
  lampChk?.addEventListener('change', () => {
    if (!selected) return
    beginEdit()
    if (lampChk.checked) selected.body.decor = 'lamp'
    else delete selected.body.decor
    commitEdit()
    status.textContent = lampChk.checked
      ? '💡 object emits lamplight after dark (visible in game)'
      : 'lamplight removed'
  })
  // ── Light property inputs → live edit + undo ────────────────────────
  const deg2rad = (d: number): number => (d * Math.PI) / 180
  $('l-int').addEventListener('change', () => {
    const v = safeNum($('l-int').value)
    if (v !== null && v >= 0) editLight((l) => (l.intensity = v))
  })
  $('l-range').addEventListener('change', () => {
    const v = safeNum($('l-range').value, true)
    if (v !== null) editLight((l) => (l.range = v))
  })
  $('l-angle').addEventListener('change', () => {
    const v = safeNum($('l-angle').value, true)
    if (v !== null) editLight((l) => (l.angle = deg2rad(Math.min(178, v))))
  })
  $('l-exp').addEventListener('change', () => {
    const v = safeNum($('l-exp').value)
    if (v !== null && v >= 0) editLight((l) => (l.exponent = v))
  })
  $('l-w').addEventListener('change', () => {
    const v = safeNum($('l-w').value, true)
    if (v !== null) editLight((l) => (l.size = [v, (l.size ?? LIGHT_DEFAULTS.size)[1]]))
  })
  $('l-h').addEventListener('change', () => {
    const v = safeNum($('l-h').value, true)
    if (v !== null) editLight((l) => (l.size = [(l.size ?? LIGHT_DEFAULTS.size)[0], v]))
  })
  $('l-ground').addEventListener('change', () => {
    editLight((l) => (l.ground = ($('l-ground') as HTMLInputElement).value))
  })
  $('l-spec').addEventListener('change', () => {
    editLight((l) => (l.specular = ($('l-spec') as HTMLInputElement).value))
  })
  $('l-shadows').addEventListener('change', () => {
    const on = ($('l-shadows') as HTMLInputElement).checked
    editLight((l) => {
      if (on) l.shadows = true
      else delete l.shadows
    })
    status.textContent = on
      ? '☂ shadows on (shadow lights are capped at 3 in game for performance)'
      : 'shadows off'
  })

  const deleteSelected = (): void => {
    if (selectedLight) {
      const { light } = selectedLight
      deselect()
      mapLightsArr = mapLightsArr.filter((l) => l !== light)
      removeLightRender(light)
      pushUndo({ kind: 'lightdelete', light })
      return
    }
    if (mainSelected) {
      deselect()
      convertMainToPatch(true)
      status.textContent = '🌊 starter island removed — one Ctrl+Z brings it back'
      return
    }
    if (multiTotal() > 0) {
      const pitems = [...multiPatches]
      const sitems = [...multiSel]
      const nitems = [...multiNodes]
      const pritems = [...multiProps]
      clearMulti()
      const subOps: UndoOp[] = []
      for (const it of pitems) {
        patches = patches.filter((pp) => pp !== it.patch)
        patchMeshes.delete(it.mesh)
        const ti = terrainTargets.findIndex((t) => t.patch === it.patch)
        if (ti >= 0) terrainTargets.splice(ti, 1)
        it.mesh.dispose()
        subOps.push({ kind: 'patchdelete', patch: it.patch })
      }
      for (const it of sitems) {
        placedStatics = placedStatics.filter((b) => b !== it.body)
        staticMeshes.delete(it.mesh)
        it.mesh.dispose()
      }
      if (sitems.length > 0)
        subOps.push({ kind: 'batchdelete', bodies: sitems.map((it) => it.body) })
      for (const it of nitems) {
        placedNodes = placedNodes.filter((n) => n !== it.node)
        nodeMeshes.delete(it.mesh)
        it.mesh.dispose()
        subOps.push({ kind: 'delete', node: it.node })
      }
      for (const it of pritems) {
        placedProps = placedProps.filter((x) => x !== it.prop)
        propMeshes.delete(it.mesh)
        it.mesh.dispose()
        subOps.push({ kind: 'propedit', add: false, prop: it.prop })
      }
      if (subOps.length === 1) pushUndo(subOps[0]!)
      else if (subOps.length > 1) pushUndo({ kind: 'group', label: 'group delete', ops: subOps })
      status.textContent = `${pitems.length + sitems.length + nitems.length + pritems.length} deleted (one undo restores all)`
      return
    }
    if (spawnSelected) {
      const before = spawnPos ? ([...spawnPos] as [number, number, number]) : null
      deselect()
      spawnPos = null
      placeSpawnFlag()
      pushUndo({ kind: 'spawnedit', before, after: null })
      return
    }
    if (selectedProp) {
      const { mesh, prop } = selectedProp
      deselect()
      placedProps = placedProps.filter((x) => x !== prop)
      propMeshes.delete(mesh)
      mesh.dispose()
      pushUndo({ kind: 'propedit', add: false, prop })
      return
    }
    if (selectedNode) {
      const { mesh, node } = selectedNode
      deselect()
      placedNodes = placedNodes.filter((n) => n !== node)
      nodeMeshes.delete(mesh)
      mesh.dispose()
      pushUndo({ kind: 'delete', node })
      return
    }
    if (selectedPatch) {
      const { mesh, patch } = selectedPatch
      deselect()
      patches = patches.filter((pp) => pp !== patch)
      patchMeshes.delete(mesh)
      const ti = terrainTargets.findIndex((t) => t.patch === patch)
      if (ti >= 0) terrainTargets.splice(ti, 1)
      mesh.dispose()
      pushUndo({ kind: 'patchdelete', patch })
      return
    }
    if (!selected) return
    const { mesh, body } = selected
    deselect()
    placedStatics = placedStatics.filter((s) => s !== body)
    staticMeshes.delete(mesh)
    mesh.dispose()
    pushUndo({ kind: 'delete', body })
  }
  $e('p-del').addEventListener('click', deleteSelected)
  $e('p-dup').addEventListener('click', () => {
    if (multiTotal() > 0) {
      const subOps: UndoOp[] = []
      const newBodies: { mesh: Mesh; body: StaticObjectV2 }[] = []
      for (const it of multiSel) {
        const copy = snapshotBody(it.body)
        copy.id = newId('s')
        copy.pos = [copy.pos[0] + 2, copy.pos[1], copy.pos[2] + 2]
        placedStatics.push(copy)
        newBodies.push({ mesh: renderStatic(copy), body: copy })
        subOps.push({ kind: 'place', body: copy })
      }
      for (const it of multiPatches) {
        const copy: PatchState = {
          ...it.patch,
          id: newId('patch'),
          origin: [it.patch.origin[0] + 2, it.patch.origin[1], it.patch.origin[2] + 2],
          heights: it.patch.heights.slice(),
        }
        patches.push(copy)
        buildPatchMesh(copy)
        subOps.push({ kind: 'patchadd', patch: copy })
      }
      if (subOps.length === 1) pushUndo(subOps[0]!)
      else if (subOps.length > 1) pushUndo({ kind: 'group', label: 'group duplicate', ops: subOps })
      status.textContent = `${subOps.length} duplicated`
      return
    }
    if (selectedLight) {
      const copy = JSON.parse(JSON.stringify(selectedLight.light)) as MapLight
      copy.id = newId('l')
      copy.pos = [copy.pos[0] + 1.5, copy.pos[1], copy.pos[2] + 1.5]
      mapLightsArr.push(copy)
      const m = renderLight(copy)
      pushUndo({ kind: 'lightadd', light: copy })
      selectLight(m, copy)
      return
    }
    if (!selected) return
    const copy = snapshotBody(selected.body)
    copy.id = newId('s')
    copy.pos = [copy.pos[0] + 1, copy.pos[1], copy.pos[2] + 1]
    placedStatics.push(copy)
    const m = renderStatic(copy)
    pushUndo({ kind: 'place', body: copy })
    select(m, copy)
  })

  // ── Face Edit tool (Hammer-style texture application) ───────────────
  interface FaceSel {
    mesh: Mesh
    body?: StaticObjectV2
    patch?: PatchState
    /** Box face index 0..5, or null = whole surface. */
    face: number | null
  }
  /**
   * Face selection is stored as objectId:face keys and RESOLVED to meshes on
   * demand, so a material change or an undo that rebuilds a mesh can never
   * strand it. Each selected face draws its own overlay — selecting one face
   * of a box no longer lights up all six.
   */
  const faceSelection = new FaceSelection()
  const faceOverlays = new FaceOverlayManager(scene)
  let fColorOn = false
  const meshForObjectId = (oid: string): Mesh | null => {
    for (const [m, b] of staticMeshes) if (b.id === oid) return m
    for (const [m, pp] of patchMeshes) if (`terrain:${pp.id}` === oid) return m
    return null
  }
  /** Current face selection resolved against live meshes. */
  const faceSel = (): FaceSel[] => {
    const out: FaceSel[] = []
    for (const r of faceSelection.refs()) {
      const mesh = meshForObjectId(r.objectId)
      if (!mesh) continue
      const body = staticMeshes.get(mesh)
      const patch = patchMeshes.get(mesh)
      out.push({ mesh, ...(body ? { body } : {}), ...(patch ? { patch } : {}), face: r.face })
    }
    return out
  }
  const syncFaceOverlays = (): void => {
    faceOverlays.sync(faceSelection.refs(), meshForObjectId)
  }
  const clearFaceSel = (): void => {
    faceSelection.clear()
    updateFaceInfo()
    syncFaceOverlays()
  }
  const updateFaceInfo = (): void => {
    $e('face-info').textContent = faceSelection.describe()
  }
  const faceStyleOf = (fs: FaceSel): FaceStyle => {
    if (fs.body) {
      const base: FaceStyle = {
        ...(fs.body.tex ? { tex: fs.body.tex } : {}),
        ...(fs.body.uv ?? {}),
      }
      if (fs.face !== null) return { ...base, ...(fs.body.faces?.[String(fs.face)] ?? {}) }
      return base
    }
    const p = fs.patch!
    return {
      ...(p.tex && p.tex !== 'none' ? { tex: p.tex } : {}),
      ...(p.color ? { color: p.color } : {}),
      ...(p.uv ?? {}),
    }
  }
  const liftFace = (fs: FaceSel): void => {
    const style = faceStyleOf(fs)
    faceTexSel.value = style.tex ?? ''
    faceTexPicker.sync()
    ;($('f-color') as HTMLInputElement).value = style.color ?? fs.body?.color ?? '#8a8d90'
    fColorOn = Boolean(style.color)
    $('f-sx').value = String(style.sx ?? 0)
    $('f-sy').value = String(style.sy ?? 0)
    $('f-ox').value = String(style.ox ?? 0)
    $('f-oy').value = String(style.oy ?? 0)
    $('f-rot').value = String(Math.round(((style.rot ?? 0) * 180) / Math.PI))
  }
  const collectFaceStyle = (): FaceStyle => {
    const style: FaceStyle = {}
    if (faceTexSel.value) style.tex = faceTexSel.value
    if (fColorOn) style.color = ($('f-color') as HTMLInputElement).value
    const num = (id: string): number => Number($(id).value) || 0
    if (num('f-sx') > 0) style.sx = num('f-sx')
    if (num('f-sy') > 0) style.sy = num('f-sy')
    if (num('f-ox') !== 0) style.ox = num('f-ox')
    if (num('f-oy') !== 0) style.oy = num('f-oy')
    if (num('f-rot') !== 0) style.rot = (num('f-rot') * Math.PI) / 180
    return style
  }
  const uvPart = (style: FaceStyle): FaceStyle => {
    const uv: FaceStyle = {}
    if (style.sx !== undefined) uv.sx = style.sx
    if (style.sy !== undefined) uv.sy = style.sy
    if (style.ox !== undefined) uv.ox = style.ox
    if (style.oy !== undefined) uv.oy = style.oy
    if (style.rot !== undefined) uv.rot = style.rot
    return uv
  }
  const patchPropSnapshot = (p: PatchState): { tex?: string; color?: string; uv?: FaceStyle } => ({
    ...(p.tex ? { tex: p.tex } : {}),
    ...(p.color ? { color: p.color } : {}),
    ...(p.uv ? { uv: { ...p.uv } } : {}),
  })
  /** Apply (or clear, with `reset`) the panel style to the given surfaces. */
  const applyFaceStyleTo = (targets: FaceSel[], reset = false): void => {
    if (targets.length === 0) {
      status.textContent = 'select a face first (click with the Face tool)'
      return
    }
    const style = reset ? {} : collectFaceStyle()
    const subOps: UndoOp[] = []
    const items: { body: StaticObjectV2; before: StaticObjectV2; after: StaticObjectV2 }[] = []
    // Group per body so a box with several selected faces rebuilds ONCE.
    const byBody = new Map<StaticObjectV2, FaceSel[]>()
    for (const fs of targets) {
      if (fs.body) {
        const list = byBody.get(fs.body) ?? []
        list.push(fs)
        byBody.set(fs.body, list)
      }
    }
    for (const [body, list] of byBody) {
      const before = snapshotBody(body)
      for (const fs of list) {
        if (fs.face !== null) {
          const faces = { ...(body.faces ?? {}) }
          if (reset || Object.keys(style).length === 0) delete faces[String(fs.face)]
          else faces[String(fs.face)] = { ...style }
          if (Object.keys(faces).length > 0) body.faces = faces
          else delete body.faces
        } else {
          if (reset) {
            delete body.tex
            delete body.uv
            delete body.faces
          } else {
            if (style.tex) body.tex = style.tex
            else delete body.tex
            if (style.color) body.color = style.color
            const uv = uvPart(style)
            if (Object.keys(uv).length > 0) body.uv = uv
            else delete body.uv
            delete body.faces // apply-to-object supersedes per-face overrides
          }
        }
      }
      const nm = rebuildSelectedMesh(body, list[0]!.mesh)
      // No fix-up needed for the selection itself: it is keyed by id, and
      // the overlays are rebuilt from the live mesh below.
      for (const fs of targets) if (fs.body === body) fs.mesh = nm
      items.push({ body, before, after: snapshotBody(body) })
    }
    if (items.length > 0) subOps.push({ kind: 'batch', items })
    for (const fs of targets) {
      if (!fs.patch) continue
      const patch = fs.patch
      const before = patchPropSnapshot(patch)
      if (reset) {
        delete patch.tex
        delete patch.color
        delete patch.uv
      } else {
        patch.tex = style.tex ?? 'none'
        if (style.color) patch.color = style.color
        const uv = uvPart(style)
        if (Object.keys(uv).length > 0) patch.uv = uv
        else delete patch.uv
      }
      applyPatchMaterial(null, patch)
      subOps.push({ kind: 'patchprop', patch, before, after: patchPropSnapshot(patch) })
    }
    if (subOps.length === 1) pushUndo(subOps[0]!)
    else if (subOps.length > 1)
      pushUndo({ kind: 'group', label: reset ? 'face reset' : 'face edit', ops: subOps })
    syncFaceOverlays()
    refreshSelectionVisuals()
    status.textContent = reset
      ? `${targets.length} surface(s) reset to defaults`
      : `🎨 style applied to ${targets.length} surface(s)`
  }
  const handleFacePointer = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 2) return
    // Faces come from the SAME central picker as object selection, so the
    // same exclusions (sky, brush, ghosts, overlays, gizmos) apply.
    const hit = picker.pickAtPointer({ kinds: ['static', 'model', 'terrain'] })
    if (!hit) {
      if (e.button === 0 && !e.ctrlKey && !e.metaKey) clearFaceSel()
      return
    }
    const mesh = hit.mesh as Mesh
    const body = staticMeshes.get(mesh)
    const face =
      body && body.shape.type === 'box' && hit.faceId >= 0 ? Math.floor(hit.faceId / 2) : null
    const ref = { objectId: hit.objectId, face }
    if (e.button === 2) {
      // Hammer right-click: paint that one face with the current settings.
      const patch = patchMeshes.get(mesh)
      applyFaceStyleTo([{ mesh, ...(body ? { body } : {}), ...(patch ? { patch } : {}), face }])
      return
    }
    // Ctrl adds/toggles (Shift kept as a legacy alias); Alt is the eyedropper.
    if (e.ctrlKey || e.metaKey || e.shiftKey) faceSelection.toggle(ref)
    else faceSelection.replace(ref)
    const first = faceSel()[0]
    if (first) liftFace(first)
    updateFaceInfo()
    syncFaceOverlays()
    refreshSelectionVisuals()
  }

  // ── Face Auto Apply ─────────────────────────────────────────────────
  // With Auto Apply on, every style control writes to the selected faces
  // immediately. Scrubbing a numeric field opens a transaction on pointer
  // down and commits ONE history entry on release — not one per frame.
  const autoApplyChk = document.getElementById('f-auto') as HTMLInputElement | null
  let autoApply = localStorage.getItem('hobo.editor.faceAutoApply') === 'on'
  if (autoApplyChk) {
    autoApplyChk.checked = autoApply
    autoApplyChk.addEventListener('change', () => {
      autoApply = autoApplyChk.checked
      localStorage.setItem('hobo.editor.faceAutoApply', autoApply ? 'on' : 'off')
      status.textContent = autoApply
        ? 'Auto Apply on — face style changes preview live'
        : 'Auto Apply off — use Apply'
    })
  }
  const autoApplyNow = (): void => {
    if (!autoApply || faceSelection.size === 0) return
    applyFaceStyleTo(faceSel())
  }
  /** Wrap a face control so a continuous interaction is ONE undo entry. */
  const wireFaceControl = (id: string): void => {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (!el) return
    let open = false
    const begin = (): void => {
      if (open || !autoApply) return
      open = true
      history.beginTransaction('face style')
    }
    const end = (): void => {
      if (!open) return
      open = false
      history.commitTransaction('face style')
      updateDirty()
    }
    el.addEventListener('pointerdown', begin)
    el.addEventListener('focus', begin)
    el.addEventListener('input', () => {
      if (open) autoApplyNow()
    })
    el.addEventListener('change', () => {
      if (!open) begin()
      autoApplyNow()
      end()
    })
    el.addEventListener('blur', end)
    window.addEventListener('pointerup', () => {
      if (open) end()
    })
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        history.cancelTransaction()
        open = false
        syncFaceOverlays()
      }
    })
  }
  for (const id of ['f-sx', 'f-sy', 'f-ox', 'f-oy', 'f-rot', 'f-color']) wireFaceControl(id)
  faceTexSel.addEventListener('change', () => {
    if (autoApply) applyFaceStyleTo(faceSel())
  })

  $e('f-apply').addEventListener('click', () => applyFaceStyleTo(faceSel()))
  $e('f-apply-all').addEventListener('click', () =>
    applyFaceStyleTo(faceSel().map((fs) => ({ ...fs, face: null }))),
  )
  $e('f-clear').addEventListener('click', () => applyFaceStyleTo(faceSel(), true))
  $e('f-lift').addEventListener('click', () => {
    const first = faceSel()[0]
    if (first) liftFace(first)
  })
  $('f-color').addEventListener('input', () => (fColorOn = true))
  $e('f-color-clear').addEventListener('click', () => {
    fColorOn = false
    status.textContent = 'tint cleared — Apply writes the face without a tint'
  })
  const justify = (patchVals: Partial<Record<'f-sx' | 'f-sy' | 'f-ox' | 'f-oy', number>>): void => {
    for (const [id, v] of Object.entries(patchVals)) $(id).value = String(v)
    applyFaceStyleTo(faceSel())
  }
  $e('f-fit').addEventListener('click', () =>
    justify({ 'f-sx': 1, 'f-sy': 1, 'f-ox': 0, 'f-oy': 0 }),
  )
  const fracOf = (id: string): number => {
    const v = Number($(id).value) || 0
    return v > 0 ? v - Math.floor(v) : 0
  }
  $e('f-jl').addEventListener('click', () => justify({ 'f-ox': 0 }))
  $e('f-jr').addEventListener('click', () => justify({ 'f-ox': (1 - fracOf('f-sx')) % 1 }))
  $e('f-jt').addEventListener('click', () => justify({ 'f-oy': 0 }))
  $e('f-jb').addEventListener('click', () => justify({ 'f-oy': (1 - fracOf('f-sy')) % 1 }))
  $e('f-jc').addEventListener('click', () =>
    justify({ 'f-ox': ((1 - fracOf('f-sx')) / 2) % 1, 'f-oy': ((1 - fracOf('f-sy')) / 2) % 1 }),
  )

  /**
   * Project the selection set onto the per-kind view state. Single selections
   * keep their rich inspector; two or more become the group (multi) path.
   */
  const rebuildSelectionViews = (): void => {
    const ids = selectionMgr.ids()
    // The whole projection runs guarded: select()/selectNode()/... each begin
    // with their own deselect(), and any of those would otherwise wipe the
    // authority we are currently projecting.
    projectingSelection = true
    try {
      rebuildSelectionViewsInner(ids)
    } finally {
      projectingSelection = false
    }
  }
  const rebuildSelectionViewsInner = (ids: string[]): void => {
    deselect() // legacy view teardown only
    if (ids.length === 0) return
    const meshFor = (oid: string): { mesh: Mesh; kind: string } | null => {
      for (const [m, b] of staticMeshes) if (b.id === oid) return { mesh: m, kind: 'static' }
      for (const [m, n] of nodeMeshes) if (n.id === oid) return { mesh: m, kind: 'node' }
      for (const [m, pr] of propMeshes) if (pr.id === oid) return { mesh: m, kind: 'prop' }
      for (const [m, pp] of patchMeshes)
        if (`terrain:${pp.id}` === oid) return { mesh: m, kind: 'patch' }
      for (const [m, l] of lightMeshes) if (l.id === oid) return { mesh: m, kind: 'light' }
      return null
    }
    if (ids.length === 1) {
      const oid = ids[0]!
      if (oid === 'spawn') return selectSpawn()
      if (oid === 'terrain:main') return selectMainTerrain()
      const found = meshFor(oid)
      if (!found) return
      const { mesh, kind } = found
      if (kind === 'static') return select(mesh, staticMeshes.get(mesh)!)
      if (kind === 'node') return selectNode(mesh, nodeMeshes.get(mesh)!)
      if (kind === 'prop') return selectProp(mesh, propMeshes.get(mesh)!)
      if (kind === 'patch') return selectPatch(mesh, patchMeshes.get(mesh)!)
      if (kind === 'light') return selectLight(mesh, lightMeshes.get(mesh)!)
      return
    }
    for (const oid of ids) {
      const found = meshFor(oid)
      if (!found) continue
      const { mesh, kind } = found
      if (kind === 'static') {
        const body = staticMeshes.get(mesh)!
        multiSel.push({ mesh, body, before: snapshotBody(body) })
      } else if (kind === 'node') {
        const node = nodeMeshes.get(mesh)!
        multiNodes.push({ mesh, node, before: [...node.pos] })
      } else if (kind === 'prop') {
        const prop = propMeshes.get(mesh)!
        multiProps.push({ mesh, prop, before: [...prop.pos] })
      } else if (kind === 'patch') {
        const patch = patchMeshes.get(mesh)!
        multiPatches.push({
          mesh,
          patch,
          before: { origin: [...patch.origin], ...(patch.rot ? { rot: [...patch.rot] } : {}) },
        })
      } else continue
      outline(mesh)
    }
    finishMultiChange()
  }
  /** Clear both the authority and its projection. */
  const clearSelection = (): void => {
    selectionMgr.clear()
    deselect()
  }

  // ── Pointer handling ────────────────────────────────────────────────
  let lastModifiers: { ctrlKey: boolean; metaKey: boolean; altKey: boolean } = {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  }
  let painting = 0 // 0 none, 1 = LMB, 2 = RMB (lower)
  let mouseIsDown = false
  window.addEventListener('pointerdown', (e) => {
    if (e.button === 0 || e.button === 2) mouseIsDown = true
  })
  window.addEventListener('pointermove', (e) => {
    interaction.move(e.clientX, e.clientY)
  })
  window.addEventListener('pointerup', () => {
    mouseIsDown = false
    // No timeout safety net any more: every gesture ends explicitly, and a
    // gizmo drag ends in its own onDragEndObservable.
    const wasClick = interaction.is('selection-click-candidate', 'terrain-sculpt', 'surface-paint')
      ? interaction.end()
      : false
    if (!wasClick || tool !== 'select') return
    // ONE central pick, ONE result — no per-kind pick passes, no
    // "smallest patch within 1.5m" heuristics, no multi-terrain selection.
    const hit = picker.pickAtPointer()
    const mode = selectModeFromEvent(lastModifiers)
    if (selectionMgr.applyClick(hit?.objectId ?? null, mode)) rebuildSelectionViews()
  })
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('pointerdown', (e) => {
    if (freeLook) return
    if (e.button !== 0 && e.button !== 2) return
    // The gizmo (or any other gesture) may already own this pointer.
    if (!interaction.canStartGesture()) return
    mouseIsDown = true // canvas handler runs before the window listener
    const sign = e.button === 2 ? -1 : 1
    if (tool === 'terrain') {
      const t = pickTerrainTarget()
      if (!t) return
      const lockId = t.target.id === 'main' ? 'terrain:main' : `terrain:${t.target.id}`
      if (lockOwners.has(lockId)) {
        status.textContent = `🔒 terrain locked by ${lockOwners.get(lockId)!.name}`
        return
      }
      const begin = (): void => {
        strokeTarget = t.target
        strokeBefore = t.target.heights.slice()
        painting = sign
        applySculpt(sign)
      }
      if (lockState === 'owned' && myLockedIds.includes(lockId)) {
        begin() // already hold this terrain's lock — sculpt immediately
      } else {
        // First stroke on a target: acquire, then begin once GRANTED (the
        // heightfield is never touched while the lock is pending).
        requestLock([lockId], () => {
          if (mouseIsDown) begin()
        })
      }
    } else if (tool === 'paint' && e.button === 0) {
      const t = pickTerrainTarget()
      if (!t) return
      paintTarget = t.target
      if (t.target.id === 'main') {
        paintBefore = mixCtx.getImageData(0, 0, MIX, MIX)
      } else if (t.target.patch) {
        // Allocating the layer BEFORE the stroke means a full surface reports
        // its budget instead of silently painting nothing.
        if (!beginPaintStroke(t.target.patch)) return
      }
      painting = 1
      applyPaint()
    } else if ((tool === 'mesh' || tool === 'entity') && e.button === 0) {
      const pose = computePlacePose()
      if (pose) placeAt(pose)
    } else if (tool === 'light' && e.button === 0) {
      const pick = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (m) =>
          m !== ghost && m !== wire && m.isEnabled() && m.isPickable && !lightMeshes.has(m as Mesh),
      )
      if (!pick?.hit || !pick.pickedPoint) return
      if (mapLightsArr.length >= 24) {
        status.textContent = '⛔ light cap reached (24) — delete some first'
        return
      }
      const t = (document.getElementById('light-sel') as HTMLSelectElement)
        .value as MapLight['type']
      const p = pick.pickedPoint
      const high = t === 'directional' || t === 'hemi'
      const l: MapLight = {
        id: newId('l'),
        type: t,
        pos: [p.x, p.y + (high ? 10 : 2.5), p.z],
        ...(t === 'point' ? {} : { dir: t === 'directional' ? [-0.4, -1, -0.3] : [0, -1, 0] }),
      }
      mapLightsArr.push(l)
      const m = renderLight(l)
      pushUndo({ kind: 'lightadd', light: l })
      status.textContent = `${LIGHT_LABEL[t]} placed — Select tool edits/moves it`
      void m
    } else if (tool === 'face') {
      handleFacePointer(e)
    } else if (tool === 'select' && e.button === 0) {
      // Selection resolves on RELEASE, and only if the pointer barely moved:
      // a drag is never a click. The pick itself happens once, there.
      // Modifiers are captured at PRESS: that is where the user expressed
      // intent, and they may release Ctrl/Alt before the mouse button.
      lastModifiers = { ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }
      interaction.begin('selection-click-candidate', {
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
      })
    }
  })
  window.addEventListener('pointerup', () => {
    if (painting && strokeBefore && strokeTarget) {
      pushUndo({
        kind: 'terrain',
        target: strokeTarget.id,
        before: strokeBefore,
        after: strokeTarget.heights.slice(),
      })
      strokeBefore = null
      strokeTarget = null
    }
    if (painting && paintTarget?.patch) endPaintStroke(paintTarget.patch)
    if (painting && paintBefore && paintTarget) {
      if (paintTarget.id === 'main') {
        pushUndo({ kind: 'paint', before: paintBefore, after: mixCtx.getImageData(0, 0, MIX, MIX) })
      }
      paintBefore = null
    }
    paintTarget = null
    painting = 0
  })
  canvas.addEventListener('pointermove', () => {
    if (!painting || freeLook) return
    if (tool === 'paint') applyPaint()
    else applySculpt(painting)
  })
  /** Pick whichever terrain (main or patch) is under the cursor. */
  function pickTerrainTarget(): { target: TerrainTarget; local: Vector3 } | null {
    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (m) => m.isEnabled() && (m === terrain || patchMeshes.has(m as Mesh)),
    )
    if (!pick?.hit || !pick.pickedPoint || !pick.pickedMesh) return null
    const target = terrainTargets.find((t) => t.mesh === pick.pickedMesh)
    if (!target) return null
    // Patch sculpting happens in patch-local space (patches can be tilted).
    const inv = pick.pickedMesh.getWorldMatrix().clone().invert()
    const local = Vector3.TransformCoordinates(pick.pickedPoint, inv)
    return { target, local }
  }
  function applySculpt(sign: number): void {
    const t = pickTerrainTarget()
    if (!t) return
    if (strokeTarget && t.target !== strokeTarget) return // one target per stroke
    sculpt(t.target, t.local.x, t.local.z, sign)
  }
  function applyPaint(): void {
    const t = pickTerrainTarget()
    if (!t) return
    if (paintTarget && t.target !== paintTarget) return // one target per stroke
    if (t.target.id === 'main') {
      paint(t.local.x, t.local.z)
      return
    }
    const patch = t.target.patch
    if (!patch) return
    const layer = activePaintLayer(patch)
    if (!layer) return
    const rt = ensureSurface(patch, t.target.mesh)
    const size = rt.mask.size
    // Patch-local metres → mask pixels.
    const u = ((t.local.x + patch.halfExtent) / (patch.halfExtent * 2)) * size
    const v = (1 - (t.local.z + patch.halfExtent) / (patch.halfExtent * 2)) * size
    rt.mask.stamp(layer.channel, {
      u,
      v,
      radius: (Number($('radius').value) / (patch.halfExtent * 2)) * size,
      strength: Math.min(1, Number($('strength').value)),
      feather: Number($('feather').value),
      erase: ($('paint-erase') as HTMLInputElement | null)?.checked ?? false,
    })
  }

  // ── Paint layers ────────────────────────────────────────────────────
  const paintTexSel = document.getElementById('paint-tex') as HTMLSelectElement
  // NOTE: the picker itself is constructed further down, next to the other
  // texture pickers — createTexPicker() reads its option provider eagerly,
  // and `texOptions` is declared there (TDZ if we build it here).
  /**
   * The layer the brush writes into: the one already using the chosen
   * texture, or a freshly allocated channel. Returns null (with a clear
   * message) when the surface is at its four-layer budget — the base texture
   * is NEVER swapped out to make room.
   */
  /** '' in the picker means Plain Colour, which the model calls 'none'. */
  const paintTint = (): string | undefined => {
    const el = document.getElementById('paint-color') as HTMLInputElement | null
    const v = el?.value ?? '#ffffff'
    // White = untinted; storing it would create a needless second layer.
    return v.toLowerCase() === '#ffffff' ? undefined : v
  }
  const activePaintLayer = (patch: PatchState): PaintLayer | null => {
    const tex = paintTexSel.value || 'none'
    const color = paintTint()
    if (tex === 'none' && !color) {
      status.textContent = 'Plain Colour paint needs a colour — pick one'
      return null
    }
    const data = surfaceDataOf(patch)
    const alloc = allocateLayer(data.paint, tex, () => newId('pl'), color)
    if (!alloc) {
      status.textContent = `⛔ this surface already uses ${MAX_PAINT_LAYERS} paint layers — remove one in the layer list`
      renderPaintLayers()
      return null
    }
    data.paint = alloc.paint
    if (alloc.created) {
      refreshSurface(patch)
      renderPaintLayers()
    }
    return alloc.layer
  }
  document.getElementById('paint-color-reset')?.addEventListener('click', () => {
    const el = document.getElementById('paint-color') as HTMLInputElement | null
    if (el) el.value = '#ffffff'
    status.textContent = 'paint tint cleared — strokes use the texture untinted'
  })
  const beginPaintStroke = (patch: PatchState): boolean => {
    const mesh = [...patchMeshes].find(([, pp]) => pp === patch)?.[0]
    if (!mesh) return false
    if (!activePaintLayer(patch)) return false
    ensureSurface(patch, mesh).mask.beginStroke()
    return true
  }
  const endPaintStroke = (patch: PatchState): void => {
    const rt = surfaces.get(patch.id)
    if (!rt) return
    const delta = rt.mask.endStroke()
    if (!delta) return
    const data = surfaceDataOf(patch)
    if (data.paint) data.paint.mask = rt.mask.toDataURL()
    pushUndo({ kind: 'maskpaint', patchId: patch.id, before: delta.before, after: delta.after })
  }
  /** Layer manager for the selected paintable surface. */
  const renderPaintLayers = (): void => {
    const host = document.getElementById('paint-layers')
    if (!host) return
    host.replaceChildren()
    const patch = selectedPatch?.patch ?? paintTarget?.patch ?? null
    if (!patch) {
      const d = document.createElement('div')
      d.style.color = '#78828e'
      d.textContent = 'select a terrain to manage its layers'
      host.appendChild(d)
      return
    }
    const data = surfaceDataOf(patch)
    const base = document.createElement('div')
    base.style.color = '#9aa4b0'
    base.textContent = `base: ${data.base.tex ? prettyTexName(data.base.tex) : 'plain colour'}`
    host.appendChild(base)
    for (const layer of data.paint?.layers ?? []) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:4px;align-items:center'
      const vis = document.createElement('input')
      vis.type = 'checkbox'
      vis.checked = !layer.hidden
      vis.title = 'visible'
      vis.addEventListener('change', () => {
        if (vis.checked) delete layer.hidden
        else layer.hidden = true
        refreshSurface(patch)
        markDirty()
      })
      const name = document.createElement('span')
      name.style.flex = '1'
      name.textContent = `${layer.channel.toUpperCase()} · ${
        layer.tex === 'none' ? 'Plain Colour' : prettyTexName(layer.tex)
      }`
      // Editing a layer's tint restyles everywhere that layer is painted.
      const tint = document.createElement('input')
      tint.type = 'color'
      tint.value = layer.color ?? '#ffffff'
      tint.title = 'layer tint'
      tint.style.width = '28px'
      tint.addEventListener('change', () => {
        if (tint.value.toLowerCase() === '#ffffff') delete layer.color
        else layer.color = tint.value
        refreshSurface(patch)
        markDirty()
      })
      const clear = document.createElement('button')
      clear.className = 'mini'
      clear.textContent = '␡'
      clear.title = 'clear this layer’s painted area'
      clear.addEventListener('click', () => {
        surfaces.get(patch.id)?.mask.clearChannel(layer.channel)
        const url = surfaces.get(patch.id)?.mask.toDataURL()
        if (data.paint && url) data.paint.mask = url
        markDirty()
      })
      const del = document.createElement('button')
      del.className = 'mini'
      del.textContent = '🗑'
      del.title = 'remove the layer (frees its channel)'
      del.addEventListener('click', () => {
        if (!data.paint) return
        surfaces.get(patch.id)?.mask.clearChannel(layer.channel)
        removeLayer(data.paint, layer.id)
        const url2 = surfaces.get(patch.id)?.mask.toDataURL()
        if (url2) data.paint.mask = url2
        refreshSurface(patch)
        renderPaintLayers()
        markDirty()
      })
      row.append(vis, name, tint, clear, del)
      host.appendChild(row)
    }
  }

  // ── Input: one action system drives everything ──────────────────────
  const heldCodes = new Set<string>()
  const holding = (action: string): boolean => {
    const b = bindingOf(action)
    return heldCodes.has(b.code === 'ShiftRight' ? 'ShiftLeft' : b.code)
  }
  const nudgeSlider = (id: string, step: number): void => {
    const el = $(id)
    el.value = String(Math.max(Number(el.min), Math.min(Number(el.max), Number(el.value) + step)))
    el.dispatchEvent(new Event('input'))
    status.textContent = `${id}: ${el.value}`
  }
  const runAction = (action: string): boolean => {
    switch (action) {
      case 'tool.terrain':
      case 'tool.paint':
      case 'tool.entity':
      case 'tool.mesh':
      case 'tool.select':
      case 'tool.face':
      case 'tool.light':
        setTool(action.slice(5) as Tool)
        return true
      case 'xf.move':
        setGizmoMode('move')
        return true
      case 'xf.rotate':
        setGizmoMode('rotate')
        return true
      case 'xf.scale':
        setGizmoMode('scale')
        return true
      case 'edit.undo':
        undo()
        return true
      case 'edit.redo':
        redo()
        return true
      case 'edit.duplicate':
        $e('p-dup').click()
        return true
      case 'edit.delete':
        deleteSelected()
        return true
      case 'edit.cancel':
        clearSelection()
        return true
      case 'edit.save':
        saveBtn.click()
        return true
      case 'cam.freelook':
        if (document.pointerLockElement === canvas) document.exitPointerLock()
        else void canvas.requestPointerLock()
        return true
      case 'cam.frame': {
        const target = gizmos.attachedMesh ?? gizmos.attachedNode
        if (target) {
          const pos = (target as TransformNode).getAbsolutePosition()
          camera.setTarget(pos.clone())
          const dir = camera.getForwardRay(1).direction
          camera.position = pos.subtract(dir.scale(18))
        }
        return true
      }
      case 'brush.radiusUp':
        nudgeSlider('radius', 1)
        return true
      case 'brush.radiusDown':
        nudgeSlider('radius', -1)
        return true
      case 'brush.strengthUp':
        nudgeSlider('strength', 0.05)
        return true
      case 'brush.strengthDown':
        nudgeSlider('strength', -0.05)
        return true
      case 'ui.sidebar':
        collapseBtn.click()
        return true
      case 'ui.settings':
        document.getElementById('settings-btn')?.click()
        return true
      default:
        return false
    }
  }
  const typingTarget = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement
    return (
      t.tagName === 'INPUT' ||
      t.tagName === 'SELECT' ||
      t.tagName === 'TEXTAREA' ||
      t.isContentEditable
    )
  }
  window.addEventListener('keydown', (e) => {
    if (typingTarget(e)) return
    heldCodes.add(e.code === 'ShiftRight' ? 'ShiftLeft' : e.code)
    shift = holding('xf.nosnap') || e.shiftKey
    // Triggered actions: most-specific binding wins (redo before undo).
    const candidates = ACTIONS.filter((a) => !a.hold && bindingMatches(bindingOf(a.id), e)).sort(
      (a, b2) =>
        Number(Boolean(bindingOf(b2.id).shift)) +
        Number(Boolean(bindingOf(b2.id).ctrl)) -
        (Number(Boolean(bindingOf(a.id).shift)) + Number(Boolean(bindingOf(a.id).ctrl))),
    )
    for (const a of candidates) {
      if (runAction(a.id)) {
        e.preventDefault()
        return
      }
    }
  })
  window.addEventListener('keyup', (e) => {
    heldCodes.delete(e.code === 'ShiftRight' ? 'ShiftLeft' : e.code)
    shift = holding('xf.nosnap') || (e.shiftKey && e.key !== 'Shift')
  })
  window.addEventListener('blur', () => heldCodes.clear())

  // Manual camera flight from held bindings — no Babylon keyboard input to
  // fight with (Q/E vs tools conflicts are gone; every key is remappable).
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000
    env.update(dt, camera.position)
    if (!interaction.flightAllowed()) return
    const speed = (holding('cam.fast') ? 34 : 11) * dt
    const move = new Vector3(
      (holding('cam.right') ? 1 : 0) - (holding('cam.left') ? 1 : 0),
      (holding('cam.up') ? 1 : 0) - (holding('cam.down') ? 1 : 0),
      (holding('cam.forward') ? 1 : 0) - (holding('cam.back') ? 1 : 0),
    )
    if (move.lengthSquared() > 0) {
      const fwd = camera.getDirection(new Vector3(0, 0, 1))
      const right = camera.getDirection(new Vector3(1, 0, 0))
      camera.position.addInPlace(fwd.scale(move.z * speed))
      camera.position.addInPlace(right.scale(move.x * speed))
      camera.position.y += move.y * speed
    }
  })

  // ── Brush cursor + wireframe + ghost per-frame ──────────────────────
  const brush = CreateSphere('brush', { diameter: 1, segments: 8 }, scene)
  const bm = new StandardMaterial('bm', scene)
  bm.emissiveColor = new Color3(0.4, 0.8, 1)
  bm.alpha = 0.3
  bm.disableLighting = true
  brush.material = bm
  brush.isPickable = false
  let frameTick = 0
  scene.onBeforeRenderObservable.add(() => {
    const sculpting = tool === 'terrain' || tool === 'paint'
    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (m) => m.isEnabled() && (m === terrain || patchMeshes.has(m as Mesh)),
    )
    const overTerrain = Boolean(pick?.hit && pick.pickedPoint)
    // Hover highlight for the Select tool (cheap: every 6th frame).
    if (tool === 'select' && interaction.pickingAllowed() && ++frameTick % 6 === 0) {
      const hp = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (m) =>
          m.isEnabled() &&
          (staticMeshes.has(m as Mesh) ||
            nodeMeshes.has(m as Mesh) ||
            propMeshes.has(m as Mesh) ||
            lightMeshes.has(m as Mesh)),
      )
      const hm = (hp?.pickedMesh as Mesh | undefined) ?? null
      if (hm !== hoverMesh) {
        hoverMesh = hm
        refreshSelectionVisuals()
      }
    } else if (tool !== 'select' && hoverMesh) {
      hoverMesh = null
      refreshSelectionVisuals()
    }
    if (sculpting && overTerrain && pick!.pickedPoint) {
      brush.position.copyFrom(pick!.pickedPoint)
      const r = Number($('radius').value)
      brush.scaling.set(r, r, r)
      brush.setEnabled(true)
    } else brush.setEnabled(false)
    // Wireframes: hovered terrain shows its own wire; a stroke in progress
    // pins the wire to the stroke target (no flicker when the cursor slips
    // off-mesh mid-drag); selected patches keep theirs visible.
    const hoverMeshT = overTerrain ? (pick!.pickedMesh as Mesh) : null
    wireHover =
      (tool === 'terrain' && hoverMeshT === terrain) ||
      (painting !== 0 && strokeTarget?.id === 'main')
    wire.setEnabled(wireHover || mainSelected)
    // Selection visuals derive from the selection SET, never from mesh
    // identity: undo, a remote merge or a material change all rebuild meshes,
    // and a selected terrain's wire must survive every one of them.
    const selectedTerrains = new Set(selectionMgr.ids().filter((id) => id.startsWith('terrain:')))
    for (const [pm, pw] of patchWires) {
      const p = patchMeshes.get(pm)
      const on =
        (tool === 'terrain' && hoverMeshT === pm) ||
        (p !== undefined && selectedTerrains.has(`terrain:${p.id}`)) ||
        (painting !== 0 && strokeTarget?.mesh === pm)
      pw.setEnabled(on)
    }
    if (tool === 'mesh' || tool === 'entity') {
      const pose = computePlacePose()
      const g = ensureGhost()
      if (g && pose) {
        g.setEnabled(true)
        g.position.copyFrom(pose.pos)
        g.rotationQuaternion = pose.rot
      } else g?.setEnabled(false)
    }
  })

  /**
   * Cheap change signature for the remote-merge poll, seeded from the BOOT
   * map: leaving it empty made the very first poll rebuild the whole world.
   */
  const sigOfDoc = (m: MapFileV2): string =>
    `${m.terrains.length}:${m.statics.length}:${m.nodes.length}:${m.props.length}:${m.lights.length}:${m.models.length}:${m.textures.length}`
  let lastSig = sigOfDoc(bootDoc)
  /** Revision of the map we last loaded — sent as If-Match on save. */
  let baseRevision = bootRevision

  // ── Save ────────────────────────────────────────────────────────────
  /** Serialize the editor's state as a native v2 document. */
  const buildFile = (): MapFileV2 => ({
    v: 2,
    terrains: patches.map((pp) => ({
      id: pp.id,
      pos: pp.origin,
      halfExtent: pp.halfExtent,
      sub: pp.sub,
      heights: encodeHeights(pp.heights),
      ...(pp.rot ? { rot: pp.rot } : {}),
      ...(pp.scale ? { scale: pp.scale } : {}),
      surface: surfaceDataOf(pp),
    })),
    statics: placedStatics,
    nodes: placedNodes,
    props: placedProps,
    lights: mapLightsArr,
    zones: mapZones,
    models: mapModels,
    textures: mapTextures,
    ...(spawnPos ? { spawn: spawnPos, spawnYaw } : {}),
  })
  document.getElementById('save')?.addEventListener('click', () => {
    void (async () => {
      const key = $('key').value.trim()
      localStorage.setItem('hobo.editorkey', key)
      status.textContent = 'saving…'
      const file = buildFile()
      const resp = await fetch('/api/map', {
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
      const served = resp.headers.get('etag')?.replace(/"/g, '')
      if (served) baseRevision = served
      if (resp.ok) {
        history.markSaved()
        nonHistoryDirt = false
        updateDirty()
        lastSig = sigOfDoc(file)
      }
      if (resp.status === 409) {
        $e('conflict').style.display = 'flex'
        status.textContent = '⚠ another admin saved first — your revision is stale'
        return
      }
      if (resp.status === 422) {
        const j = (await resp.json().catch(() => null)) as { issues?: string[] } | null
        status.textContent = `⛔ map rejected: ${(j?.issues ?? ['invalid']).slice(0, 2).join('; ')}`
        return
      }
      status.textContent = resp.ok
        ? '✅ saved — live in game'
        : resp.status === 403
          ? '⛔ not authorized (admin token/key required)'
          : resp.status === 413
            ? '⛔ map too large'
            : `save failed (${resp.status})`
    })()
  })

  // ── Remote merge (instant via editor-ws push, 6s poll as fallback) ──
  const mergeRemote = async (): Promise<void> => {
    if (painting) return
    try {
      const resp2 = await fetch('/map.json')
      const served = resp2.headers.get('etag')?.replace(/"/g, '')
      // Unchanged revision = nothing to do. Rebuilding the world on every
      // poll was dropping selections and flickering terrain wires.
      if (served && served === baseRevision) return
      const remote = parseMapFile(await resp2.json())
      if (!remote.ok) return
      const map = remote.map
      // Revision safety: a remote save must never wipe local dirty work.
      if (dirty) {
        const sig2 = sigOfDoc(map)
        if (sig2 !== lastSig) {
          lastSig = sig2
          $e('conflict').style.display = 'flex'
          status.textContent = '⚠ another admin saved while you have unsaved changes'
        }
        return
      }
      const sig = sigOfDoc(map)
      if (sig === lastSig) return
      lastSig = sig
      if (served) baseRevision = served
      deselect()
      for (const m of [...staticMeshes.keys(), ...nodeMeshes.keys()]) m.dispose()
      staticMeshes.clear()
      nodeMeshes.clear()
      placedStatics = map.statics
      placedNodes = map.nodes
      mapZones = map.zones
      for (const m of propMeshes.keys()) m.dispose()
      propMeshes.clear()
      placedProps = map.props
      for (const st of placedStatics) renderStatic(st)
      for (const n of placedNodes) renderNode(n)
      for (const pr of placedProps) renderProp(pr)
      // Patches: rebuild from the remote artifact.
      for (const m of patchMeshes.keys()) m.dispose()
      patchMeshes.clear()
      for (let i = terrainTargets.length - 1; i >= 0; i--) {
        if (terrainTargets[i]!.patch) terrainTargets.splice(i, 1)
      }
      surfaces.clear()
      patches = map.terrains.map((t) => ({
        id: t.id,
        origin: t.pos,
        halfExtent: t.halfExtent,
        sub: t.sub,
        heights: decodeHeights(t.heights),
        ...(t.rot ? { rot: t.rot } : {}),
        ...(t.scale ? { scale: t.scale } : {}),
        ...(t.surface ? { surface: t.surface as SurfaceMaterialData } : {}),
      }))
      for (const pp of patches) buildPatchMesh(pp)
      mapModels = map.models
      mapTextures = map.textures as MapTextureEntry[]
      refreshImportedPalette()
      for (const l of [...mapLightsArr]) removeLightRender(l)
      mapLightsArr = map.lights as unknown as MapLight[]
      for (const l of mapLightsArr) renderLight(l)
      spawnPos = map.spawn ?? null
      spawnYaw = map.spawnYaw ?? 0
      placeSpawnFlag()
      status.textContent = '🔄 merged edits from another admin'
    } catch {
      /* offline poll */
    }
  }
  setInterval(() => void mergeRemote(), 6000)
  document.getElementById('conflict-load')?.addEventListener('click', () => {
    // Explicit choice: discard local changes and take the remote version.
    nonHistoryDirt = false
    history.markSaved()
    updateDirty()
    lastSig = ''
    $e('conflict').style.display = 'none'
    void mergeRemote()
  })
  document.getElementById('conflict-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(buildFile())], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `hoboquest-map-local-${Date.now()}.json`
    a.click()
  })

  // ── Live presence: co-editors as floating eyeballs ──────────────────
  const peers = new PeerAvatars(scene, $e('peers'))

  let ws: WebSocket | null = null
  let myPeerId = -1
  const connectPresence = (): void => {
    const key = $('key').value.trim()
    if (!key) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/editor-ws`)
    ws.onopen = () =>
      ws?.send(
        JSON.stringify({ t: 'hi', key, name: localStorage.getItem('hobo.name') ?? 'editor' }),
      )
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        t: string
        id?: number
        name?: string
        pos?: number[]
        yaw?: number
        pitch?: number
      }
      if (msg.t === 'welcome' && msg.id !== undefined) myPeerId = msg.id
      if (msg.t === 'lock_result') {
        const lm = msg as unknown as { granted: boolean; ids: string[]; owner?: string }
        if (lm.granted) {
          lockState = 'owned'
          onLockGranted?.()
          onLockGranted = null
          return
        }
        if (!lm.granted) {
          lockState = 'denied'
          lockDenied = { owner: lm.owner ?? 'another editor' }
          if (painting && strokeTarget && strokeBefore) {
            strokeTarget.heights.set(strokeBefore)
            refreshTarget(strokeTarget)
            strokeBefore = null
            strokeTarget = null
            painting = 0
          }
          gizmos.attachToMesh(null)
          gizmos.attachToNode(null)
          setInspectorLocked(true, lockDenied.owner)
          status.textContent = `🔒 locked by ${lockDenied.owner} — read-only until they deselect`
        }
        return
      }
      if (msg.t === 'locks') {
        const lm = msg as unknown as {
          owners: Record<string, { id: number; name: string; color: string }>
        }
        lockOwners.clear()
        for (const [oid, o] of Object.entries(lm.owners)) {
          if (o.id !== myPeerId) lockOwners.set(oid, { name: o.name, color: o.color })
        }
        // Lost-lease detection: we believe we own ids the server no longer
        // attributes to us (lease expiry, reconnect race) → stop editing.
        if (lockState === 'owned' && myLockedIds.some((oid) => lm.owners[oid]?.id !== myPeerId)) {
          lockState = 'lost'
          gizmos.attachToMesh(null)
          gizmos.attachToNode(null)
          setInspectorLocked(true, 'lock lost — reselect to reacquire')
          status.textContent = '⚠ edit lock lost (lease expired) — reselect to reacquire'
        }
        return
      }
      if (msg.t === 'peer_sel') {
        const pm = msg as unknown as { id: number; color: string; ids: string[] }
        remoteSel.set(pm.id, { color: Color3.FromHexString(pm.color), ids: pm.ids })
        refreshSelectionVisuals()
        return
      }
      if (msg.t === 'peer' && msg.id !== undefined && msg.pos) {
        peers.update(msg.id, msg.name ?? 'editor', msg.pos, msg.yaw ?? 0, msg.pitch ?? 0)
      } else if (msg.t === 'peer_gone' && msg.id !== undefined) {
        peers.remove(msg.id)
        remoteSel.delete(msg.id)
        refreshSelectionVisuals()
      } else if (msg.t === 'map_saved') {
        void mergeRemote()
      }
    }
    ws.onclose = () => {
      ws = null
      setTimeout(connectPresence, 3000)
    }
  }
  connectPresence()
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }))
  }, 10_000)
  $('key').addEventListener('change', () => {
    ws?.close()
  })
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          t: 'cam',
          pos: [camera.position.x, camera.position.y, camera.position.z],
          yaw: camera.rotation.y,
          pitch: camera.rotation.x,
        }),
      )
    }
  }, 120)

  // ── Imports + patch creation ────────────────────────────────────────
  const refreshImportedPalette = (): void => {
    // Rebuild the Place dropdown: base placeables + imported models.
    for (let i = PLACEABLES.length - 1; i >= 0; i--) {
      if (PLACEABLES[i]!.kind === 'model') PLACEABLES.splice(i, 1)
    }
    for (const model of mapModels)
      PLACEABLES.push({ name: `🗿 ${model.name}`, kind: 'model', modelId: model.id })
    placeSel.replaceChildren()
    PLACEABLES.forEach((pp, i) => {
      const o = document.createElement('option')
      o.value = String(i)
      o.textContent = pp.name
      placeSel.appendChild(o)
    })
    // Texture dropdowns: stock + custom uploads, thumbnails via pickers.
    registerCustomTextures(mapTextures)
    fillTexSelect(texSel)
    fillTexSelect(faceTexSel)
    fillTexSelect(paintTexSel)
    texPicker.refresh()
    faceTexPicker.refresh()
    paintTexPicker.refresh()
  }
  const texOptions = (): TexOption[] => [
    { value: '', label: 'Plain Color', thumb: null },
    ...TEXTURES.filter((t) => t !== '').map((t) => ({
      value: t,
      label: prettyTexName(t),
      thumb: `/assets/tex/${t}.jpg`,
    })),
    ...mapTextures.map((t) => ({
      value: `custom:${t.name}`,
      label: prettyTexName(t.name),
      thumb: t.url ?? t.dataUrl ?? null,
    })),
  ]
  const texPicker = createTexPicker(texSel, texOptions)
  const faceTexPicker = createTexPicker(faceTexSel, texOptions)
  const paintTexPicker = createTexPicker(paintTexSel, texOptions)
  // The Paint tool is usable immediately: default to a stock texture rather
  // than making the first stroke a no-op with "pick a texture first".
  if (!paintTexSel.value) {
    paintTexSel.value = 'leafy_grass'
    paintTexPicker.sync()
  }
  refreshImportedPalette()

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result))
      r.onerror = () => rej(new Error('read failed'))
      r.readAsDataURL(file)
    })

  document.getElementById('model-file')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    if (file.size > 4 * 1024 * 1024) {
      status.textContent = '⛔ model too large (4MB max — maps ship to every player)'
      return
    }
    void (async () => {
      const dataUrl = await fileToDataUrl(file)
      status.textContent = 'loading model…'
      try {
        // Measure by instantiating through the cache, so the import also
        // warms it — placing the model afterwards needs no second parse.
        const id = `model-${Date.now().toString(36)}`
        const probe = await modelCache.instantiate(id, dataUrl)
        if (!probe) throw new Error('empty glb')
        const { min, max } = probe.root.getHierarchyBoundingVectors(true)
        const bounds: [number, number, number] = [
          Math.max(0.2, max.x - min.x),
          Math.max(0.2, max.y - min.y),
          Math.max(0.2, max.z - min.z),
        ]
        probe.dispose()
        const name = file.name.replace(/\.(glb|gltf)$/i, '').slice(0, 24)
        mapModels.push({ id, name, glb: dataUrl, bounds })
        refreshImportedPalette()
        placeSel.value = String(PLACEABLES.findIndex((pp) => pp.modelId === id))
        setTool('mesh')
        markDirty()
        status.textContent = `🗿 ${name} imported (${bounds.map((b) => b.toFixed(1)).join('×')}m) — click to place`
      } catch {
        status.textContent = '⛔ could not load that glb'
      }
    })()
  })

  const sanitizeTexName = (raw: string): string => {
    const base = raw
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9_\- ]/gi, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 40)
    return base || `texture_${Date.now().toString(36)}`
  }
  document.getElementById('texture-file')?.addEventListener('change', (e) => {
    const fileInput = e.target as HTMLInputElement
    const file = fileInput.files?.[0]
    if (!file) return
    fileInput.value = ''
    if (file.size > 64 * 1024 * 1024) {
      status.textContent = '⛔ file over 64MB — export a smaller copy first'
      return
    }
    void (async () => {
      status.textContent = '🖼 processing texture…'
      let img: Awaited<ReturnType<typeof downscaleImage>>
      try {
        // 4k sources welcome — resized to ≤2048 and re-encoded for the web.
        img = await downscaleImage(file, 2048)
      } catch {
        status.textContent =
          '⛔ not a decodable image — use the jpg/png diffuse map (EXR/blend not supported)'
        return
      }
      let name = sanitizeTexName(file.name)
      while (mapTextures.some((t) => t.name === name)) name = `${name}_2`
      // Preferred path: server-hosted asset (no map.json bloat, any size).
      const key = $('key').value.trim()
      let stored: MapTextureEntry | null = null
      try {
        const resp = await fetch(`/api/texture?ext=${img.ext}`, {
          method: 'POST',
          headers: { 'x-editor-key': key },
          body: img.blob,
        })
        if (resp.ok) {
          const j = (await resp.json()) as { url: string }
          stored = { name, url: j.url, scale: 2 }
        } else if (resp.status === 403) {
          status.textContent = '⛔ upload needs your admin token/editor key (top of the panel)'
          return
        }
      } catch {
        /* offline — embed below if small enough */
      }
      if (!stored) {
        if (img.blob.size > 1.5 * 1024 * 1024) {
          status.textContent = '⛔ server unreachable and file too big to embed — try again online'
          return
        }
        const dataUrl = await new Promise<string>((res) => {
          const r = new FileReader()
          r.onload = () => res(String(r.result))
          r.readAsDataURL(img.blob)
        })
        stored = { name, dataUrl, scale: 2 }
      }
      mapTextures.push(stored)
      refreshImportedPalette()
      markDirty()
      status.textContent = `🖼 "${prettyTexName(name)}" imported (${img.width}×${img.height}) — pick it in any texture dropdown`
    })()
  })

  // ── Texture manager: rename / retile / delete custom textures ───────
  const texmanEl = $e('texman')
  const renameTexture = (oldName: string, newNameRaw: string): void => {
    const newName = sanitizeTexName(newNameRaw)
    if (!newName || newName === oldName) return
    if (mapTextures.some((t) => t.name === newName)) {
      status.textContent = `⛔ a texture named "${prettyTexName(newName)}" already exists`
      renderTexman()
      return
    }
    const entry = mapTextures.find((t) => t.name === oldName)
    if (!entry) return
    entry.name = newName
    const from = `custom:${oldName}`
    const to = `custom:${newName}`
    const renameIn = (style: FaceStyle | undefined): void => {
      if (style?.tex === from) style.tex = to
    }
    for (const b of placedStatics) {
      if (b.tex === from) b.tex = to
      renameIn(b.uv)
      for (const f of Object.values(b.faces ?? {})) renameIn(f)
    }
    for (const pp of patches) if (pp.tex === from) pp.tex = to
    refreshImportedPalette()
    restyleEverything()
    markDirty()
    status.textContent = `🖼 renamed to "${prettyTexName(newName)}" (all uses updated)`
    renderTexman()
  }
  const deleteTexture = (name: string): void => {
    const from = `custom:${name}`
    mapTextures = mapTextures.filter((t) => t.name !== name)
    const clearIn = (style: FaceStyle | undefined): void => {
      if (style?.tex === from) delete style.tex
    }
    for (const b of placedStatics) {
      if (b.tex === from) delete b.tex
      clearIn(b.uv)
      for (const f of Object.values(b.faces ?? {})) clearIn(f)
    }
    for (const pp of patches) if (pp.tex === from) delete pp.tex
    refreshImportedPalette()
    restyleEverything()
    markDirty()
    renderTexman()
  }
  /** Re-render every static + patch after texture registry changes. */
  const restyleEverything = (): void => {
    deselect()
    for (const [m, b] of [...staticMeshes]) rebuildSelectedMesh(b, m)
    for (const pp of patchMeshes.values()) applyPatchMaterial(null, pp)
  }
  const renderTexman = (): void => {
    const list = $e('texman-list')
    list.replaceChildren()
    if (mapTextures.length === 0) {
      const d = document.createElement('div')
      d.style.color = '#78828e'
      d.textContent = 'no custom textures yet — use "Import texture"'
      list.appendChild(d)
      return
    }
    for (const t of mapTextures) {
      const row = document.createElement('div')
      row.className = 'tex-row'
      const img = document.createElement('img')
      img.src = t.url ?? t.dataUrl ?? ''
      const nameIn = document.createElement('input')
      nameIn.type = 'text'
      nameIn.value = t.name
      nameIn.title = 'rename (updates every object using it)'
      nameIn.addEventListener('change', () => renameTexture(t.name, nameIn.value))
      const scaleIn = document.createElement('input')
      scaleIn.type = 'number'
      scaleIn.step = '0.5'
      scaleIn.min = '0.25'
      scaleIn.value = String(t.scale ?? 2)
      scaleIn.title = 'meters per tile'
      makeScrubbable(scaleIn)
      scaleIn.addEventListener('change', () => {
        const v = Number(scaleIn.value)
        if (Number.isFinite(v) && v > 0) {
          t.scale = v
          refreshImportedPalette()
          restyleEverything()
          markDirty()
        }
      })
      const del = document.createElement('button')
      del.textContent = '🗑'
      del.className = 'mini'
      del.title = 'delete (objects fall back to plain color)'
      del.addEventListener('click', () => deleteTexture(t.name))
      row.append(img, nameIn, scaleIn, del)
      list.appendChild(row)
    }
  }
  document.getElementById('texman-btn')?.addEventListener('click', () => {
    const open = texmanEl.style.display === 'flex'
    texmanEl.style.display = open ? 'none' : 'flex'
    if (!open) renderTexman()
  })
  document.getElementById('texman-close')?.addEventListener('click', () => {
    texmanEl.style.display = 'none'
  })

  // ── Settings: remappable hotkeys (see ui/settingsPanel.ts) ──────────
  const refreshToolButtons = (): void => {
    toolsEl.querySelectorAll('button').forEach((b) => {
      const hk = b.querySelector('.hk')
      const t = b.dataset['tool']
      if (hk && t) hk.textContent = formatBinding(bindingOf(`tool.${t}`))
    })
  }
  createSettingsPanel({
    bindings,
    bindingOf,
    onChanged: () => {
      refreshToolButtons()
      renderHelp()
    },
  })

  // ── Collapsible sidebar (Photoshop-style icon rail; expanded default) ─
  const panel = $e('panel')
  const collapseBtn = document.getElementById('collapse') as HTMLButtonElement
  const setCollapsed = (on: boolean): void => {
    panel.classList.toggle('collapsed', on)
    collapseBtn.textContent = on ? '»' : '«'
    localStorage.setItem('hobo.editor.panel', on ? 'collapsed' : 'expanded')
  }
  collapseBtn.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')))
  setCollapsed(localStorage.getItem('hobo.editor.panel') === 'collapsed')

  // Help text derives from the LIVE bindings so remapping can't make it lie.
  const renderHelp = (): void => {
    const f = (a: string): string => formatBinding(bindingOf(a))
    const hintEl = document.querySelector('.hint') as HTMLElement | null
    if (hintEl)
      hintEl.innerHTML =
        `<b>${f('tool.terrain')}–${f('tool.select')}</b> tools (again = off) · ` +
        `<b>${f('cam.freelook')}</b> free-look · fly ${f('cam.forward')}${f('cam.left')}${f('cam.back')}${f('cam.right')}+${f('cam.up')}/${f('cam.down')} (<b>${f('cam.fast')}</b> fast) · ` +
        `MMB orbit / ${f('cam.pan')}+MMB pan · wheel zooms (rotates while placing) · ` +
        `<b>LMB</b> raise / <b>RMB</b> lower · <b>${f('brush.radiusDown')} ${f('brush.radiusUp')}</b> radius · ` +
        `<b>${f('xf.move')}/${f('xf.rotate')}/${f('xf.scale')}</b> move/rotate/scale · ${f('xf.nosnap')} = no snap · ` +
        `<b>${f('edit.undo')}/${f('edit.redo')}</b> undo/redo · ${f('edit.duplicate')} duplicate · ` +
        `${f('edit.delete')} delete · ${f('edit.save')} save · ${f('ui.sidebar')} sidebar · ${f('ui.settings')} settings`
  }
  renderHelp()

  // Start with NO active tool: camera-only until the user picks one.
  status.textContent =
    'pick a tool (1-5) — camera: WASD+EC fly, MMB orbit, Shift+MMB pan, wheel zoom'
  engine.runRenderLoop(() => scene.render())
  window.addEventListener('resize', () => engine.resize())

  // Sky preview time (the cycle still advances — full day/night in 20min).
  const skySel = document.getElementById('sky-time') as HTMLSelectElement | null
  skySel?.addEventListener('change', () => {
    env.setDayFraction(Number(skySel.value))
    status.textContent = 'sky time set (day/night keeps cycling from here)'
  })

  // Blender-style drag-scrub on every numeric input (incl. dynamic panels).
  scrubAllNumbers(document)

  // ── Editor probe API (harness-only; NOT a game/public API) ──────────
  // The regression suite talks to the editor exclusively through this
  // surface, so the same tests run against the old and new architecture.
  const probeSelectionIds = (): string[] => {
    const ids: string[] = []
    if (mainSelected) ids.push('terrain:main')
    if (spawnSelected) ids.push('spawn')
    if (selected?.body.id) ids.push(selected.body.id)
    if (selectedNode?.node.id) ids.push(selectedNode.node.id)
    if (selectedProp?.prop.id) ids.push(selectedProp.prop.id)
    if (selectedPatch) ids.push(`terrain:${selectedPatch.patch.id}`)
    if (selectedLight) ids.push(selectedLight.light.id)
    for (const it of multiSel) if (it.body.id) ids.push(it.body.id)
    for (const it of multiPatches) ids.push(`terrain:${it.patch.id}`)
    for (const it of multiNodes) if (it.node.id) ids.push(it.node.id)
    for (const it of multiProps) if (it.prop.id) ids.push(it.prop.id)
    return ids
  }
  /**
   * Screen position of a live gizmo handle, found by ray-testing the
   * utility layer along the projected axis — tests must click the REAL
   * handle geometry, never a guessed offset.
   */
  const probeGizmoHandle = (axis: 'x' | 'y' | 'z'): [number, number] | null => {
    const active =
      gizmoMode === 'move'
        ? gizmos.gizmos.positionGizmo
        : gizmoMode === 'rotate'
          ? gizmos.gizmos.rotationGizmo
          : gizmos.gizmos.scaleGizmo
    if (!active) return null
    const axisGizmo = (
      active as unknown as Record<'xGizmo' | 'yGizmo' | 'zGizmo', { _rootMesh?: TransformNode }>
    )[`${axis}Gizmo`]
    const root = axisGizmo?._rootMesh
    if (!root) return null
    const uScene = active.gizmoLayer.utilityLayerScene
    const vp = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
    const origin = Vector3.Project(
      root.getAbsolutePosition(),
      Matrix.Identity(),
      scene.getTransformMatrix(),
      vp,
    )
    const belongsToAxis = (m: { parent: unknown } | null): boolean => {
      let n = m as { parent: unknown } | null
      for (let d = 0; n && d < 12; d++) {
        if (n === (root as unknown)) return true
        n = n.parent as { parent: unknown } | null
      }
      return false
    }
    // Spiral out from the gizmo origin until a utility-layer pick lands on
    // geometry owned by THIS axis. Works for arrows, planes and rotation
    // rings alike — no assumptions about where the handle art sits.
    for (let r = 6; r <= 220; r += 4) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2
        const x = origin.x + Math.cos(a) * r
        const y = origin.y + Math.sin(a) * r
        if (x < 0 || y < 0 || x > engine.getRenderWidth() || y > engine.getRenderHeight()) continue
        const hit = uScene.pick(x, y)
        if (hit?.hit && hit.pickedMesh && belongsToAxis(hit.pickedMesh))
          return [Math.round(x), Math.round(y)]
      }
    }
    return null
  }
  /** World → screen, so tests can aim the real mouse at a real object. */
  const probeWorldToScreen = (p: [number, number, number]): [number, number] => {
    const vp = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
    const r = Vector3.Project(
      new Vector3(p[0], p[1], p[2]),
      Matrix.Identity(),
      scene.getTransformMatrix(),
      vp,
    )
    return [Math.round(r.x), Math.round(r.y)]
  }
  const probeTerrainWires = (): Record<string, boolean> => {
    const out: Record<string, boolean> = { 'terrain:main': wire.isEnabled() }
    for (const [pm, pw] of patchWires) {
      const p = patchMeshes.get(pm)
      if (p) out[`terrain:${p.id}`] = pw.isEnabled()
    }
    return out
  }
  const probeTransform = (id: string): unknown => {
    const t = transformAccessor.get(id)
    if (!t) return null
    const b = placedStatics.find((x) => x.id === id)
    return {
      position: [...t.position],
      rotation: eulerOf(t),
      scale: [...t.scale],
      ...(b
        ? {
            dims:
              b.shape.type === 'box'
                ? [...b.shape.size]
                : b.shape.type === 'cylinder'
                  ? [b.shape.radius, b.shape.height]
                  : [b.shape.radius],
          }
        : {}),
    }
  }

  // ── Issues: live map validation (see ui/issuesPanel.ts) ─────────────
  // The same checks the save pipeline runs, surfaced while the author can
  // still act on them instead of only as a rejection message.
  const issuesPanel = createIssuesPanel({
    collect: () => {
      const out: EditorIssue[] = []
      const known = (ref: string): boolean =>
        ref === 'none' ||
        !ref.startsWith('custom:') ||
        mapTextures.some((t) => `custom:${t.name}` === ref)
      const seen = new Set<string>()
      const claim = (id: string | undefined, what: string): void => {
        if (!id) return
        if (seen.has(id))
          out.push({ severity: 'error', message: `duplicate id "${id}" (${what})`, objectId: id })
        seen.add(id)
      }
      for (const patch of patches) {
        const oid = `terrain:${patch.id}`
        claim(oid, 'terrain')
        for (const msg of validateSurface(surfaceDataOf(patch), known))
          out.push({ severity: 'error', message: `terrain: ${msg}`, objectId: oid })
      }
      for (const b of placedStatics) {
        claim(b.id, 'static')
        if (b.tex && !known(b.tex))
          out.push({
            severity: 'error',
            message: `static: missing texture "${b.tex}"`,
            ...(b.id ? { objectId: b.id } : {}),
          })
        if (b.model && !mapModels.some((m) => m.id === b.model))
          out.push({
            severity: 'error',
            message: `static: missing model "${b.model}"`,
            ...(b.id ? { objectId: b.id } : {}),
          })
        if (b.scale && b.scale.some((v) => Math.abs(v) < 1e-4))
          out.push({
            severity: 'error',
            message: 'static: zero scale collapses the collider',
            ...(b.id ? { objectId: b.id } : {}),
          })
      }
      for (const n of placedNodes) claim(n.id, 'node')
      for (const pr of placedProps) claim(pr.id, 'prop')
      for (const l of mapLightsArr) claim(l.id, 'light')
      if (mapLightsArr.filter((l) => l.shadows).length > 3)
        out.push({
          severity: 'warning',
          message: 'more than 3 shadow-casting lights — the game caps shadows at 3',
        })
      if (!spawnPos)
        out.push({ severity: 'warning', message: 'no spawn point — players spawn at the origin' })
      if (patches.length === 0 && placedStatics.length === 0)
        out.push({
          severity: 'info',
          message: 'empty map — place a mesh to start (lands at 0,0,0)',
        })
      return out
    },
    focus: (objectId) => {
      setTool('select')
      selectionMgr.replace(objectId)
      rebuildSelectionViews()
      runAction('cam.frame')
    },
  })
  // Re-validate whenever the document changes.
  history.onChange(() => issuesPanel.refresh())

  // Test/debug handle (harness-only; not part of any API contract).
  ;(window as unknown as Record<string, unknown>)['__editor'] = {
    probeVersion: 1,
    selectionIds: probeSelectionIds,
    primaryId: () => probeSelectionIds()[0] ?? null,
    interactionState: () => interaction.state,
    gizmoState: () => ({
      mode: gizmoMode,
      attached: Boolean(gizmos.attachedMesh ?? gizmos.attachedNode),
      dragging: interaction.is('gizmo-drag'),
      xformActive: xform.active,
    }),
    gizmoHandleScreenPos: probeGizmoHandle,
    cameraSnapshot: () => ({
      pos: [camera.position.x, camera.position.y, camera.position.z],
      rot: [camera.rotation.x, camera.rotation.y, camera.rotation.z],
    }),
    history: () => ({ depth: history.depth, redo: history.redoDepth }),
    terrainWires: probeTerrainWires,
    faceSelKeys: () => faceSelection.keys(),
    faceOverlayCount: () => faceOverlays.count,
    paintSurface: () =>
      paintTarget
        ? {
            objectId: paintTarget.id === 'main' ? 'terrain:main' : `terrain:${paintTarget.id}`,
            base: paintTarget.patch?.tex ?? null,
            layers: ['grass', 'rock', 'mud'],
          }
        : null,
    transformOf: probeTransform,
    worldToScreen: probeWorldToScreen,
    /** What the editor's own picker resolves at a screen point (test aim). */
    pickIdAt: (x: number, y: number) => picker.pick(x, y)?.objectId ?? null,
    /** Layered-surface state for a terrain object (base + paint layers). */
    surfaceMaterialOf: (id: string) => {
      const patch = patches.find((pp) => `terrain:${pp.id}` === id || pp.id === id)
      if (!patch) return null
      const data = surfaceDataOf(patch)
      return {
        base: data.base.tex ?? null,
        baseColor: data.base.color ?? null,
        layers: (data.paint?.layers ?? []).map((l) => ({
          tex: l.tex,
          channel: l.channel,
          hidden: Boolean(l.hidden),
          color: l.color ?? null,
        })),
        hasMask: Boolean(data.paint?.mask),
      }
    },
    /** Set the inspector's base texture exactly as the picker would. */
    setInspectorTexture: (tex: string) => {
      texSel.value = tex
      texPicker.sync()
      texSel.dispatchEvent(new Event('change'))
    },
    setPaintTexture: (tex: string) => {
      paintTexSel.value = tex
      paintTexPicker.sync()
    },
    setPaintColor: (hex: string) => {
      const el = document.getElementById('paint-color') as HTMLInputElement | null
      if (el) el.value = hex
    },
    setToolByName: (t: string) => setTool(t as Tool),
    issueCount: () => issuesPanel.count(),
    selectByIds: (ids: string[]) => {
      selectionMgr.replaceMany(ids)
      rebuildSelectionViews()
    },
    terrainIds: () => patches.map((p) => `terrain:${p.id}`),
    undo: () => undo(),
    redo: () => redo(),
    setCameraPose: (pos: [number, number, number], rot: [number, number, number]) => {
      camera.position.set(pos[0], pos[1], pos[2])
      camera.rotation.set(rot[0], rot[1], rot[2])
    },
    camera,
    get tool() {
      return tool
    },
    get dirty() {
      return dirty
    },
    heightsSum() {
      let sum = 0
      for (const h of heights) sum += Math.abs(h)
      return sum
    },
    selectMain() {
      setTool('select')
      selectMainTerrain()
    },
    multiCount() {
      return multiTotal()
    },
    undoDepth() {
      return history.depth
    },
    objectCounts() {
      return {
        statics: placedStatics.length,
        patches: patches.length,
        nodes: placedNodes.length,
        props: placedProps.length,
        lights: mapLightsArr.length,
      }
    },
    mainVisible() {
      return terrain.isEnabled()
    },
    mainPickable() {
      return terrain.isPickable && terrain.isEnabled()
    },
    staticPositions() {
      return placedStatics.map((b) => [...b.pos])
    },
    groupMove(dx: number, dy: number, dz: number) {
      const started = xform.begin(selectionMgr.ids(), 'move', { label: 'group move' })
      if (!started) return
      const p = started.pivotStart
      xform.update({
        ...p,
        position: [p.position[0] + dx, p.position[1] + dy, p.position[2] + dz],
      })
      xform.commit()
      refreshGizmoPivot()
      fillMultiProps()
    },
    lights() {
      return JSON.parse(JSON.stringify(mapLightsArr)) as unknown
    },
    statics() {
      return JSON.parse(JSON.stringify(placedStatics)) as unknown
    },
    faceSelCount() {
      return faceSelection.size
    },
    patchWireCount() {
      return patchWires.size
    },
    gizmoBusyState() {
      const g = gizmos.gizmos
      return {
        dragging: interaction.is('gizmo-drag'),
        pos: Boolean(g.positionGizmo?.isHovered),
        rot: Boolean(g.rotationGizmo?.isHovered),
        scale: Boolean(g.scaleGizmo?.isHovered),
      }
    },
    hasSky() {
      return Boolean(scene.getMeshByName('skybox') && scene.getMeshByName('clouds'))
    },
    patchOrigins() {
      return patches.map((pp) => [...pp.origin])
    },
  }
}

void boot()
