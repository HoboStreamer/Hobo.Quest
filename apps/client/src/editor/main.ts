import { Engine } from '@babylonjs/core/Engines/engine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
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
  defaultHeights,
  encodeHeights,
  setMapOverride,
  type FaceStyle,
  type MapFile,
  type MapLight,
  type MapNodeSpawn,
  type MapTextureEntry,
  type StaticBody,
} from '@hobo/content'
import { HighlightLayer } from '@babylonjs/core/Layers/highlightLayer.js'
import { meshForShape } from '../render/sceneSetup.js'
import {
  LIGHT_DEFAULTS,
  applyPatchTexture,
  applyStaticStyle,
  instantiateMapLight,
  prettyTexName,
  registerCustomTextures,
  resolveTexInfo,
} from '../render/mapStyle.js'
import {
  createTexPicker,
  downscaleImage,
  makeScrubbable,
  scrubAllNumbers,
  type TexOption,
} from './ui.js'
import {
  ACTIONS,
  bindingFromEvent,
  bindingMatches,
  findConflicts,
  formatBinding,
  loadBindings,
  type Binding,
} from './bindings.js'

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

type Tool = 'terrain' | 'paint' | 'entity' | 'mesh' | 'select' | 'face' | 'light'

/** Session-stable id generator for map objects (never array positions). */
let idCounter = 0
const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`

interface Placeable {
  name: string
  kind: 'static' | 'node' | 'spawn' | 'model' | 'prop' | 'patch'
  shape?: StaticBody['shape']
  color?: string
  tex?: string
  decor?: string
  node?: string
  modelId?: string
}

/** Mesh tool: primitive shapes the user builds everything from (plus
 *  imported glb models, appended at runtime). No prefab world props —
 *  buildings, ramps and furniture are authored, not picked. */
const PLACEABLES: Placeable[] = [
  { name: '⬛ Box', kind: 'static', shape: { type: 'box', size: [2, 2, 2] }, color: '#8a8d90' },
  {
    name: '▬ Panel / wall',
    kind: 'static',
    shape: { type: 'box', size: [4, 3, 0.3] },
    color: '#9a9187',
  },
  {
    name: '⚫ Cylinder',
    kind: 'static',
    shape: { type: 'cylinder', radius: 1, height: 2 },
    color: '#8f8a82',
  },
  { name: '🔘 Sphere', kind: 'static', shape: { type: 'sphere', radius: 1 }, color: '#7b7f83' },
  { name: '⛰ Terrain patch (32m sculptable)', kind: 'patch' },
]

/** Entity tool: gameplay spawns — not geometry. */
const ENTITY_DEFS: Placeable[] = [
  { name: '🚩 Spawn point', kind: 'spawn' },
  { name: '🌳 Oak tree (chop)', kind: 'node', node: 'oak_tree' },
  { name: '🫐 Berry bush', kind: 'node', node: 'berry_bush' },
  { name: '🪨 Stone deposit (pick)', kind: 'node', node: 'stone_deposit' },
  { name: '🌿 Branch pile', kind: 'node', node: 'branch_pile' },
  { name: '🥌 Loose stones', kind: 'node', node: 'loose_stones' },
  { name: '⚙ Scrap pile', kind: 'node', node: 'scrap_pile' },
  { name: '🏪 Merchant stall (shop)', kind: 'prop', node: 'merchant_stall' },
  { name: '📦 Wooden crate (prop)', kind: 'prop', node: 'wooden_crate' },
  { name: '🛢 Metal barrel (prop)', kind: 'prop', node: 'metal_barrel' },
]

const TEXTURES = [
  '',
  'brown_mud_dry',
  'clay_roof_tiles',
  'floor_pavement',
  'gray_rocks',
  'leafy_grass',
  'metal_plate',
  'plastered_wall_02',
  'red_brick',
  'weathered_plank_siding',
  'wood_planks',
]

/** Visual stand-ins for resource nodes (matched loosely to the game's). */
const NODE_LOOKS: Record<string, { color: string; shape: StaticBody['shape'] }> = {
  oak_tree: { color: '#4c7a3a', shape: { type: 'cylinder', radius: 1.3, height: 5 } },
  berry_bush: { color: '#3f6a35', shape: { type: 'sphere', radius: 0.7 } },
  stone_deposit: { color: '#7b7f83', shape: { type: 'sphere', radius: 1.1 } },
  branch_pile: { color: '#7a5c38', shape: { type: 'box', size: [1.2, 0.4, 1.2] } },
  loose_stones: { color: '#8a8d90', shape: { type: 'box', size: [1, 0.35, 1] } },
  scrap_pile: { color: '#6d6f72', shape: { type: 'box', size: [1.4, 0.6, 1.4] } },
}

interface PatchState {
  id: string
  origin: [number, number, number]
  halfExtent: number
  sub: number
  heights: Float32Array
  rot?: [number, number, number]
  tex?: string
  color?: string
  mix?: string
  uv?: FaceStyle
}

type UndoOp =
  | { kind: 'terrain'; target: string; before: Float32Array; after: Float32Array }
  | { kind: 'paint'; before: ImageData; after: ImageData }
  | { kind: 'place'; body?: StaticBody; node?: MapNodeSpawn }
  | { kind: 'delete'; body?: StaticBody; node?: MapNodeSpawn }
  | { kind: 'edit'; body: StaticBody; before: StaticBody; after: StaticBody }
  | {
      kind: 'nodemove'
      node: MapNodeSpawn
      before: [number, number, number]
      after: [number, number, number]
    }
  | { kind: 'patchadd'; patch: PatchState }
  | { kind: 'patchdelete'; patch: PatchState }
  | {
      kind: 'propedit'
      add: boolean
      prop: { item: string; pos: [number, number, number]; yaw?: number }
    }
  | { kind: 'batch'; items: { body: StaticBody; before: StaticBody; after: StaticBody }[] }
  | {
      kind: 'propmove'
      prop: { id?: string; item: string; pos: [number, number, number]; yaw?: number }
      before: [number, number, number]
      after: [number, number, number]
    }
  | {
      kind: 'spawnedit'
      before: [number, number, number] | null
      after: [number, number, number] | null
    }
  | {
      kind: 'patchprop'
      patch: PatchState
      before: { tex?: string; color?: string; uv?: FaceStyle }
      after: { tex?: string; color?: string; uv?: FaceStyle }
    }
  | { kind: 'lightadd'; light: MapLight }
  | { kind: 'lightdelete'; light: MapLight }
  | { kind: 'lightedit'; light: MapLight; before: MapLight; after: MapLight }
  | { kind: 'batchdelete'; bodies: StaticBody[] }
  | { kind: 'group'; label: string; ops: UndoOp[] }
  | { kind: 'mainconvert'; prev: Float32Array; patch: PatchState | null }
  | {
      kind: 'patchedit'
      id: string
      before: { origin: [number, number, number]; rot?: [number, number, number] }
      after: { origin: [number, number, number]; rot?: [number, number, number] }
    }

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const engine = new Engine(canvas, true)
  const scene = new Scene(engine)
  scene.clearColor = new Color4(0.45, 0.58, 0.72, 1)
  new HemisphericLight('hemi', new Vector3(0.2, 1, 0.1), scene).intensity = 0.85
  new DirectionalLight('sun', new Vector3(-0.4, -1, -0.3), scene).intensity = 0.6

  // ── Camera: WASD+QE fly; Z toggles pointer-locked free-look ─────────
  const camera = new FreeCamera('cam', new Vector3(0, 45, -55), scene)
  camera.setTarget(new Vector3(0, 0, 0))
  camera.minZ = 0.1
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
      mmb = holding('cam.pan') || e.shiftKey ? 'pan' : 'orbit'
      lastMX = e.clientX
      lastMY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
  })
  canvas.addEventListener('pointerup', (e) => {
    if (e.button === 1) {
      mmb = null
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    }
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!mmb) return
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
    if (freeLook) {
      camera.rotation.y += e.movementX * 0.0032
      camera.rotation.x = Math.max(-1.5, Math.min(1.5, camera.rotation.x + e.movementY * 0.0032))
    }
  })

  // ── Load map (or blank floor) ───────────────────────────────────────
  let heights: Float32Array
  let placedStatics: StaticBody[] = []
  let placedNodes: MapNodeSpawn[] = []
  let savedMix: string | undefined
  // ONE boot fetch: every loader below reads this same artifact.
  const bootMap = (await (await fetch('/map.json')).json().catch(() => null)) as MapFile | null
  if (bootMap && bootMap.v === 1 && bootMap.sub === SUB) {
    heights = decodeHeights(bootMap.heights)
    placedStatics = bootMap.statics
    placedNodes = bootMap.nodes ?? []
    savedMix = bootMap.mix
  } else {
    heights = defaultHeights(world, SUB)
  }

  // ── Terrain mesh (game-proven winding) + hover wireframe overlay ────
  setMapOverride({ halfExtent: HALF, sub: SUB, heights })
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
  const indices = grid.indices
  const cell = (HALF * 2) / SUB
  const vtx = (i: number, j: number) => (SUB - j) * (SUB + 1) + i

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

  const refreshTerrainMesh = (): void => {
    for (let j = 0; j <= SUB; j++) {
      for (let i = 0; i <= SUB; i++) {
        posBuf[vtx(i, j) * 3 + 1] = heights[j * (SUB + 1) + i] ?? 0
      }
    }
    terrain.updateVerticesData(VertexBuffer.PositionKind, posBuf, true)
    const nn: number[] = []
    VertexData.ComputeNormals(posBuf, indices, nn)
    terrain.updateVerticesData(VertexBuffer.NormalKind, nn, true)
    wire.updateVerticesData(VertexBuffer.PositionKind, posBuf, true)
  }

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
  const staticMeshes = new Map<Mesh, StaticBody>()
  const nodeMeshes = new Map<Mesh, MapNodeSpawn>()
  const applyBodyToMesh = (mesh: Mesh, s: StaticBody): void => {
    mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
    mesh.rotationQuaternion = null
    if (s.rot) mesh.rotation.set(s.rot[0], s.rot[1], s.rot[2])
    else mesh.rotation.set(0, s.yaw, 0)
  }
  const renderStatic = (s: StaticBody): Mesh => {
    const mesh = meshForShape(scene, `s:${Math.random()}`, s.shape, s.color)
    applyStaticStyle(scene, mesh, s) // textures + per-face styles render here too
    applyBodyToMesh(mesh, s)
    staticMeshes.set(mesh, s)
    if (s.model) {
      const model = mapModels.find((mm) => mm.id === s.model)
      if (model) {
        void import('@babylonjs/core/Loading/sceneLoader.js')
          .then(async ({ SceneLoader }) => {
            await import('@babylonjs/loaders/glTF/2.0/glTFLoader.js')
            return SceneLoader.ImportMeshAsync('', '', model.glb, scene, undefined, '.glb')
          })
          .then((result) => {
            const root = result.meshes[0]
            if (!root || !staticMeshes.has(mesh)) return
            root.parent = mesh
            mesh.visibility = 0.12 // faint proxy so it stays selectable
            for (const m of result.meshes) m.isPickable = false
          })
          .catch(() => undefined)
      }
    }
    return mesh
  }
  const propMeshes = new Map<
    Mesh,
    { id?: string; item: string; pos: [number, number, number]; yaw?: number }
  >()
  const renderProp = (pr: {
    id?: string
    item: string
    pos: [number, number, number]
    yaw?: number
  }): Mesh => {
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
  const renderNode = (n: MapNodeSpawn): Mesh => {
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

  // ── Undo/redo ───────────────────────────────────────────────────────
  const undoStack: UndoOp[] = []
  const redoStack: UndoOp[] = []
  let dirty = false
  let opSeq = 0
  const opIds = new WeakMap<UndoOp, number>()
  /** Sequence id of the op at the top of the undo stack when last saved. */
  let savedTopOp = 0
  let nonHistoryDirt = false // mutations that bypass history (rare)
  const topOpId = (): number => {
    const top = undoStack[undoStack.length - 1]
    return top ? (opIds.get(top) ?? -1) : 0
  }
  const saveBtn = document.getElementById('save') as HTMLButtonElement
  const updateDirty = (): void => {
    dirty = nonHistoryDirt || topOpId() !== savedTopOp
    saveBtn.textContent = dirty ? '💾 Save map ● (unsaved changes)' : '💾 Save map (applies live)'
  }
  const markDirty = (): void => {
    nonHistoryDirt = true
    updateDirty()
  }
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault()
  })
  const pushUndo = (op: UndoOp): void => {
    opIds.set(op, ++opSeq)
    undoStack.push(op)
    if (undoStack.length > 40) undoStack.shift()
    redoStack.length = 0
    updateDirty()
  }
  const findMesh = (body?: StaticBody, node?: MapNodeSpawn): Mesh | null => {
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
      for (const [m, pp] of patchMeshes) {
        if (pp === op.patch && !pp.mix) applyPatchMaterial(m.material as StandardMaterial, op.patch)
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
        Object.assign(it.body, JSON.parse(JSON.stringify(src)) as StaticBody)
        const m = findMesh(it.body)
        if (m) rebuildSelectedMesh(it.body, m)
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
      Object.assign(op.body, JSON.parse(JSON.stringify(src)) as StaticBody)
      const m = findMesh(op.body)
      if (m) {
        rebuildSelectedMesh(op.body, m)
      }
    }
  }
  const undo = (): void => {
    const op = undoStack.pop()
    if (!op) return
    applyOp(op, 'undo')
    redoStack.push(op)
    updateDirty()
    status.textContent = '↶ undo'
  }
  const redo = (): void => {
    const op = redoStack.pop()
    if (!op) return
    applyOp(op, 'redo')
    undoStack.push(op)
    updateDirty()
    status.textContent = '↷ redo'
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
  const extras = bootMap
  let patches: PatchState[] = (extras?.terrains ?? []).map((t) => ({
    ...t,
    heights: decodeHeights(t.heights),
  }))
  let mapModels: { id: string; name: string; glb: string; bounds: [number, number, number] }[] =
    extras?.models ?? []
  let mapTextures: MapTextureEntry[] = extras?.textures ?? []
  registerCustomTextures(mapTextures)
  let mapLightsArr: MapLight[] = extras?.lights ?? []
  let placedProps: { id?: string; item: string; pos: [number, number, number]; yaw?: number }[] =
    extras?.props ?? []
  // Stable document ids: everything editable gets one (persisted on save).
  for (const b of placedStatics) b.id = b.id ?? newId('s')
  for (const n of placedNodes) n.id = n.id ?? newId('n')
  for (const pr of placedProps) pr.id = pr.id ?? newId('pr')
  let spawnPos: [number, number, number] | null = extras?.spawn ?? null
  let spawnYaw = extras?.spawnYaw ?? 0

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

  const PATCH_MIX = 256
  const patchMixCtx = new Map<string, { ctx: CanvasRenderingContext2D; mat: TerrainMaterial }>()
  /** Lazily give a patch its own paintable splat layer (like the main mix).
   *  Cached entries RE-ATTACH their material — patch meshes get rebuilt by
   *  undo/redo and merges, and a rebuilt mesh must not come back black. */
  const ensurePatchMix = (patch: PatchState, mesh: Mesh): CanvasRenderingContext2D => {
    const cached = patchMixCtx.get(patch.id)
    if (cached) {
      if (mesh.material !== cached.mat) mesh.material = cached.mat
      return cached.ctx
    }
    const dt = new DynamicTexture(`pmix:${patch.id}`, PATCH_MIX, scene, false)
    const ctx = dt.getContext() as CanvasRenderingContext2D
    if (patch.mix) {
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, 0, 0, PATCH_MIX, PATCH_MIX)
        dt.update()
      }
      img.src = patch.mix
    } else {
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, PATCH_MIX, PATCH_MIX)
      dt.update()
    }
    const tmat = new TerrainMaterial(`pmixmat:${patch.id}`, scene)
    tmat.mixTexture = dt
    const ptile = (n: string, sc: number): Texture => {
      const tx = new Texture(`/assets/tex/${n}.jpg`, scene)
      tx.uScale = tx.vScale = sc
      return tx
    }
    tmat.diffuseTexture1 = ptile('leafy_grass', Math.max(4, patch.halfExtent / 2))
    tmat.diffuseTexture2 = ptile('gray_rocks', Math.max(3, patch.halfExtent / 2.5))
    tmat.diffuseTexture3 = ptile('brown_mud_dry', Math.max(3, patch.halfExtent / 2))
    tmat.specularColor = new Color3(0.02, 0.02, 0.02)
    tmat.backFaceCulling = false
    mesh.material = tmat
    patchMixCtx.set(patch.id, { ctx, mat: tmat })
    return ctx
  }
  const applyPatchMaterial = (pm: StandardMaterial, patch: PatchState): void => {
    pm.diffuseTexture?.dispose()
    pm.diffuseTexture = null
    // 'none' = plain color; absent = default grass; custom:<name> uploads.
    const info = resolveTexInfo(patch.tex ?? 'leafy_grass')
    if (info) {
      const tx = new Texture(info.url, scene)
      applyPatchTexture(tx, patch.halfExtent, info, patch.uv)
      pm.diffuseTexture = tx
    }
    pm.diffuseColor = patch.color ? Color3.FromHexString(patch.color) : new Color3(0.75, 0.75, 0.75)
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
    mesh.position.set(patch.origin[0], patch.origin[1], patch.origin[2])
    if (patch.rot) mesh.rotation.set(patch.rot[0], patch.rot[1], patch.rot[2])
    if (patch.mix) {
      ensurePatchMix(patch, mesh)
    } else {
      const pm = new StandardMaterial(`patchmat:${patch.id}`, scene)
      applyPatchMaterial(pm, patch)
      pm.specularColor = new Color3(0.02, 0.02, 0.02)
      pm.backFaceCulling = false
      mesh.material = pm
    }
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
  }

  // ── Sculpt core ─────────────────────────────────────────────────────
  const posBuf = terrain.getVerticesData(VertexBuffer.PositionKind) as Float32Array
  terrainTargets.push({ id: 'main', mesh: terrain, heights, sub: SUB, half: HALF, patch: null })
  if (mainGone()) terrain.setEnabled(false)
  let shift = false
  let strokeBefore: Float32Array | null = null
  let strokeTarget: TerrainTarget | null = null
  let paintBefore: ImageData | null = null

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
  const placeableShape = (def: Placeable): StaticBody['shape'] => {
    if (def.kind === 'static') return def.shape!
    if (def.kind === 'node') return NODE_LOOKS[def.node!]?.shape ?? { type: 'sphere', radius: 0.6 }
    if (def.kind === 'model') {
      const model = mapModels.find((mm) => mm.id === def.modelId)
      const b = model?.bounds ?? [1, 1, 1]
      return { type: 'box', size: [b[0], b[1], b[2]] }
    }
    return { type: 'box', size: [0.3, 3, 0.3] } // spawn flag pole
  }
  const shapeHeight = (shape: StaticBody['shape']): number =>
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
  const computePlacePose = (): PlacePose | null => {
    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (m) => m !== ghost && m !== wire && m.isEnabled(),
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
    const h = shapeHeight(shape as StaticBody['shape'])
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
      if (tool === 'mesh' || tool === 'entity') {
        const step = holding('place.fine') || shift ? Math.PI / 60 : Math.PI / 12
        placeYaw += (e.deltaY > 0 ? 1 : -1) * step
        return
      }
      const pick = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (m) => m !== ghost && m !== wire && m.isEnabled(),
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
      const body: StaticBody = {
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
      const node: MapNodeSpawn = {
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
    const body: StaticBody = {
      id: newId('s'),
      shape: JSON.parse(JSON.stringify(def.shape)) as StaticBody['shape'],
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
    for (const fs of faceSel) hl.addMesh(fs.mesh, fs === faceSel[0] ? C_PRIMARY : C_SECONDARY)
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
  type GizmoMode = 'move' | 'rotate' | 'scale'
  let gizmoMode: GizmoMode = 'move'
  const setGizmoMode = (mode: GizmoMode): void => {
    // Selection kinds constrain modes: nodes only move; patches move/rotate.
    if (selectedNode && mode !== 'move') mode = 'move'
    if (selectedPatch && mode === 'scale') mode = 'move'
    if (selectedLight && mode === 'scale') mode = 'move'
    if (selectedLight?.light.type === 'point' && mode === 'rotate') mode = 'move'
    if (
      mode === 'scale' &&
      multiTotal() > 0 &&
      (multiPatches.length > 0 || multiNodes.length > 0 || multiProps.length > 0)
    )
      mode = 'move'
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
  let selected: { mesh: Mesh; body: StaticBody; editBefore: StaticBody | null } | null = null
  let selectedNode: { mesh: Mesh; node: MapNodeSpawn; before: [number, number, number] } | null =
    null
  let selectedProp: {
    mesh: Mesh
    prop: { id?: string; item: string; pos: [number, number, number]; yaw?: number }
    before: [number, number, number]
  } | null = null
  let selectedPatch: { mesh: Mesh; patch: PatchState } | null = null
  let selectedLight: { mesh: Mesh; light: MapLight } | null = null
  let spawnSelected = false

  const deselect = (): void => {
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
  const selectProp = (
    mesh: Mesh,
    prop: { id?: string; item: string; pos: [number, number, number]; yaw?: number },
  ): void => {
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
    afterSelect(prop.id ? [prop.id] : [], () => gizmos.attachToMesh(mesh))
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
    afterSelect([l.id], () => gizmos.attachToMesh(mesh))
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
    afterSelect(['spawn'], () => gizmos.attachToNode(spawnFlag))
  }

  /** Nodes: position-only gizmo; drag end re-grounds and records undo. */
  const selectNode = (mesh: Mesh, node: MapNodeSpawn): void => {
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
    afterSelect(node.id ? [node.id] : [], () => gizmos.attachToMesh(mesh))
  }

  // ── Multi-select: Shift+click accumulates statics; a pivot node carries
  // the gizmo and the meshes ride it, then transforms bake into each body
  // as one undoable batch.
  const multiSel: { mesh: Mesh; body: StaticBody; before: StaticBody }[] = []
  const multiPatches: {
    mesh: Mesh
    patch: PatchState
    before: { origin: [number, number, number]; rot?: [number, number, number] }
  }[] = []
  const multiNodes: { mesh: Mesh; node: MapNodeSpawn; before: [number, number, number] }[] = []
  const multiProps: {
    mesh: Mesh
    prop: { id?: string; item: string; pos: [number, number, number]; yaw?: number }
    before: [number, number, number]
  }[] = []
  const multiAll = (): { mesh: Mesh }[] => [
    ...multiSel,
    ...multiPatches,
    ...multiNodes,
    ...multiProps,
  ]
  const multiTotal = (): number =>
    multiSel.length + multiPatches.length + multiNodes.length + multiProps.length
  const multiPivot = new TransformNode('multipivot', scene)
  const clearMulti = (): void => {
    for (const it of multiSel) {
      it.mesh.setParent(null)
      it.mesh.renderOutline = false
    }
    for (const it of [...multiPatches, ...multiNodes, ...multiProps]) {
      it.mesh.setParent(null)
      it.mesh.renderOutline = false
    }
    multiSel.length = 0
    multiPatches.length = 0
    multiNodes.length = 0
    multiProps.length = 0
  }
  const refreshMultiPivot = (): void => {
    const all = multiAll()
    for (const it of all) it.mesh.setParent(null)
    const c = new Vector3()
    for (const it of all) c.addInPlace(it.mesh.position)
    c.scaleInPlace(1 / Math.max(1, all.length))
    multiPivot.position.copyFrom(c)
    multiPivot.rotationQuaternion = Quaternion.Identity()
    multiPivot.scaling.setAll(1)
    for (const it of all) it.mesh.setParent(multiPivot)
  }
  const addToMulti = (mesh: Mesh, body: StaticBody): void => {
    if (selected) {
      // Promote the single selection into the set first.
      const prev = selected
      selected = null
      if (!multiSel.some((it) => it.mesh === prev.mesh))
        multiSel.push({ mesh: prev.mesh, body: prev.body, before: snapshotBody(prev.body) })
    }
    const i = multiSel.findIndex((it) => it.mesh === mesh)
    if (i >= 0) {
      multiSel[i]!.mesh.setParent(null)
      multiSel[i]!.mesh.renderOutline = false
      multiSel.splice(i, 1)
    } else {
      multiSel.push({ mesh, body, before: snapshotBody(body) })
      mesh.renderOutline = true
      mesh.outlineColor = new Color3(0.4, 0.8, 1)
      mesh.outlineWidth = 0.06
    }
    props.style.display = 'none'
    if (multiSel.length === 0) {
      gizmos.attachToMesh(null)
      return
    }
    finishMultiChange()
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
    refreshMultiPivot()
    // Group scale only makes sense for a statics-only selection.
    if (gizmoMode === 'scale' && (multiPatches.length || multiNodes.length || multiProps.length))
      setGizmoMode('move')
    const ids = [
      ...multiSel.map((it) => it.body.id).filter((x): x is string => Boolean(x)),
      ...multiPatches.map((it) => `terrain:${it.patch.id}`),
      ...multiNodes.map((it) => it.node.id).filter((x): x is string => Boolean(x)),
      ...multiProps.map((it) => it.prop.id).filter((x): x is string => Boolean(x)),
    ]
    fillMultiProps()
    afterSelect(ids, () => gizmos.attachToNode(multiPivot))
    status.textContent = `${multiTotal()} selected — move/rotate together (scale: statics only), Del deletes`
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
    $('p-x').value = r1(multiPivot.position.x)
    $('p-y').value = r1(multiPivot.position.y)
    $('p-z').value = r1(multiPivot.position.z)
    // Rotation and scale act as DELTAS applied to the whole group.
    $('r-x').value = '0'
    $('r-y').value = '0'
    $('r-z').value = '0'
    $('s-x').value = '1'
    $('s-y').value = '1'
    $('s-z').value = '1'
  }
  const addNodeToMulti = (mesh: Mesh, node: MapNodeSpawn): void => {
    if (selectedNode) {
      const prev = selectedNode
      selectedNode = null
      if (!multiNodes.some((it) => it.mesh === prev.mesh)) {
        multiNodes.push({ mesh: prev.mesh, node: prev.node, before: [...prev.node.pos] })
        outline(prev.mesh)
      }
    }
    const i = multiNodes.findIndex((it) => it.mesh === mesh)
    if (i >= 0) {
      multiNodes[i]!.mesh.setParent(null)
      multiNodes[i]!.mesh.renderOutline = false
      multiNodes.splice(i, 1)
    } else {
      multiNodes.push({ mesh, node, before: [...node.pos] })
      outline(mesh)
    }
    finishMultiChange()
  }
  const addPropToMulti = (
    mesh: Mesh,
    prop: { id?: string; item: string; pos: [number, number, number]; yaw?: number },
  ): void => {
    if (selectedProp) {
      const prev = selectedProp
      selectedProp = null
      if (!multiProps.some((it) => it.mesh === prev.mesh)) {
        multiProps.push({ mesh: prev.mesh, prop: prev.prop, before: [...prev.prop.pos] })
        outline(prev.mesh)
      }
    }
    const i = multiProps.findIndex((it) => it.mesh === mesh)
    if (i >= 0) {
      multiProps[i]!.mesh.setParent(null)
      multiProps[i]!.mesh.renderOutline = false
      multiProps.splice(i, 1)
    } else {
      multiProps.push({ mesh, prop, before: [...prop.pos] })
      outline(mesh)
    }
    finishMultiChange()
  }
  const addPatchToMulti = (mesh: Mesh, patch: PatchState): void => {
    if (selectedPatch) {
      const prev = selectedPatch
      selectedPatch = null
      if (!multiPatches.some((it) => it.mesh === prev.mesh))
        multiPatches.push({
          mesh: prev.mesh,
          patch: prev.patch,
          before: {
            origin: [...prev.patch.origin],
            ...(prev.patch.rot ? { rot: [...prev.patch.rot] } : {}),
          },
        })
    }
    const i = multiPatches.findIndex((it) => it.mesh === mesh)
    if (i >= 0) {
      multiPatches[i]!.mesh.setParent(null)
      multiPatches[i]!.mesh.renderOutline = false
      multiPatches.splice(i, 1)
    } else {
      multiPatches.push({
        mesh,
        patch,
        before: { origin: [...patch.origin], ...(patch.rot ? { rot: [...patch.rot] } : {}) },
      })
      mesh.renderOutline = true
      mesh.outlineColor = new Color3(0.4, 0.8, 1)
      mesh.outlineWidth = 0.06
    }
    finishMultiChange()
  }
  /** Bake a finished group drag (any mix of kinds) into ONE undo entry. */
  const bakeMulti = (): void => {
    if (multiTotal() === 0) return
    const subOps: UndoOp[] = []
    const items: { body: StaticBody; before: StaticBody; after: StaticBody }[] = []
    for (const it of multiSel) {
      it.mesh.setParent(null)
      const m = it.mesh
      const b = it.body
      b.pos = [m.position.x, m.position.y, m.position.z]
      const q = m.rotationQuaternion ?? Quaternion.FromEulerAngles(0, m.rotation.y, 0)
      const e2 = q.toEulerAngles()
      b.yaw = e2.y
      if (Math.abs(e2.x) > 0.01 || Math.abs(e2.z) > 0.01) b.rot = [e2.x, e2.y, e2.z]
      else delete b.rot
      // Group scale (statics-only mode): bake inherited pivot scale into dims.
      const sc = m.scaling
      if (Math.abs(sc.x - 1) > 0.001 || Math.abs(sc.y - 1) > 0.001 || Math.abs(sc.z - 1) > 0.001) {
        if (b.shape.type === 'box')
          b.shape.size = [b.shape.size[0] * sc.x, b.shape.size[1] * sc.y, b.shape.size[2] * sc.z]
        else if (b.shape.type === 'cylinder') {
          b.shape.radius *= (sc.x + sc.z) / 2
          b.shape.height *= sc.y
        } else b.shape.radius *= (sc.x + sc.y + sc.z) / 3
        rebuildSelectedMesh(b, m)
      }
      items.push({ body: b, before: it.before, after: snapshotBody(b) })
      it.before = snapshotBody(b)
    }
    if (items.length > 0) subOps.push({ kind: 'batch', items })
    for (const it of multiPatches) {
      it.mesh.setParent(null)
      const m = it.mesh
      const patch = it.patch
      const before = {
        origin: [...it.before.origin] as [number, number, number],
        ...(it.before.rot ? { rot: [...it.before.rot] as [number, number, number] } : {}),
      }
      patch.origin = [m.position.x, m.position.y, m.position.z]
      const q = m.rotationQuaternion ?? Quaternion.FromEulerAngles(0, m.rotation.y, 0)
      const e2 = q.toEulerAngles()
      if (Math.abs(e2.x) > 0.001 || Math.abs(e2.y) > 0.001 || Math.abs(e2.z) > 0.001)
        patch.rot = [e2.x, e2.y, e2.z]
      else delete patch.rot
      subOps.push({
        kind: 'patchedit',
        id: patch.id,
        before,
        after: { origin: [...patch.origin], ...(patch.rot ? { rot: [...patch.rot] } : {}) },
      })
      it.before = { origin: [...patch.origin], ...(patch.rot ? { rot: [...patch.rot] } : {}) }
    }
    for (const it of multiNodes) {
      it.mesh.setParent(null)
      const m = it.mesh
      const after: [number, number, number] = [m.position.x, 0, m.position.z]
      subOps.push({ kind: 'nodemove', node: it.node, before: it.before, after })
      it.node.pos = after
      m.position.set(after[0], sampleH(after[0], after[2]) + 0.4, after[2])
      it.before = [...after]
    }
    for (const it of multiProps) {
      it.mesh.setParent(null)
      const m = it.mesh
      const after: [number, number, number] = [m.position.x, 1, m.position.z]
      subOps.push({ kind: 'propmove', prop: it.prop, before: it.before, after })
      it.prop.pos = after
      m.position.set(after[0], sampleH(after[0], after[2]) + 0.5, after[2])
      it.before = [...after]
    }
    if (subOps.length === 1) pushUndo(subOps[0]!)
    else if (subOps.length > 1) pushUndo({ kind: 'group', label: 'group transform', ops: subOps })
    refreshMultiPivot()
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
    if (gizmoMode === 'scale') setGizmoMode('move')
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = 'starter island terrain'
    for (const id of ['dims-box', 'dims-cyl', 'dims-sph']) $e(id).style.display = 'none'
    status.textContent =
      'starter island — a normal terrain: move/tilt converts it to a patch, Del removes it'
    afterSelect(['terrain:main'], () => gizmos.attachToMesh(terrain))
  }

  /** Patches: move + tilt the whole terrain patch. */
  const selectPatch = (mesh: Mesh, patch: PatchState): void => {
    deselect()
    selectedPatch = { mesh, patch }
    setGizmoMode(gizmoMode === 'scale' ? 'move' : gizmoMode)
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = `terrain patch (${patch.halfExtent * 2}m)`
    for (const id of ['dims-box', 'dims-cyl', 'dims-sph']) $e(id).style.display = 'none'
    const deg = (r: number) => Math.round((r * 180) / Math.PI)
    const rot = patch.rot ?? [0, 0, 0]
    $('p-x').value = String(patch.origin[0])
    $('p-y').value = String(patch.origin[1])
    $('p-z').value = String(patch.origin[2])
    $('r-x').value = String(deg(rot[0]))
    $('r-y').value = String(deg(rot[1]))
    $('r-z').value = String(deg(rot[2]))
    texSel.value = patch.tex === 'none' ? '' : (patch.tex ?? 'leafy_grass')
    texPicker.sync()
    ;($('p-color') as HTMLInputElement).value = patch.color ?? '#bfbfbf'
    status.textContent = 'sculpt patches with the Terrain tool · tilt for caves/overhangs'
    afterSelect([`terrain:${patch.id}`], () => gizmos.attachToMesh(mesh))
  }
  const rebuildSelectedMesh = (body: StaticBody, oldMesh: Mesh): Mesh => {
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
  const fillProps = (body: StaticBody): void => {
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
    ;($('p-color') as HTMLInputElement).value = body.color
    texSel.value = body.tex ?? ''
    texPicker.sync()
    $e('light-rows').style.display = 'none'
    const lc = document.getElementById('p-lamp') as HTMLInputElement | null
    if (lc) lc.checked = body.decor === 'lamp'
  }
  const select = (mesh: Mesh, body: StaticBody): void => {
    deselect()
    selected = { mesh, body, editBefore: null }
    setGizmoMode(gizmoMode)
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = `${body.shape.type} static`
    fillProps(body)
    afterSelect(body.id ? [body.id] : [], () => gizmos.attachToMesh(mesh))
  }
  const snapshotBody = (b: StaticBody): StaticBody => JSON.parse(JSON.stringify(b)) as StaticBody
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
  // Gizmo drags write back into the body (and undo) on release. The
  // GizmoManager creates gizmo instances lazily when a mode first enables,
  // so hooks re-wire after every mode switch (idempotent via WeakSet).
  const wiredGizmos = new WeakSet<object>()
  function wireGizmoHooks(): void {
    wirePosRot()
    wireScale()
  }
  function wirePosRot(): void {
    for (const g of [gizmos.gizmos.positionGizmo, gizmos.gizmos.rotationGizmo]) {
      if (!g || wiredGizmos.has(g)) continue
      wiredGizmos.add(g)
      g.onDragStartObservable.add(beginEdit)
      g.onDragEndObservable.add(() => {
        if (mainSelected) {
          // Bake the drag into a real patch; the base grid stays anchored.
          const pos = terrain.position.clone()
          const rq = terrain.rotationQuaternion?.clone() ?? null
          const er = rq ? rq.toEulerAngles() : terrain.rotation.clone()
          terrain.position.set(0, 0, 0)
          terrain.rotationQuaternion = null
          terrain.rotation.set(0, 0, 0)
          wire.position.set(0, 0.03, 0)
          const patch = convertMainToPatch(false)
          if (patch) {
            patch.origin = [pos.x, pos.y, pos.z]
            if (Math.abs(er.x) > 0.001 || Math.abs(er.y) > 0.001 || Math.abs(er.z) > 0.001)
              patch.rot = [er.x, er.y, er.z]
            for (const [m, pp] of patchMeshes) {
              if (pp === patch) {
                m.position.set(patch.origin[0], patch.origin[1], patch.origin[2])
                if (patch.rot) m.rotation.set(patch.rot[0], patch.rot[1], patch.rot[2])
                deselect()
                selectPatch(m, patch)
                break
              }
            }
            status.textContent = '⛰ starter island converted to a regular terrain patch'
          }
          return
        }
        if (multiTotal() > 0) {
          bakeMulti()
          fillMultiProps()
          return
        }
        if (selectedLight) {
          const { mesh: m, light } = selectedLight
          const before = JSON.parse(JSON.stringify(light)) as MapLight
          light.pos = [m.position.x, m.position.y, m.position.z]
          if (light.type !== 'point') {
            const q = m.rotationQuaternion ?? Quaternion.Identity()
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
          fillLightProps(light)
          return
        }
        if (selectedNode) {
          const m = selectedNode.mesh
          const node = selectedNode.node
          const after: [number, number, number] = [snapVal(m.position.x), 0, snapVal(m.position.z)]
          node.pos = after
          m.position.set(after[0], sampleH(after[0], after[2]) + 0.4, after[2])
          pushUndo({ kind: 'nodemove', node, before: selectedNode.before, after })
          selectedNode.before = [after[0], after[1], after[2]]
          $('p-x').value = String(after[0])
          $('p-z').value = String(after[2])
          return
        }
        if (selectedPatch) {
          const m = selectedPatch.mesh
          const patch = selectedPatch.patch
          const before = {
            origin: [...patch.origin] as [number, number, number],
            ...(patch.rot ? { rot: [...patch.rot] as [number, number, number] } : {}),
          }
          patch.origin = [m.position.x, m.position.y, m.position.z]
          const e2 = m.rotationQuaternion ? m.rotationQuaternion.toEulerAngles() : m.rotation
          if (Math.abs(e2.x) > 0.001 || Math.abs(e2.y) > 0.001 || Math.abs(e2.z) > 0.001)
            patch.rot = [e2.x, e2.y, e2.z]
          else delete patch.rot
          pushUndo({
            kind: 'patchedit',
            id: patch.id,
            before,
            after: {
              origin: [...patch.origin] as [number, number, number],
              ...(patch.rot ? { rot: [...patch.rot] as [number, number, number] } : {}),
            },
          })
          return
        }
        if (!selected) return
        const m = selected.mesh
        const b = selected.body
        b.pos = [snapVal(m.position.x), m.position.y, snapVal(m.position.z)]
        m.position.set(b.pos[0], b.pos[1], b.pos[2])
        const e2 = m.rotationQuaternion ? m.rotationQuaternion.toEulerAngles() : m.rotation
        b.yaw = e2.y
        if (Math.abs(e2.x) > 0.01 || Math.abs(e2.z) > 0.01) b.rot = [e2.x, e2.y, e2.z]
        else delete b.rot
        fillProps(b)
        commitEdit()
      })
    }
  }
  function wireScale(): void {
    const g = gizmos.gizmos.scaleGizmo
    if (!g || wiredGizmos.has(g)) return
    wiredGizmos.add(g)
    g.onDragStartObservable.add(beginEdit)
    g.onDragEndObservable.add(() => {
      if (multiTotal() > 0) {
        bakeMulti()
        fillMultiProps()
        return
      }
      if (!selected) return
      // Bake the gizmo scale into the shape dimensions, then rebuild clean.
      const m = selected.mesh
      const b = selected.body
      const sc = m.scaling
      if (b.shape.type === 'box')
        b.shape.size = [b.shape.size[0] * sc.x, b.shape.size[1] * sc.y, b.shape.size[2] * sc.z]
      else if (b.shape.type === 'cylinder') {
        b.shape.radius *= (sc.x + sc.z) / 2
        b.shape.height *= sc.y
      } else b.shape.radius *= (sc.x + sc.y + sc.z) / 3
      rebuildSelectedMesh(b, m)
      fillProps(b)
      commitEdit()
    })
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
      multiPivot.position.set(px, py, pz)
      multiPivot.rotationQuaternion = Quaternion.FromEulerAngles(
        rad2(Number($('r-x').value) || 0),
        rad2(Number($('r-y').value) || 0),
        rad2(Number($('r-z').value) || 0),
      )
      const sx = Number($('s-x').value) || 1
      const sy = Number($('s-y').value) || 1
      const sz = Number($('s-z').value) || 1
      if (multiSel.length === multiTotal()) {
        multiPivot.scaling.set(sx, sy, sz)
      } else if (sx !== 1 || sy !== 1 || sz !== 1) {
        status.textContent = '⚠ group scale needs a statics-only selection — scale ignored'
      }
      bakeMulti()
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
    apply: (v: number, b: StaticBody) => void,
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
  const setRot = (b: StaticBody): void => {
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
  for (const [id, axis] of [
    ['s-x', 0],
    ['s-y', 1],
    ['s-z', 2],
  ] as const) {
    $(id).addEventListener('change', () => {
      const f = Number($(id).value)
      if (!Number.isFinite(f) || f <= 0) {
        $(id).value = '1'
        return
      }
      if (!selected) {
        if (multiTotal() > 0) applyManualPose() // group scale via pivot
        return
      }
      beginEdit()
      const b = selected.body
      if (b.shape.type === 'box') b.shape.size[axis] *= f
      else if (b.shape.type === 'cylinder') {
        if (axis === 1) b.shape.height *= f
        else b.shape.radius *= f
      } else b.shape.radius *= f
      rebuildSelectedMesh(b, selected.mesh)
      fillProps(b)
      commitEdit()
      $(id).value = '1'
    })
  }
  /** Apply a color or texture change to EVERY selected object (one undo). */
  const groupApplyStyle = (change: { color?: string; tex?: string | null }): void => {
    const subOps: UndoOp[] = []
    const items: { body: StaticBody; before: StaticBody; after: StaticBody }[] = []
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
      if (!patch.mix) applyPatchMaterial(it.mesh.material as StandardMaterial, patch)
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
    refreshMultiPivot()
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
      if (!patch.mix) applyPatchMaterial(selectedPatch.mesh.material as StandardMaterial, patch)
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
      if (!patch.mix) applyPatchMaterial(selectedPatch.mesh.material as StandardMaterial, patch)
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
      if (!patch.mix) applyPatchMaterial(selectedPatch.mesh.material as StandardMaterial, patch)
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
      const newBodies: { mesh: Mesh; body: StaticBody }[] = []
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
    body?: StaticBody
    patch?: PatchState
    /** Box face index 0..5, or null = whole surface. */
    face: number | null
  }
  const faceSel: FaceSel[] = []
  const FACE_NAMES = ['Front', 'Back', 'Right', 'Left', 'Top', 'Bottom']
  let fColorOn = false
  const clearFaceSel = (): void => {
    faceSel.length = 0
    updateFaceInfo()
    refreshSelectionVisuals()
  }
  const updateFaceInfo = (): void => {
    const info = $e('face-info')
    if (faceSel.length === 0) {
      info.textContent = 'click a face · Shift adds · RMB applies current'
      return
    }
    info.textContent = faceSel
      .map((fs) =>
        fs.patch
          ? `patch ${fs.patch.halfExtent * 2}m`
          : fs.face === null
            ? fs.body!.shape.type
            : `${fs.body!.shape.type} ${FACE_NAMES[fs.face]}`,
      )
      .join(' · ')
      .slice(0, 90)
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
    const items: { body: StaticBody; before: StaticBody; after: StaticBody }[] = []
    // Group per body so a box with several selected faces rebuilds ONCE.
    const byBody = new Map<StaticBody, FaceSel[]>()
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
      for (const fs of faceSel) if (fs.body === body) fs.mesh = nm
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
      if (!patch.mix) applyPatchMaterial(fs.mesh.material as StandardMaterial, patch)
      subOps.push({ kind: 'patchprop', patch, before, after: patchPropSnapshot(patch) })
    }
    if (subOps.length === 1) pushUndo(subOps[0]!)
    else if (subOps.length > 1)
      pushUndo({ kind: 'group', label: reset ? 'face reset' : 'face edit', ops: subOps })
    refreshSelectionVisuals()
    status.textContent = reset
      ? `${targets.length} surface(s) reset to defaults`
      : `🎨 style applied to ${targets.length} surface(s)`
  }
  const handleFacePointer = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 2) return
    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (m) => m.isEnabled() && (staticMeshes.has(m as Mesh) || patchMeshes.has(m as Mesh)),
    )
    if (!pick?.hit || !pick.pickedMesh) {
      if (e.button === 0 && !e.shiftKey) clearFaceSel()
      return
    }
    const mesh = pick.pickedMesh as Mesh
    const body = staticMeshes.get(mesh)
    const patch = patchMeshes.get(mesh)
    const face =
      body && body.shape.type === 'box' && pick.faceId >= 0 ? Math.floor(pick.faceId / 2) : null
    const fs: FaceSel = { mesh, ...(body ? { body } : {}), ...(patch ? { patch } : {}), face }
    if (e.button === 2) {
      // Hammer right-click: paint the face with the current settings.
      applyFaceStyleTo([fs])
      return
    }
    const idx = faceSel.findIndex((x) => x.mesh === mesh && x.face === face)
    if (e.shiftKey || e.ctrlKey) {
      if (idx >= 0) faceSel.splice(idx, 1)
      else faceSel.push(fs)
    } else {
      faceSel.length = 0
      faceSel.push(fs)
      if (e.altKey) {
        liftFace(fs) // Alt+click = pure lift (Hammer's eyedropper)
      }
    }
    if (faceSel[0]) liftFace(faceSel[0])
    updateFaceInfo()
    refreshSelectionVisuals()
  }
  $e('f-apply').addEventListener('click', () => applyFaceStyleTo(faceSel))
  $e('f-apply-all').addEventListener('click', () =>
    applyFaceStyleTo(faceSel.map((fs) => ({ ...fs, face: null }))),
  )
  $e('f-clear').addEventListener('click', () => applyFaceStyleTo(faceSel, true))
  $e('f-lift').addEventListener('click', () => {
    if (faceSel[0]) liftFace(faceSel[0])
  })
  $('f-color').addEventListener('input', () => (fColorOn = true))
  $e('f-color-clear').addEventListener('click', () => {
    fColorOn = false
    status.textContent = 'tint cleared — Apply writes the face without a tint'
  })
  const justify = (patchVals: Partial<Record<'f-sx' | 'f-sy' | 'f-ox' | 'f-oy', number>>): void => {
    for (const [id, v] of Object.entries(patchVals)) $(id).value = String(v)
    applyFaceStyleTo(faceSel)
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

  // ── Pointer handling ────────────────────────────────────────────────
  let painting = 0 // 0 none, 1 = LMB, 2 = RMB (lower)
  let mouseIsDown = false
  window.addEventListener('pointerdown', (e) => {
    if (e.button === 0 || e.button === 2) mouseIsDown = true
  })
  window.addEventListener('pointerup', () => (mouseIsDown = false))
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('pointerdown', (e) => {
    if (freeLook) return
    if (e.button !== 0 && e.button !== 2) return
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
      paintBefore = mixCtx.getImageData(0, 0, MIX, MIX)
      painting = 1
      applyPaint()
    } else if ((tool === 'mesh' || tool === 'entity') && e.button === 0) {
      const pose = computePlacePose()
      if (pose) placeAt(pose)
    } else if (tool === 'light' && e.button === 0) {
      const pick = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (m) => m !== ghost && m !== wire && m.isEnabled() && !lightMeshes.has(m as Mesh),
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
      const pick = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (m) =>
          m.isEnabled() &&
          (staticMeshes.has(m as Mesh) ||
            nodeMeshes.has(m as Mesh) ||
            propMeshes.has(m as Mesh) ||
            lightMeshes.has(m as Mesh)),
      )
      const mesh = pick?.pickedMesh as Mesh | undefined
      if (e.shiftKey) {
        // Shift+click accumulates: statics, patches, nodes and props mix.
        if (mesh && staticMeshes.has(mesh)) {
          addToMulti(mesh, staticMeshes.get(mesh)!)
          return
        }
        if (mesh && nodeMeshes.has(mesh)) {
          addNodeToMulti(mesh, nodeMeshes.get(mesh)!)
          return
        }
        if (mesh && propMeshes.has(mesh)) {
          addPropToMulti(mesh, propMeshes.get(mesh)!)
          return
        }
        const shiftPatch = scene.pick(
          scene.pointerX,
          scene.pointerY,
          (m) => m.isEnabled() && patchMeshes.has(m as Mesh),
        )?.pickedMesh as Mesh | undefined
        if (shiftPatch && patchMeshes.has(shiftPatch)) {
          addPatchToMulti(shiftPatch, patchMeshes.get(shiftPatch)!)
          return
        }
      }
      if (mesh && staticMeshes.has(mesh) && e.shiftKey) {
        addToMulti(mesh, staticMeshes.get(mesh)!)
        return
      }
      if (mesh && staticMeshes.has(mesh)) select(mesh, staticMeshes.get(mesh)!)
      else if (mesh && nodeMeshes.has(mesh)) selectNode(mesh, nodeMeshes.get(mesh)!)
      else if (mesh && propMeshes.has(mesh)) selectProp(mesh, propMeshes.get(mesh)!)
      else if (mesh && lightMeshes.has(mesh)) selectLight(mesh, lightMeshes.get(mesh)!)
      else if (pick?.pickedMesh && spawnFlag.getChildMeshes().includes(pick.pickedMesh as Mesh))
        selectSpawn()
      else {
        // Patches are selectable too (move/tilt/delete whole patch).
        const ppick = scene.pick(
          scene.pointerX,
          scene.pointerY,
          (m) => m.isEnabled() && patchMeshes.has(m as Mesh),
        )
        const pmesh = ppick?.pickedMesh as Mesh | undefined
        if (pmesh && patchMeshes.has(pmesh)) selectPatch(pmesh, patchMeshes.get(pmesh)!)
        else {
          // A removed (sunken+disabled) starter island must NOT catch rays.
          const tpick = scene.pick(
            scene.pointerX,
            scene.pointerY,
            (m) => m === terrain && terrain.isEnabled(),
          )
          if (tpick?.hit) selectMainTerrain()
          else deselect()
        }
      }
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
    if (painting && paintBefore) {
      pushUndo({ kind: 'paint', before: paintBefore, after: mixCtx.getImageData(0, 0, MIX, MIX) })
      paintBefore = null
    }
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
    if (t.target.id === 'main') {
      paint(t.local.x, t.local.z)
      return
    }
    const patch = t.target.patch
    if (!patch) return
    const ctx = ensurePatchMix(patch, t.target.mesh)
    const radius = Number($('radius').value)
    const strength = Math.min(1, Number($('strength').value))
    const feather = Number($('feather').value)
    const u = ((t.local.x + patch.halfExtent) / (patch.halfExtent * 2)) * PATCH_MIX
    const vpix = (1 - (t.local.z + patch.halfExtent) / (patch.halfExtent * 2)) * PATCH_MIX
    const r = (radius / (patch.halfExtent * 2)) * PATCH_MIX
    const g = ctx.createRadialGradient(u, vpix, 0, u, vpix, r)
    const color = (document.getElementById('paint') as HTMLSelectElement).value
    const core = Math.max(0.05, Math.min(0.95, 1 - 1 / (0.4 + feather)))
    const alpha = Math.round(strength * 255)
      .toString(16)
      .padStart(2, '0')
    g.addColorStop(0, `${color}${alpha}`)
    g.addColorStop(core, `${color}${alpha}`)
    g.addColorStop(1, `${color}00`)
    ctx.fillStyle = g
    ctx.fillRect(u - r, vpix - r, r * 2, r * 2)
    patch.mix = (ctx.canvas as HTMLCanvasElement).toDataURL('image/png')
    ;(scene.getTextureByName(`pmix:${patch.id}`) as DynamicTexture | null)?.update()
    markDirty()
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
        deselect()
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
    if (tool === 'select' && ++frameTick % 6 === 0) {
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
    wireHover = tool !== 'paint' && sculpting && overTerrain
    wire.setEnabled(wireHover || mainSelected)
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

  let lastSig = ''

  // ── Save ────────────────────────────────────────────────────────────
  const buildFile = (): MapFile => ({
    v: 1,
    halfExtent: HALF,
    sub: SUB,
    heights: encodeHeights(heights),
    mix: (mixCtx.canvas as HTMLCanvasElement).toDataURL('image/png'),
    statics: placedStatics,
    nodes: placedNodes,
    props: placedProps,
    terrains: patches.map((pp) => ({
      id: pp.id,
      origin: pp.origin,
      halfExtent: pp.halfExtent,
      sub: pp.sub,
      heights: encodeHeights(pp.heights),
      ...(pp.rot ? { rot: pp.rot } : {}),
      ...(pp.tex ? { tex: pp.tex } : {}),
      ...(pp.color ? { color: pp.color } : {}),
      ...(pp.mix ? { mix: pp.mix } : {}),
      ...(pp.uv ? { uv: pp.uv } : {}),
    })),
    models: mapModels,
    textures: mapTextures,
    lights: mapLightsArr,
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
        headers: { 'content-type': 'application/json', 'x-editor-key': key },
        body: JSON.stringify(file),
      })
      if (resp.ok) {
        savedTopOp = topOpId()
        nonHistoryDirt = false
        updateDirty()
        lastSig = `${file.heights.length}:${file.statics.length}:${(file.nodes ?? []).length}:${(file.mix ?? '').length}:${(file.terrains ?? []).length}:${(file.models ?? []).length}:${(file.textures ?? []).length}:${(file.lights ?? []).length}`
      }
      status.textContent = resp.ok
        ? '✅ saved — live in game'
        : resp.status === 403
          ? '⛔ not authorized (admin token/key required)'
          : `save failed (${resp.status})`
    })()
  })

  // ── Remote merge (instant via editor-ws push, 6s poll as fallback) ──
  const mergeRemote = async (): Promise<void> => {
    if (painting) return
    try {
      const map = (await (await fetch('/map.json')).json()) as MapFile | null
      if (!map || map.v !== 1 || map.sub !== SUB) return
      // Revision safety: a remote save must never wipe local dirty work.
      if (dirty) {
        const sig2 = `${map.heights.length}:${map.statics.length}:${(map.nodes ?? []).length}:${(map.mix ?? '').length}:${(map.terrains ?? []).length}:${(map.models ?? []).length}:${(map.textures ?? []).length}:${(map.lights ?? []).length}`
        if (sig2 !== lastSig) {
          lastSig = sig2
          $e('conflict').style.display = 'flex'
          status.textContent = '⚠ another admin saved while you have unsaved changes'
        }
        return
      }
      const sig = `${map.heights.length}:${map.statics.length}:${(map.nodes ?? []).length}:${(map.mix ?? '').length}:${(map.terrains ?? []).length}:${(map.models ?? []).length}:${(map.textures ?? []).length}:${(map.lights ?? []).length}`
      if (sig === lastSig) return
      lastSig = sig
      heights.set(decodeHeights(map.heights))
      refreshTerrainMesh()
      if (map.mix) {
        const img = new Image()
        img.onload = () => {
          mixCtx.drawImage(img, 0, 0, MIX, MIX)
          mixTex.update()
        }
        img.src = map.mix
      }
      deselect()
      for (const m of [...staticMeshes.keys(), ...nodeMeshes.keys()]) m.dispose()
      staticMeshes.clear()
      nodeMeshes.clear()
      placedStatics = map.statics
      placedNodes = map.nodes ?? []
      for (const m of propMeshes.keys()) m.dispose()
      propMeshes.clear()
      placedProps = map.props ?? []
      for (const st of placedStatics) renderStatic(st)
      for (const n of placedNodes) renderNode(n)
      for (const pr of placedProps) renderProp(pr)
      // Patches: rebuild from the remote artifact.
      for (const m of patchMeshes.keys()) m.dispose()
      patchMeshes.clear()
      for (let i = terrainTargets.length - 1; i >= 0; i--) {
        if (terrainTargets[i]!.patch) terrainTargets.splice(i, 1)
      }
      patches = (map.terrains ?? []).map((t) => ({ ...t, heights: decodeHeights(t.heights) }))
      for (const pp of patches) buildPatchMesh(pp)
      mapModels = map.models ?? []
      mapTextures = map.textures ?? []
      refreshImportedPalette()
      for (const l of [...mapLightsArr]) removeLightRender(l)
      mapLightsArr = map.lights ?? []
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
    savedTopOp = topOpId()
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
  interface PeerAvatar {
    root: TransformNode
    label: Mesh
  }
  const peerAvatars = new Map<number, PeerAvatar>()
  const peersEl = $e('peers')
  const updatePeersLabel = (): void => {
    peersEl.textContent =
      peerAvatars.size > 0
        ? `👁 ${peerAvatars.size} co-editor${peerAvatars.size > 1 ? 's' : ''} online`
        : ''
  }
  const makeEyeball = (id: number, name: string): PeerAvatar => {
    const root = new TransformNode(`peer:${id}`, scene)
    const eye = CreateSphere(`peer:${id}:eye`, { diameter: 0.9, segments: 12 }, scene)
    eye.parent = root
    const em = new StandardMaterial(`peer:${id}:m`, scene)
    em.diffuseColor = new Color3(0.95, 0.95, 0.98)
    em.emissiveColor = new Color3(0.25, 0.25, 0.28)
    eye.material = em
    const iris = CreateCylinder(
      `peer:${id}:iris`,
      { diameter: 0.34, height: 0.04, tessellation: 16 },
      scene,
    )
    iris.parent = root
    iris.rotation.x = Math.PI / 2
    iris.position.z = 0.44
    const im = new StandardMaterial(`peer:${id}:im`, scene)
    im.diffuseColor = new Color3(0.1, 0.35, 0.7)
    im.emissiveColor = new Color3(0.05, 0.2, 0.45)
    iris.material = im
    const label = makeLabel(name)
    label.parent = root
    label.position.y = 0.85
    for (const m of [eye, iris, label]) m.isPickable = false
    return { root, label }
  }
  const makeLabel = (text: string): Mesh => {
    const tex = new DynamicTexture(`lbl:${text}`, { width: 256, height: 64 }, scene, false)
    const ctx = tex.getContext() as CanvasRenderingContext2D
    ctx.font = 'bold 34px system-ui'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#7fd0ff'
    ctx.fillText(text.slice(0, 14), 128, 44)
    tex.update()
    tex.hasAlpha = true
    const plane = new Mesh('lblp', scene)
    const vdp = new VertexData()
    vdp.positions = [-1, -0.25, 0, 1, -0.25, 0, 1, 0.25, 0, -1, 0.25, 0]
    vdp.indices = [0, 1, 2, 0, 2, 3]
    vdp.uvs = [0, 0, 1, 0, 1, 1, 0, 1]
    vdp.applyToMesh(plane)
    const lm = new StandardMaterial('lblm', scene)
    lm.diffuseTexture = tex
    lm.emissiveColor = new Color3(1, 1, 1)
    lm.disableLighting = true
    lm.backFaceCulling = false
    plane.material = lm
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL
    return plane
  }
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
        let avatar = peerAvatars.get(msg.id)
        if (!avatar) {
          avatar = makeEyeball(msg.id, msg.name ?? 'editor')
          peerAvatars.set(msg.id, avatar)
          updatePeersLabel()
        }
        avatar.root.position.set(msg.pos[0] ?? 0, msg.pos[1] ?? 0, msg.pos[2] ?? 0)
        avatar.root.rotation.set(msg.pitch ?? 0, msg.yaw ?? 0, 0)
      } else if (msg.t === 'peer_gone' && msg.id !== undefined) {
        const avatar = peerAvatars.get(msg.id)
        if (avatar) {
          avatar.root.dispose(false, true)
          peerAvatars.delete(msg.id)
          updatePeersLabel()
        }
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
    texPicker.refresh()
    faceTexPicker.refresh()
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
        const { SceneLoader } = await import('@babylonjs/core/Loading/sceneLoader.js')
        await import('@babylonjs/loaders/glTF/2.0/glTFLoader.js')
        const result = await SceneLoader.ImportMeshAsync('', '', dataUrl, scene, undefined, '.glb')
        const root = result.meshes[0]
        if (!root) throw new Error('empty glb')
        const { min, max } = root.getHierarchyBoundingVectors(true)
        const bounds: [number, number, number] = [
          Math.max(0.2, max.x - min.x),
          Math.max(0.2, max.y - min.y),
          Math.max(0.2, max.z - min.z),
        ]
        for (const m of result.meshes) m.dispose()
        const id = `model-${Date.now().toString(36)}`
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
    for (const [m, pp] of patchMeshes) {
      if (!pp.mix) applyPatchMaterial(m.material as StandardMaterial, pp)
    }
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

  // ── Settings: remappable hotkeys ────────────────────────────────────
  const settingsEl = $e('settings')
  let recording: string | null = null
  const renderKeys = (): void => {
    const list = $e('keys-list')
    list.replaceChildren()
    let lastGroup = ''
    for (const a of ACTIONS) {
      if (a.group !== lastGroup) {
        lastGroup = a.group
        const h = document.createElement('div')
        h.textContent = a.group.toUpperCase()
        h.style.cssText = 'color:#e8b54a;font-size:10px;letter-spacing:.1em;margin-top:6px'
        list.appendChild(h)
      }
      const row = document.createElement('div')
      row.className = 'krow'
      const lbl = document.createElement('span')
      lbl.textContent = a.label
      const inp = document.createElement('input')
      inp.readOnly = true
      inp.value = formatBinding(bindingOf(a.id))
      inp.addEventListener('focus', () => {
        recording = a.id
        inp.value = 'press key…'
      })
      inp.addEventListener('blur', () => {
        recording = null
        inp.value = formatBinding(bindingOf(a.id))
      })
      inp.addEventListener('keydown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return
        if (e.code === 'Escape') {
          inp.blur()
          return
        }
        const b2 = bindingFromEvent(e)
        const conflicts = findConflicts(bindings, b2, a.id)
        if (conflicts.length > 0) {
          const names = conflicts
            .map((cid) => ACTIONS.find((x) => x.id === cid)?.label ?? cid)
            .join(', ')
          inp.value = `⚠ used by ${names}`
          inp.style.color = '#ff8f6e'
          setTimeout(() => {
            inp.style.color = ''
            inp.value = formatBinding(bindingOf(a.id))
          }, 1600)
          return
        }
        bindings[a.id] = b2
        localStorage.setItem('hobo.editor.bindings', JSON.stringify(bindings))
        inp.value = formatBinding(b2)
        refreshToolButtons()
        renderHelp()
        inp.blur()
      })
      row.append(lbl, inp)
      list.appendChild(row)
    }
  }
  const refreshToolButtons = (): void => {
    toolsEl.querySelectorAll('button').forEach((b) => {
      const hk = b.querySelector('.hk')
      const t = b.dataset['tool']
      if (hk && t) hk.textContent = formatBinding(bindingOf(`tool.${t}`))
    })
  }
  document.getElementById('settings-btn')?.addEventListener('click', () => {
    settingsEl.style.display = settingsEl.style.display === 'flex' ? 'none' : 'flex'
    renderKeys()
  })
  document.getElementById('settings-close')?.addEventListener('click', () => {
    settingsEl.style.display = 'none'
  })
  document.getElementById('keys-reset')?.addEventListener('click', () => {
    localStorage.removeItem('hobo.editor.bindings')
    const fresh = loadBindings(null)
    for (const k of Object.keys(bindings)) delete bindings[k]
    Object.assign(bindings, fresh)
    renderKeys()
    refreshToolButtons()
  })
  void recording

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

  // Blender-style drag-scrub on every numeric input (incl. dynamic panels).
  scrubAllNumbers(document)

  // Test/debug handle (harness-only; not part of any API contract).
  ;(window as unknown as Record<string, unknown>)['__editor'] = {
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
      return undoStack.length
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
      multiPivot.position.addInPlaceFromFloats(dx, dy, dz)
      bakeMulti()
      fillMultiProps()
    },
    lights() {
      return JSON.parse(JSON.stringify(mapLightsArr)) as unknown
    },
    statics() {
      return JSON.parse(JSON.stringify(placedStatics)) as unknown
    },
    faceSelCount() {
      return faceSel.length
    },
  }
}

void boot()
