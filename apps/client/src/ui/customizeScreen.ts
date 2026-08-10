import type { Scene } from '@babylonjs/core/scene.js'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { PointLight } from '@babylonjs/core/Lights/pointLight.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { ContentRegistry } from '@hobo/content'
import {
  AppearanceSchema,
  FACIAL_HAIR,
  HAIR_STYLES,
  defaultAppearance,
  randomAppearance,
  type Appearance,
} from '@hobo/protocol'
import { Avatar } from '../render/avatar/avatar.js'
import { HAIR_COLORS, OUTFIT_COLORS, SKIN_TONES } from '../render/avatar/palettes.js'

/**
 * Pre-join character customization: a live 3D preview of the parametric
 * avatar in the world plaza with full appearance controls. Resolves with
 * the chosen name + appearance (persisted to localStorage).
 */
export function customizeScreen(
  scene: Scene,
  content: ContentRegistry,
  uiRoot: HTMLElement,
  savedName: string | null,
): Promise<{ name: string; appearance: Appearance; releaseCamera: () => void }> {
  return new Promise((resolve) => {
    let appearance = loadAppearance()

    // Preview stage: a floating platform in the clouds high above the city —
    // clean sky backdrop, nothing to clutter the silhouette.
    const STAGE = { x: 0, y: 60, z: 0 }
    const stageNodes: { dispose(): void }[] = []

    const platform = CreateCylinder(
      'cust-platform',
      { diameter: 4.6, height: 0.35, tessellation: 40 },
      scene,
    )
    platform.position.set(STAGE.x, STAGE.y - 0.175, STAGE.z)
    const platMat = new StandardMaterial('cust-platform-mat', scene)
    platMat.diffuseColor = Color3.FromHexString('#b8c4d4')
    platMat.emissiveColor = new Color3(0.1, 0.13, 0.18)
    platform.material = platMat
    stageNodes.push(platform, platMat)

    // Soft cloud puffs drifting around the platform.
    const clouds: { mesh: Mesh; phase: number; base: Vector3 }[] = []
    const cloudMat = new StandardMaterial('cust-cloud-mat', scene)
    cloudMat.diffuseColor = new Color3(1, 1, 1)
    cloudMat.emissiveColor = new Color3(0.55, 0.58, 0.64)
    cloudMat.alpha = 0.88
    stageNodes.push(cloudMat)
    const cloudSpots: [number, number, number, number][] = [
      [-2.6, -0.7, 1.4, 1.9],
      [2.8, -0.9, 0.6, 2.4],
      [-1.8, -0.4, -2.2, 1.5],
      [2.1, -0.5, -1.8, 1.7],
      [0.2, -1.1, 2.8, 2.1],
      [-3.2, 0.6, -0.8, 1.2],
    ]
    cloudSpots.forEach(([cx, cy, cz, s], i) => {
      const puff = CreateSphere(`cust-cloud-${i}`, { diameter: 1, segments: 8 }, scene)
      puff.material = cloudMat
      puff.scaling.set(s, s * 0.45, s * 0.8)
      const base = new Vector3(STAGE.x + cx, STAGE.y + cy, STAGE.z + cz)
      puff.position.copyFrom(base)
      clouds.push({ mesh: puff, phase: i * 1.7, base })
      stageNodes.push(puff)
    })

    // Warm key light so the character reads clearly against the sky.
    const keyLight = new PointLight(
      'cust-key',
      new Vector3(STAGE.x + 1.6, STAGE.y + 2.4, STAGE.z + 2.6),
      scene,
    )
    keyLight.diffuse = new Color3(1, 0.93, 0.82)
    keyLight.intensity = 0.85
    stageNodes.push(keyLight)

    const camera = new FreeCamera(
      'customize-cam',
      new Vector3(STAGE.x, STAGE.y + 1.2, STAGE.z + 3.1),
      scene,
    )
    camera.setTarget(new Vector3(STAGE.x, STAGE.y + 0.85, STAGE.z))
    scene.activeCamera = camera
    const avatar = new Avatar(scene, content, appearance, 'preview')
    // Face the camera; the player can drag left/right to turn the model.
    let previewYaw = 0
    let previewTime = 0
    let dragging = false
    const onDown = (e: PointerEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('.customize-panel')) return
      dragging = true
    }
    const onMove = (e: PointerEvent): void => {
      if (dragging) previewYaw += e.movementX * 0.012
    }
    const onUp = (): void => {
      dragging = false
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)

    const ticker = setInterval(() => {
      previewTime += 1 / 30
      // Clouds drift and bob slowly around the platform.
      for (const c of clouds) {
        c.mesh.position.x = c.base.x + Math.sin(previewTime * 0.16 + c.phase) * 0.5
        c.mesh.position.y = c.base.y + Math.sin(previewTime * 0.23 + c.phase * 2) * 0.14
        c.mesh.position.z = c.base.z + Math.cos(previewTime * 0.12 + c.phase) * 0.35
      }
      avatar.update({
        dt: 1 / 30,
        time: previewTime,
        // Feet exactly on the platform top (avatar y = feet height).
        x: STAGE.x,
        y: STAGE.y,
        z: STAGE.z,
        // Showcase idle: relaxed weight-shift sway + occasional look-around,
        // on top of the animator's breathing. Empty hands read cleaner.
        yaw: previewYaw + Math.sin(previewTime * 0.35) * 0.08,
        pitch: Math.sin(previewTime * 0.4) * 0.06 + Math.sin(previewTime * 0.13) * 0.05,
        speed: 0,
        grounded: true,
        itemDef: undefined,
      })
    }, 1000 / 30)

    const overlay = document.createElement('div')
    overlay.className = 'customize-overlay'
    overlay.innerHTML = `
      <div class="customize-panel">
        <h1>HOBO.QUEST</h1>
        <input id="cname" maxlength="24" placeholder="drifter name" value="${savedName ?? ''}" />
        <div class="cust-row" id="row-body"></div>
        <div class="cust-label">Skin</div><div class="cust-row" id="row-skin"></div>
        <div class="cust-label">Hair · <span id="hair-name"></span></div>
        <div class="cust-row" id="row-hairstyle"></div>
        <div class="cust-row" id="row-haircolor"></div>
        <div class="cust-label" id="fh-label">Facial hair · <span id="fh-name"></span></div>
        <div class="cust-row" id="row-fh"></div>
        <div class="cust-label">Top</div><div class="cust-row" id="row-top"></div>
        <div class="cust-label">Bottom</div><div class="cust-row" id="row-bottom"></div>
        <div class="cust-label">Shoes</div><div class="cust-row" id="row-shoes"></div>
        <div class="cust-actions">
          <button id="btn-random">🎲 Randomize</button>
          <button id="btn-join" class="primary">Enter the Yard</button>
        </div>
      </div>
    `
    uiRoot.appendChild(overlay)
    const $ = (id: string) => overlay.querySelector(`#${id}`) as HTMLElement

    const apply = (next: Partial<Appearance>): void => {
      appearance = { ...appearance, ...next, height: 1, build: 1 }
      if (appearance.body === 'female') appearance.facialHair = 'none'
      avatar.setAppearance(appearance)
      renderControls()
    }

    const swatchRow = (
      el: HTMLElement,
      colors: readonly string[],
      selected: number,
      onPick: (i: number) => void,
    ): void => {
      el.replaceChildren()
      colors.forEach((color, i) => {
        const b = document.createElement('button')
        b.className = i === selected ? 'swatch selected' : 'swatch'
        b.style.background = color
        b.addEventListener('click', () => onPick(i))
        el.appendChild(b)
      })
    }

    const renderControls = (): void => {
      const bodyRow = $('row-body')
      bodyRow.replaceChildren()
      for (const body of ['male', 'female'] as const) {
        const b = document.createElement('button')
        b.className = appearance.body === body ? 'cust-btn selected' : 'cust-btn'
        b.textContent = body === 'male' ? 'Male' : 'Female'
        b.addEventListener('click', () => apply({ body }))
        bodyRow.appendChild(b)
      }
      swatchRow($('row-skin'), SKIN_TONES, appearance.skin, (i) => apply({ skin: i }))
      swatchRow($('row-haircolor'), HAIR_COLORS, appearance.hairColor, (i) =>
        apply({ hairColor: i }),
      )
      swatchRow($('row-top'), OUTFIT_COLORS, appearance.top, (i) => apply({ top: i }))
      swatchRow($('row-bottom'), OUTFIT_COLORS, appearance.bottom, (i) => apply({ bottom: i }))
      swatchRow($('row-shoes'), OUTFIT_COLORS, appearance.shoes, (i) => apply({ shoes: i }))

      $('hair-name').textContent = appearance.hairStyle
      const hairRow = $('row-hairstyle')
      hairRow.replaceChildren()
      for (const [label, dir] of [
        ['◀', -1],
        ['▶', 1],
      ] as const) {
        const b = document.createElement('button')
        b.className = 'cust-btn'
        b.textContent = label
        b.addEventListener('click', () => {
          const i = HAIR_STYLES.indexOf(appearance.hairStyle)
          const next = HAIR_STYLES[(i + dir + HAIR_STYLES.length) % HAIR_STYLES.length] ?? 'short'
          apply({ hairStyle: next })
        })
        hairRow.appendChild(b)
      }

      const fhVisible = appearance.body === 'male'
      $('fh-label').style.display = fhVisible ? 'block' : 'none'
      const fhRow = $('row-fh')
      fhRow.style.display = fhVisible ? 'flex' : 'none'
      $('fh-name').textContent = appearance.facialHair
      fhRow.replaceChildren()
      for (const fh of FACIAL_HAIR) {
        const b = document.createElement('button')
        b.className = appearance.facialHair === fh ? 'cust-btn selected' : 'cust-btn'
        b.textContent = fh
        b.addEventListener('click', () => apply({ facialHair: fh }))
        fhRow.appendChild(b)
      }
    }
    renderControls()

    // Body size is locked for combat fairness — every drifter shares one hull.
    $('btn-random').addEventListener('click', () =>
      apply({ ...randomAppearance(Math.random), height: 1, build: 1 }),
    )

    const join = (): void => {
      const name = ($('cname') as HTMLInputElement).value.trim() || 'Drifter'
      localStorage.setItem('hobo.appearance', JSON.stringify(appearance))
      clearInterval(ticker)
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      avatar.dispose()
      for (const node of stageNodes) node.dispose()
      overlay.remove()
      // The preview camera stays alive until the gameplay camera takes over —
      // the render loop must never see a camera-less scene.
      resolve({ name, appearance, releaseCamera: () => camera.dispose() })
    }
    $('btn-join').addEventListener('click', join)
    $('cname').addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') join()
    })
  })
}

function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem('hobo.appearance')
    if (raw) {
      const parsed = AppearanceSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return { ...parsed.data, height: 1, build: 1 }
    }
  } catch {
    // fall through to default
  }
  return defaultAppearance()
}
