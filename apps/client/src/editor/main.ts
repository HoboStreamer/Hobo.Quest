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
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js'
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
  type StaticBody,
} from '@hobo/content'
import { meshForShape } from '../render/sceneSetup.js'

/**
 * Hobo.Quest map editor (/editor.html): sculpt the island's heightfield,
 * paint the texture splat, and place statics — then save the MapFile
 * artifact the game loads on both server and client. Admin-gated: saves
 * require a hobo.tools admin token (or the EDITOR_KEY fallback secret).
 *
 * Modular by design: every tool mutates the same MapFile-shaped state, so
 * future tools (glTF model import, path splines, prefab stamps) plug in as
 * new mutators without touching the format or the game loader.
 */

const content = createContent()
const world = content.world
const HALF = world.groundHalfExtent
const SUB = 128
const MIX = 512

type Tool = 'raise' | 'smooth' | 'flatten' | 'paint' | 'place' | 'delete'

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const engine = new Engine(canvas, true)
  const scene = new Scene(engine)
  scene.clearColor = new Color4(0.45, 0.58, 0.72, 1)
  new HemisphericLight('hemi', new Vector3(0.2, 1, 0.1), scene).intensity = 0.85
  new DirectionalLight('sun', new Vector3(-0.4, -1, -0.3), scene).intensity = 0.6

  const camera = new FreeCamera('cam', new Vector3(0, 45, -55), scene)
  camera.setTarget(new Vector3(0, 0, 0))
  camera.minZ = 0.1
  camera.speed = 1.6
  camera.attachControl(canvas, true)
  // Look with RMB drag only, leaving LMB free for tools.
  const mouseInput = camera.inputs.attached['mouse'] as unknown as { buttons?: number[] }
  if (mouseInput) mouseInput.buttons = [2]
  camera.keysUp = [87]
  camera.keysDown = [83]
  camera.keysLeft = [65]
  camera.keysRight = [68]

  // ── Load current map (or start from the procedural island) ──────────
  let heights: Float32Array
  let placedStatics: StaticBody[] = []
  let savedMix: string | undefined
  try {
    const map = (await (await fetch('/map.json')).json()) as MapFile | null
    if (map && map.v === 1 && map.sub === SUB) {
      heights = decodeHeights(map.heights)
      placedStatics = map.statics
      savedMix = map.mix
    } else {
      heights = defaultHeights(world, SUB)
    }
  } catch {
    heights = defaultHeights(world, SUB)
  }

  // ── Terrain mesh: the game-proven grid builder (correct winding), fed
  // by the current heights via the map override, then kept in sync as we
  // sculpt. Grid row 0 sits at +z; heights are row-major from -z — the
  // vertex index for heights[j][i] is (SUB - j) * (SUB+1) + i.
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

  // ── Splat paint layer ───────────────────────────────────────────────
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

  // ── World + placed statics preview ──────────────────────────────────
  const staticMeshes = new Map<Mesh, StaticBody | null>()
  const renderStatic = (s: StaticBody, editable: boolean): void => {
    const mesh = meshForShape(scene, `s:${Math.random()}`, s.shape, s.color)
    mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
    mesh.rotationQuaternion = null
    mesh.rotation.y = s.yaw
    staticMeshes.set(mesh, editable ? s : null)
  }
  for (const s of world.statics) renderStatic(s, false)
  for (const s of placedStatics) renderStatic(s, true)

  // ── UI state ────────────────────────────────────────────────────────
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement
  let tool: Tool = 'raise'
  const toolsEl = document.getElementById('tools') as HTMLElement
  const TOOLS: [Tool, string][] = [
    ['raise', '⛰ Raise'],
    ['smooth', '〰 Smooth'],
    ['flatten', '▭ Flatten'],
    ['paint', '🖌 Paint'],
    ['place', '📦 Place'],
    ['delete', '✖ Delete'],
  ]
  for (const [id, label] of TOOLS) {
    const b = document.createElement('button')
    b.textContent = label
    b.dataset['tool'] = id
    if (id === tool) b.classList.add('active')
    b.addEventListener('click', () => {
      tool = id
      toolsEl.querySelectorAll('button').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
    })
    toolsEl.appendChild(b)
  }
  const placeSel = document.getElementById('place') as HTMLSelectElement
  const PLACEABLES: [string, StaticBody['shape'], string, string?][] = [
    ['Stone block', { type: 'box', size: [2, 2, 2] }, '#8a8d90', 'gray_rocks'],
    ['Wall 4m', { type: 'box', size: [4, 3, 0.4] }, '#9a9187', 'plastered_wall_02'],
    ['Brick block', { type: 'box', size: [3, 3, 3] }, '#8d5f4d', 'red_brick'],
    ['Wood platform', { type: 'box', size: [4, 0.4, 4] }, '#8a6a42', 'wood_planks'],
    ['Pillar', { type: 'cylinder', radius: 0.5, height: 4 }, '#8f8a82'],
    ['Boulder', { type: 'sphere', radius: 1.4 }, '#7b7f83'],
    ['Street lamp', { type: 'box', size: [0.16, 3.4, 0.16] }, '#3a3f45'],
  ]
  PLACEABLES.forEach(([name], i) => {
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = name
    placeSel.appendChild(o)
  })
  const status = document.getElementById('status') as HTMLElement
  $('key').value = localStorage.getItem('hobo.editorkey') ?? ''

  // ── Sculpt/paint core ───────────────────────────────────────────────
  const posBuf = terrain.getVerticesData(VertexBuffer.PositionKind) as Float32Array
  let ctrl = false
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control') ctrl = true
  })
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') ctrl = false
  })

  function sculpt(px: number, pz: number): void {
    const radius = Number($('radius').value)
    const strength = Number($('strength').value) * (ctrl ? -1 : 1)
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
        const fall = Math.cos((d / radius) * Math.PI * 0.5) ** 2
        const v = j * (SUB + 1) + i
        const h = heights[v] ?? 0
        if (mode === 'raise') heights[v] = h + strength * fall * 0.35
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
  }

  function paint(px: number, pz: number): void {
    const radius = Number($('radius').value)
    const u = ((px + HALF) / (HALF * 2)) * MIX
    const vpix = (1 - (pz + HALF) / (HALF * 2)) * MIX
    mixCtx.beginPath()
    mixCtx.arc(u, MIX - (MIX - vpix), (radius / (HALF * 2)) * MIX, 0, Math.PI * 2)
    mixCtx.fillStyle = ($('paint') as unknown as HTMLSelectElement).value
    mixCtx.fill()
    mixTex.update()
  }

  function place(px: number, py: number, pz: number): void {
    const def = PLACEABLES[Number(placeSel.value)]
    if (!def) return
    const [, shape, color, tex] = def
    const h =
      shape.type === 'box'
        ? shape.size[1]
        : shape.type === 'cylinder'
          ? shape.height
          : shape.radius * 2
    const body: StaticBody = {
      shape,
      pos: [Math.round(px * 4) / 4, Math.round((py + h / 2) * 4) / 4, Math.round(pz * 4) / 4],
      yaw: 0,
      color,
      ...(tex ? { tex } : {}),
      ...(def[0] === 'Street lamp' ? { decor: 'lamp' } : {}),
    }
    placedStatics.push(body)
    renderStatic(body, true)
  }

  // ── Pointer handling ────────────────────────────────────────────────
  let painting = false
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    painting = true
    apply()
  })
  canvas.addEventListener('pointerup', () => (painting = false))
  canvas.addEventListener('pointermove', () => {
    if (
      painting &&
      (tool === 'raise' || tool === 'smooth' || tool === 'flatten' || tool === 'paint')
    )
      apply()
  })
  function apply(): void {
    const pick = scene.pick(scene.pointerX, scene.pointerY)
    if (!pick?.hit || !pick.pickedPoint) return
    const p = pick.pickedPoint
    if (tool === 'paint') paint(p.x, p.z)
    else if (tool === 'place') {
      if (pick.pickedMesh === terrain) place(p.x, p.y, p.z)
    } else if (tool === 'delete') {
      const mesh = pick.pickedMesh as Mesh
      const body = staticMeshes.get(mesh)
      if (body) {
        placedStatics = placedStatics.filter((s) => s !== body)
        staticMeshes.delete(mesh)
        mesh.dispose()
      }
    } else sculpt(p.x, p.z)
  }

  // Brush cursor
  const brush = CreateSphere('brush', { diameter: 1, segments: 8 }, scene)
  const bm = new StandardMaterial('bm', scene)
  bm.emissiveColor = new Color3(0.4, 0.8, 1)
  bm.alpha = 0.3
  bm.disableLighting = true
  brush.material = bm
  brush.isPickable = false
  scene.onBeforeRenderObservable.add(() => {
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === terrain)
    if (pick?.hit && pick.pickedPoint) {
      brush.position.copyFrom(pick.pickedPoint)
      const r = Number($('radius').value)
      brush.scaling.set(r, r, r)
      brush.setEnabled(tool !== 'delete')
    } else brush.setEnabled(false)
  })

  // ── Save ────────────────────────────────────────────────────────────
  document.getElementById('save')?.addEventListener('click', () => {
    void (async () => {
      const key = $('key').value.trim()
      localStorage.setItem('hobo.editorkey', key)
      const file: MapFile = {
        v: 1,
        halfExtent: HALF,
        sub: SUB,
        heights: encodeHeights(heights),
        mix: (mixCtx.canvas as HTMLCanvasElement).toDataURL('image/png'),
        statics: placedStatics,
      }
      status.textContent = 'saving…'
      const resp = await fetch('/api/map', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-editor-key': key },
        body: JSON.stringify(file),
      })
      status.textContent = resp.ok
        ? '✅ saved — restart the game server to apply physics'
        : resp.status === 403
          ? '⛔ not authorized (admin token/key required)'
          : `save failed (${resp.status})`
    })()
  })

  // ── Collaboration: poll for saves from OTHER admins and fold them in
  // (heights + paint refresh when we're not mid-stroke). Last save wins.
  let lastSaved = JSON.stringify({ h: encodeHeights(heights).length, s: placedStatics.length })
  setInterval(() => {
    if (painting) return
    void (async () => {
      try {
        const map = (await (await fetch('/map.json')).json()) as MapFile | null
        if (!map || map.v !== 1 || map.sub !== SUB) return
        const sig = JSON.stringify({ h: map.heights.length, s: map.statics.length })
        if (sig === lastSaved) return
        lastSaved = sig
        const remote = decodeHeights(map.heights)
        heights.set(remote)
        for (let j = 0; j <= SUB; j++) {
          for (let i = 0; i <= SUB; i++) {
            posBuf[vtx(i, j) * 3 + 1] = heights[j * (SUB + 1) + i] ?? 0
          }
        }
        terrain.updateVerticesData(VertexBuffer.PositionKind, posBuf, true)
        const nn: number[] = []
        VertexData.ComputeNormals(posBuf, indices, nn)
        terrain.updateVerticesData(VertexBuffer.NormalKind, nn, true)
        if (map.mix) {
          const img = new Image()
          img.onload = () => {
            mixCtx.drawImage(img, 0, 0, MIX, MIX)
            mixTex.update()
          }
          img.src = map.mix
        }
        for (const [mesh, body] of staticMeshes) {
          if (body) {
            staticMeshes.delete(mesh)
            mesh.dispose()
          }
        }
        placedStatics = map.statics
        for (const st of placedStatics) renderStatic(st, true)
        status.textContent = '🔄 merged edits from another admin'
      } catch {
        // offline poll — ignore
      }
    })()
  }, 4000)

  engine.runRenderLoop(() => scene.render())
  window.addEventListener('resize', () => engine.resize())
  void Quaternion
}

void boot()
