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
import {
  buildTerrainGrid,
  createContent,
  decodeHeights,
  defaultHeights,
  encodeHeights,
  setMapOverride,
  type MapFile,
  type MapNodeSpawn,
  type StaticBody,
} from '@hobo/content'
import { meshForShape } from '../render/sceneSetup.js'

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

type Tool = 'sculpt' | 'smooth' | 'flatten' | 'paint' | 'place' | 'select'

interface Placeable {
  name: string
  kind: 'static' | 'node'
  shape?: StaticBody['shape']
  color?: string
  tex?: string
  decor?: string
  node?: string
}

const PLACEABLES: Placeable[] = [
  {
    name: 'Stone block',
    kind: 'static',
    shape: { type: 'box', size: [2, 2, 2] },
    color: '#8a8d90',
    tex: 'gray_rocks',
  },
  {
    name: 'Wall 4m',
    kind: 'static',
    shape: { type: 'box', size: [4, 3, 0.4] },
    color: '#9a9187',
    tex: 'plastered_wall_02',
  },
  {
    name: 'Brick block',
    kind: 'static',
    shape: { type: 'box', size: [3, 3, 3] },
    color: '#8d5f4d',
    tex: 'red_brick',
  },
  {
    name: 'Wood platform',
    kind: 'static',
    shape: { type: 'box', size: [4, 0.4, 4] },
    color: '#8a6a42',
    tex: 'wood_planks',
  },
  {
    name: 'Ramp 6m',
    kind: 'static',
    shape: { type: 'box', size: [4, 0.4, 6] },
    color: '#8f8a82',
    tex: 'gray_rocks',
  },
  {
    name: 'Pillar',
    kind: 'static',
    shape: { type: 'cylinder', radius: 0.5, height: 4 },
    color: '#8f8a82',
  },
  { name: 'Boulder', kind: 'static', shape: { type: 'sphere', radius: 1.4 }, color: '#7b7f83' },
  {
    name: 'Street lamp',
    kind: 'static',
    shape: { type: 'box', size: [0.16, 3.4, 0.16] },
    color: '#3a3f45',
    decor: 'lamp',
  },
  { name: '🌳 Oak tree (chop)', kind: 'node', node: 'oak_tree' },
  { name: '🫐 Berry bush', kind: 'node', node: 'berry_bush' },
  { name: '🪨 Stone deposit (pick)', kind: 'node', node: 'stone_deposit' },
  { name: '🌿 Branch pile', kind: 'node', node: 'branch_pile' },
  { name: '🥌 Loose stones', kind: 'node', node: 'loose_stones' },
  { name: '⚙ Scrap pile', kind: 'node', node: 'scrap_pile' },
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

type UndoOp =
  | { kind: 'terrain'; before: Float32Array; after: Float32Array }
  | { kind: 'paint'; before: ImageData; after: ImageData }
  | { kind: 'place'; body?: StaticBody; node?: MapNodeSpawn }
  | { kind: 'delete'; body?: StaticBody; node?: MapNodeSpawn }
  | { kind: 'edit'; body: StaticBody; before: StaticBody; after: StaticBody }

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
  camera.speed = 1.6
  camera.attachControl(canvas, true)
  camera.inputs.removeByType('FreeCameraMouseInput')
  camera.keysUp = [87]
  camera.keysDown = [83]
  camera.keysLeft = [65]
  camera.keysRight = [68]
  camera.keysUpward = [69]
  camera.keysDownward = [81]
  let freeLook = false
  document.addEventListener('pointerlockchange', () => {
    freeLook = document.pointerLockElement === canvas
  })
  canvas.addEventListener('mousemove', (e) => {
    if (!freeLook) return
    camera.rotation.y += e.movementX * 0.0032
    camera.rotation.x = Math.max(-1.5, Math.min(1.5, camera.rotation.x + e.movementY * 0.0032))
  })

  // ── Load map (or blank floor) ───────────────────────────────────────
  let heights: Float32Array
  let placedStatics: StaticBody[] = []
  let placedNodes: MapNodeSpawn[] = []
  let savedMix: string | undefined
  try {
    const map = (await (await fetch('/map.json')).json()) as MapFile | null
    if (map && map.v === 1 && map.sub === SUB) {
      heights = decodeHeights(map.heights)
      placedStatics = map.statics
      placedNodes = map.nodes ?? []
      savedMix = map.mix
    } else {
      heights = defaultHeights(world, SUB)
    }
  } catch {
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
    applyBodyToMesh(mesh, s)
    staticMeshes.set(mesh, s)
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
    return heights[j * (SUB + 1) + i] ?? 0
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
  let tool: Tool = 'sculpt'
  const toolsEl = $e('tools')
  const TOOLS: [Tool, string][] = [
    ['sculpt', '⛰ Raise/Lower'],
    ['smooth', '〰 Smooth'],
    ['flatten', '▭ Flatten'],
    ['paint', '🖌 Paint'],
    ['place', '📦 Place'],
    ['select', '🖱 Select'],
  ]
  const setTool = (id: Tool): void => {
    tool = id
    toolsEl
      .querySelectorAll('button')
      .forEach((x) => x.classList.toggle('active', x.dataset['tool'] === id))
    $e('paint-row').style.display = id === 'paint' ? 'flex' : 'none'
    $e('place-row').style.display = id === 'place' ? 'flex' : 'none'
    $e('snap-row').style.display = id === 'place' || id === 'select' ? 'flex' : 'none'
    if (id !== 'select') deselect()
    if (id !== 'place') ghost?.setEnabled(false)
  }
  for (const [id, label] of TOOLS) {
    const b = document.createElement('button')
    b.textContent = label
    b.dataset['tool'] = id
    b.addEventListener('click', () => setTool(id))
    toolsEl.appendChild(b)
  }
  const placeSel = document.getElementById('place') as HTMLSelectElement
  PLACEABLES.forEach((p, i) => {
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = p.name
    placeSel.appendChild(o)
  })
  const texSel = document.getElementById('p-tex') as HTMLSelectElement
  for (const t of TEXTURES) {
    const o = document.createElement('option')
    o.value = t
    o.textContent = t === '' ? '(plain color)' : t
    texSel.appendChild(o)
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
  const pushUndo = (op: UndoOp): void => {
    undoStack.push(op)
    if (undoStack.length > 40) undoStack.shift()
    redoStack.length = 0
  }
  const findMesh = (body?: StaticBody, node?: MapNodeSpawn): Mesh | null => {
    if (body) for (const [m, b] of staticMeshes) if (b === body) return m
    if (node) for (const [m, n] of nodeMeshes) if (n === node) return m
    return null
  }
  const applyOp = (op: UndoOp, dir: 'undo' | 'redo'): void => {
    if (op.kind === 'terrain') {
      heights.set(dir === 'undo' ? op.before : op.after)
      refreshTerrainMesh()
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
    status.textContent = '↶ undo'
  }
  const redo = (): void => {
    const op = redoStack.pop()
    if (!op) return
    applyOp(op, 'redo')
    undoStack.push(op)
    status.textContent = '↷ redo'
  }

  // ── Sculpt core ─────────────────────────────────────────────────────
  const posBuf = terrain.getVerticesData(VertexBuffer.PositionKind) as Float32Array
  let shift = false
  let strokeBefore: Float32Array | null = null
  let paintBefore: ImageData | null = null

  function sculpt(px: number, pz: number, sign: number): void {
    const radius = Number($('radius').value)
    const strength = Number($('strength').value) * sign
    const feather = Number($('feather').value)
    const mode = tool
    let flatH = 0
    if (mode === 'flatten') {
      const ci = Math.round((px + HALF) / cell)
      const cj = Math.round((pz + HALF) / cell)
      flatH = heights[cj * (SUB + 1) + ci] ?? 0
    }
    const iMin = Math.max(0, Math.floor((px - radius + HALF) / cell))
    const iMax = Math.min(SUB, Math.ceil((px + radius + HALF) / cell))
    const jMin = Math.max(0, Math.floor((pz - radius + HALF) / cell))
    const jMax = Math.min(SUB, Math.ceil((pz + radius + HALF) / cell))
    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        const x = -HALF + i * cell
        const z = -HALF + j * cell
        const d = Math.hypot(x - px, z - pz)
        if (d > radius) continue
        // Feather: exponent on the cos² falloff — low = wide soft skirt
        // (paths, gentle mounds), high = tight hard-edged plateau.
        const fall = Math.cos((d / radius) * Math.PI * 0.5) ** (2 * feather)
        const v = j * (SUB + 1) + i
        const h = heights[v] ?? 0
        if (mode === 'sculpt') heights[v] = h + strength * fall * 0.35
        else if (mode === 'flatten') heights[v] = h + (flatH - h) * Math.min(1, fall * 0.6)
        else if (mode === 'smooth') {
          const n =
            ((heights[v - 1] ?? h) +
              (heights[v + 1] ?? h) +
              (heights[v - (SUB + 1)] ?? h) +
              (heights[v + (SUB + 1)] ?? h)) /
            4
          heights[v] = h + (n - h) * Math.min(1, fall * 0.8)
        }
        posBuf[vtx(i, j) * 3 + 1] = heights[v] ?? 0
      }
    }
    terrain.updateVerticesData(VertexBuffer.PositionKind, posBuf, true)
    const norms: number[] = []
    VertexData.ComputeNormals(posBuf, indices, norms)
    terrain.updateVerticesData(VertexBuffer.NormalKind, norms, true)
    wire.updateVerticesData(VertexBuffer.PositionKind, posBuf, true)
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
    const idx = Number(placeSel.value)
    const def = PLACEABLES[idx]
    if (!def) return null
    if (ghost && ghostFor === idx) return ghost
    ghost?.dispose()
    const shape =
      def.kind === 'static'
        ? def.shape!
        : (NODE_LOOKS[def.node!]?.shape ?? { type: 'sphere', radius: 0.6 })
    const color = def.kind === 'static' ? def.color! : (NODE_LOOKS[def.node!]?.color ?? '#888888')
    ghost = meshForShape(scene, 'ghost', shape, color)
    ghost.visibility = 0.5
    ghost.isPickable = false
    ghostFor = idx
    return ghost
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
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m !== ghost && m !== wire)
    if (!pick?.hit || !pick.pickedPoint) return null
    const def = PLACEABLES[Number(placeSel.value)]
    if (!def) return null
    const shape =
      def.kind === 'static'
        ? def.shape!
        : (NODE_LOOKS[def.node!]?.shape ?? { type: 'sphere', radius: 0.6 as number })
    const n = pick.getNormal(true) ?? new Vector3(0, 1, 0)
    // Align local +Y to the surface normal (walls, slopes), then apply the
    // wheel yaw around that normal. Nodes always sit upright.
    const rot =
      def.kind === 'node' || n.y > 0.95
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
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (tool !== 'place') return
      e.preventDefault()
      const step = shift ? Math.PI / 60 : Math.PI / 12
      placeYaw += (e.deltaY > 0 ? 1 : -1) * step
    },
    { passive: false },
  )

  function placeAt(pose: PlacePose): void {
    const def = PLACEABLES[Number(placeSel.value)]
    if (!def) return
    if (def.kind === 'node') {
      const ground = sampleH(pose.pos.x, pose.pos.z)
      const node: MapNodeSpawn = { node: def.node!, pos: [pose.pos.x, 0, pose.pos.z] }
      void ground
      placedNodes.push(node)
      renderNode(node)
      pushUndo({ kind: 'place', node })
      return
    }
    const e = pose.rot.toEulerAngles()
    const body: StaticBody = {
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
  const gizmos = new GizmoManager(scene)
  gizmos.positionGizmoEnabled = true
  gizmos.rotationGizmoEnabled = true
  gizmos.scaleGizmoEnabled = true
  gizmos.usePointerToAttachGizmos = false
  gizmos.attachToMesh(null)
  const props = $e('props')
  let selected: { mesh: Mesh; body: StaticBody; editBefore: StaticBody | null } | null = null

  const deselect = (): void => {
    gizmos.attachToMesh(null)
    props.style.display = 'none'
    selected = null
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
  }
  const select = (mesh: Mesh, body: StaticBody): void => {
    selected = { mesh, body, editBefore: null }
    gizmos.attachToMesh(mesh)
    props.style.display = 'flex'
    props.style.left = '274px'
    props.style.top = '12px'
    $e('props-title').textContent = `${body.shape.type} static`
    fillProps(body)
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
  // Gizmo drags write back into the body (and undo) on release.
  for (const g of [gizmos.gizmos.positionGizmo, gizmos.gizmos.rotationGizmo]) {
    g?.onDragStartObservable.add(beginEdit)
    g?.onDragEndObservable.add(() => {
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
  gizmos.gizmos.scaleGizmo?.onDragStartObservable.add(beginEdit)
  gizmos.gizmos.scaleGizmo?.onDragEndObservable.add(() => {
    if (!selected) return
    // Bake the gizmo scale into the shape dimensions, then rebuild clean.
    const m = selected.mesh
    const b = selected.body
    const s = m.scaling
    if (b.shape.type === 'box')
      b.shape.size = [b.shape.size[0] * s.x, b.shape.size[1] * s.y, b.shape.size[2] * s.z]
    else if (b.shape.type === 'cylinder') {
      b.shape.radius *= (s.x + s.z) / 2
      b.shape.height *= s.y
    } else b.shape.radius *= (s.x + s.y + s.z) / 3
    rebuildSelectedMesh(b, m)
    fillProps(b)
    commitEdit()
  })
  // Numeric property edits apply live.
  const propInput = (id: string, apply: (v: number, b: StaticBody) => void): void => {
    $(id).addEventListener('change', () => {
      if (!selected) return
      beginEdit()
      apply(Number($(id).value), selected.body)
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
      if (!selected) return
      beginEdit()
      setRot(selected.body)
      rebuildSelectedMesh(selected.body, selected.mesh)
      commitEdit()
    })
  propInput('d-x', (v, b) => b.shape.type === 'box' && (b.shape.size[0] = v))
  propInput('d-y', (v, b) => b.shape.type === 'box' && (b.shape.size[1] = v))
  propInput('d-z', (v, b) => b.shape.type === 'box' && (b.shape.size[2] = v))
  propInput('d-r', (v, b) => b.shape.type === 'cylinder' && (b.shape.radius = v))
  propInput('d-h', (v, b) => b.shape.type === 'cylinder' && (b.shape.height = v))
  propInput('d-sr', (v, b) => b.shape.type === 'sphere' && (b.shape.radius = v))
  $('p-color').addEventListener('change', () => {
    if (!selected) return
    beginEdit()
    selected.body.color = ($('p-color') as HTMLInputElement).value
    rebuildSelectedMesh(selected.body, selected.mesh)
    commitEdit()
  })
  texSel.addEventListener('change', () => {
    if (!selected) return
    beginEdit()
    if (texSel.value) selected.body.tex = texSel.value
    else delete selected.body.tex
    rebuildSelectedMesh(selected.body, selected.mesh)
    commitEdit()
  })
  const deleteSelected = (): void => {
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
    if (!selected) return
    const copy = snapshotBody(selected.body)
    copy.pos = [copy.pos[0] + 1, copy.pos[1], copy.pos[2] + 1]
    placedStatics.push(copy)
    const m = renderStatic(copy)
    pushUndo({ kind: 'place', body: copy })
    select(m, copy)
  })

  // ── Pointer handling ────────────────────────────────────────────────
  let painting = 0 // 0 none, 1 = LMB, 2 = RMB (lower)
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('pointerdown', (e) => {
    if (freeLook) return
    if (e.button !== 0 && e.button !== 2) return
    const sign = e.button === 2 ? -1 : 1
    if (tool === 'sculpt' || tool === 'smooth' || tool === 'flatten') {
      strokeBefore = heights.slice()
      painting = sign
      applySculpt(sign)
    } else if (tool === 'paint' && e.button === 0) {
      paintBefore = mixCtx.getImageData(0, 0, MIX, MIX)
      painting = 1
      applyPaint()
    } else if (tool === 'place' && e.button === 0) {
      const pose = computePlacePose()
      if (pose) placeAt(pose)
    } else if (tool === 'select' && e.button === 0) {
      const pick = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (m) => staticMeshes.has(m as Mesh) || nodeMeshes.has(m as Mesh),
      )
      const mesh = pick?.pickedMesh as Mesh | undefined
      if (mesh && staticMeshes.has(mesh)) select(mesh, staticMeshes.get(mesh)!)
      else if (mesh && nodeMeshes.has(mesh)) {
        // Nodes have no gizmo editing — delete/undo only for now.
        const node = nodeMeshes.get(mesh)!
        placedNodes = placedNodes.filter((n) => n !== node)
        nodeMeshes.delete(mesh)
        mesh.dispose()
        pushUndo({ kind: 'delete', node })
        status.textContent = 'node removed (undo with Ctrl+Z)'
      } else deselect()
    }
  })
  window.addEventListener('pointerup', () => {
    if (painting && strokeBefore) {
      pushUndo({ kind: 'terrain', before: strokeBefore, after: heights.slice() })
      strokeBefore = null
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
  function applySculpt(sign: number): void {
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === terrain)
    if (pick?.hit && pick.pickedPoint) sculpt(pick.pickedPoint.x, pick.pickedPoint.z, sign)
  }
  function applyPaint(): void {
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === terrain)
    if (pick?.hit && pick.pickedPoint) paint(pick.pickedPoint.x, pick.pickedPoint.z)
  }

  // ── Keyboard ────────────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if (
      (e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'SELECT'
    )
      return
    if (e.key === 'Shift') shift = true
    else if (e.key === 'z' || e.key === 'Z') {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else {
        // Z: toggle pointer-locked free-look.
        if (document.pointerLockElement === canvas) document.exitPointerLock()
        else void canvas.requestPointerLock()
      }
    } else if (e.key === '[' || e.key === ']') {
      const dir = e.key === ']' ? 1 : -1
      const target = e.shiftKey ? 'strength' : 'radius'
      const el = $(target)
      const step = e.shiftKey ? 0.05 : 1
      el.value = String(
        Math.max(Number(el.min), Math.min(Number(el.max), Number(el.value) + dir * step)),
      )
      el.dispatchEvent(new Event('input'))
      status.textContent = `${target}: ${el.value}`
    } else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
    else if (e.key === 'Escape') deselect()
  })
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') shift = false
  })

  // ── Brush cursor + wireframe + ghost per-frame ──────────────────────
  const brush = CreateSphere('brush', { diameter: 1, segments: 8 }, scene)
  const bm = new StandardMaterial('bm', scene)
  bm.emissiveColor = new Color3(0.4, 0.8, 1)
  bm.alpha = 0.3
  bm.disableLighting = true
  brush.material = bm
  brush.isPickable = false
  scene.onBeforeRenderObservable.add(() => {
    const sculpting =
      tool === 'sculpt' || tool === 'smooth' || tool === 'flatten' || tool === 'paint'
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === terrain)
    const overTerrain = Boolean(pick?.hit && pick.pickedPoint)
    if (sculpting && overTerrain && pick!.pickedPoint) {
      brush.position.copyFrom(pick!.pickedPoint)
      const r = Number($('radius').value)
      brush.scaling.set(r, r, r)
      brush.setEnabled(true)
    } else brush.setEnabled(false)
    wire.setEnabled(tool !== 'paint' && sculpting && overTerrain)
    if (tool === 'place') {
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
        // Our own save must not bounce back as a "remote" merge.
        lastSig = `${file.heights.length}:${file.statics.length}:${(file.nodes ?? []).length}:${(file.mix ?? '').length}`
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
      const sig = `${map.heights.length}:${map.statics.length}:${(map.nodes ?? []).length}:${(map.mix ?? '').length}`
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
      for (const st of placedStatics) renderStatic(st)
      for (const n of placedNodes) renderNode(n)
      status.textContent = '🔄 merged edits from another admin'
    } catch {
      /* offline poll */
    }
  }
  setInterval(() => void mergeRemote(), 6000)

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

  setTool('sculpt')
  engine.runRenderLoop(() => scene.render())
  window.addEventListener('resize', () => engine.resize())
}

void boot()
