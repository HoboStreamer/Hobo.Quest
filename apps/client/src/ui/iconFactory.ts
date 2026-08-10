import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Node } from '@babylonjs/core/node.js'
import { CreateScreenshotUsingRenderTargetAsync } from '@babylonjs/core/Misc/screenshotTools.js'
import { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
import { createToolProp } from '../render/avatar/toolProps.js'
import { meshForShape } from '../render/sceneSetup.js'

/**
 * Generates inventory icons by RENDERING each item's actual 3D model —
 * icons always match what the item looks like in the world, with zero
 * hand-authored art.
 *
 * Icons render in a dedicated pocket SCENE on the main engine: the game
 * scene's atmosphere/HDR pipeline must never touch icon captures (it
 * washed them out to pure white), and a second engine proved flaky
 * headless. Generation is async and serialized; `onReady` fires so the
 * HUD can swap real icons in as they finish.
 */

const STAGE = new Vector3(0, 0, 0)
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

export class IconFactory {
  onReady: (() => void) | null = null
  private readonly cache = new Map<string, string>()
  private readonly queued = new Set<string>()
  private chain: Promise<void> = Promise.resolve()
  private readonly iconScene: Scene

  constructor(
    scene: Scene,
    private readonly content: ContentRegistry,
  ) {
    this.iconScene = new Scene(scene.getEngine())
    this.iconScene.clearColor = new Color4(0, 0, 0, 0)
    this.iconScene.autoClear = true
    const hemi = new HemisphericLight('icon-hemi', new Vector3(0.3, 1, 0.2), this.iconScene)
    hemi.intensity = 0.9
    hemi.groundColor = new Color3(0.35, 0.33, 0.3)
    const key = new DirectionalLight('icon-key', new Vector3(-0.5, -1, -0.4), this.iconScene)
    key.intensity = 0.7
  }

  iconFor(defId: string): string {
    const cached = this.cache.get(defId)
    if (cached) return cached
    if (!this.queued.has(defId)) {
      this.queued.add(defId)
      this.chain = this.chain
        .then(() => this.generate(defId))
        .catch((err: unknown) => console.warn(`icon generation failed for ${defId}`, err))
    }
    return PLACEHOLDER
  }

  private async generate(defId: string): Promise<void> {
    const def = this.content.item(defId)
    let root: Node
    let radius: number
    if (def?.tool) {
      const prop = createToolProp(this.iconScene, toolVisualKind(def.tool.kind), `icon:${defId}`)
      root = prop.root
      prop.root.position.copyFrom(STAGE)
      radius = def.tool.kind === 'physgun' ? 0.23 : 0.3
      if (def.tool.kind !== 'physgun') prop.root.position.y -= 0.22
    } else {
      const rep = this.content.worldRepOf(defId)
      const mesh = meshForShape(this.iconScene, `icon:${defId}`, rep.shape, rep.color)
      mesh.position.copyFrom(STAGE)
      root = mesh
      const shape = rep.shape
      radius =
        shape.type === 'box'
          ? Math.max(shape.size[0], shape.size[1], shape.size[2]) * 0.72
          : shape.type === 'cylinder'
            ? Math.max(shape.radius * 1.6, shape.height * 0.72)
            : shape.radius * 1.5
    }

    // Three-quarter view, looking slightly down. The icon scene contains
    // ONLY this model, so the transparent clear shows through around it.
    const dist = radius * 1.9
    const focus = new Vector3(STAGE.x, STAGE.y + radius * 0.1, STAGE.z + (def?.tool ? 0.12 : 0))
    const camera = new FreeCamera(
      `icon-cam:${defId}`,
      new Vector3(focus.x + dist * 0.72, focus.y + dist * 0.55, focus.z + dist * 0.72),
      this.iconScene,
    )
    camera.minZ = 0.01
    camera.setTarget(focus)
    this.iconScene.activeCamera = camera

    try {
      const url = await CreateScreenshotUsingRenderTargetAsync(this.iconScene.getEngine(), camera, {
        width: 128,
        height: 128,
      })
      if (url && url.length > 200) this.cache.set(defId, url)
    } finally {
      camera.dispose()
      root.dispose()
    }
    this.onReady?.()
  }
}

function toolVisualKind(kind: string): 'physgun' | 'axe' | 'pickaxe' | 'generic' {
  if (kind === 'physgun' || kind === 'axe' || kind === 'pickaxe') return kind
  return 'generic'
}
