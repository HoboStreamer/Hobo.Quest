import type { Scene } from '@babylonjs/core/scene.js'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
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

    // Preview stage: avatar on the plaza, camera facing it.
    const previewPos = { x: 2.5, z: 6.5 }
    const camera = new FreeCamera(
      'customize-cam',
      new Vector3(previewPos.x, 1.2, previewPos.z + 3.1),
      scene,
    )
    camera.setTarget(new Vector3(previewPos.x, 0.85, previewPos.z))
    scene.activeCamera = camera
    const avatar = new Avatar(scene, content, appearance, 'preview')
    let previewYaw = Math.PI
    let previewTime = 0

    const ticker = setInterval(() => {
      previewTime += 1 / 30
      previewYaw += 0.008
      avatar.update({
        dt: 1 / 30,
        time: previewTime,
        x: previewPos.x,
        y: 0.02,
        z: previewPos.z,
        yaw: previewYaw,
        pitch: 0,
        speed: 0,
        grounded: true,
        itemDef: 'physgun',
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
        <div class="cust-sliders">
          <label>Height <input id="s-height" type="range" min="0.92" max="1.08" step="0.01" /></label>
          <label>Build <input id="s-build" type="range" min="0.85" max="1.15" step="0.01" /></label>
        </div>
        <div class="cust-actions">
          <button id="btn-random">🎲 Randomize</button>
          <button id="btn-join" class="primary">Enter the Yard</button>
        </div>
      </div>
    `
    uiRoot.appendChild(overlay)
    const $ = (id: string) => overlay.querySelector(`#${id}`) as HTMLElement

    const apply = (next: Partial<Appearance>): void => {
      appearance = { ...appearance, ...next }
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
      ;($('s-height') as HTMLInputElement).value = String(appearance.height)
      ;($('s-build') as HTMLInputElement).value = String(appearance.build)
    }
    renderControls()

    $('s-height').addEventListener('input', (e) =>
      apply({ height: Number((e.target as HTMLInputElement).value) }),
    )
    $('s-build').addEventListener('input', (e) =>
      apply({ build: Number((e.target as HTMLInputElement).value) }),
    )
    $('btn-random').addEventListener('click', () => apply(randomAppearance(Math.random)))

    const join = (): void => {
      const name = ($('cname') as HTMLInputElement).value.trim() || 'Drifter'
      localStorage.setItem('hobo.appearance', JSON.stringify(appearance))
      clearInterval(ticker)
      avatar.dispose()
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
      if (parsed.success) return parsed.data
    }
  } catch {
    // fall through to default
  }
  return defaultAppearance()
}
