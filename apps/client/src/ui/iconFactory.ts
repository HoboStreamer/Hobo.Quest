import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { Color4 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Node } from '@babylonjs/core/node.js'
import { CreateScreenshotUsingRenderTargetAsync } from '@babylonjs/core/Misc/screenshotTools.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
import { createToolProp } from '../render/avatar/toolProps.js'
import { meshForShape } from '../render/sceneSetup.js'

/**
 * Generates inventory icons by RENDERING each item's actual 3D model —
 * icons always match what the item looks like in the world, with zero
 * hand-authored art.
 *
 * Models are staged in a pocket far below the world and captured with a
 * render-target screenshot on the MAIN engine (a second engine/context
 * proved flaky); generation is async and serialized, and `onReady` fires
 * so the HUD can swap real icons in as they finish.
 */

const STAGE = new Vector3(0, -80, 0)
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

export class IconFactory {
  onReady: (() => void) | null = null
  private readonly cache = new Map<string, string>()
  private readonly queued = new Set<string>()
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly scene: Scene,
    private readonly content: ContentRegistry,
  ) {}

  iconFor(defId: string): string {
    const cached = this.cache.get(defId)
    if (cached) return cached
    if (!this.queued.has(defId)) {
      this.queued.add(defId)
      this.chain = this.chain.then(() => this.generate(defId)).catch(() => undefined)
    }
    return PLACEHOLDER
  }

  private async generate(defId: string): Promise<void> {
    const def = this.content.item(defId)
    let root: Node
    let radius: number
    if (def?.tool) {
      const prop = createToolProp(this.scene, toolVisualKind(def.tool.kind), `icon:${defId}`)
      root = prop.root
      prop.root.position.copyFrom(STAGE)
      radius = def.tool.kind === 'physgun' ? 0.3 : 0.38
      if (def.tool.kind !== 'physgun') prop.root.position.y -= 0.22
    } else {
      const rep = this.content.worldRepOf(defId)
      const mesh = meshForShape(this.scene, `icon:${defId}`, rep.shape, rep.color)
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

    // Three-quarter view, looking slightly down so no world geometry can
    // appear behind the model (nothing exists below the stage).
    const dist = radius * 2.2
    const focus = new Vector3(STAGE.x, STAGE.y + radius * 0.1, STAGE.z + (def?.tool ? 0.12 : 0))
    const camera = new FreeCamera(
      `icon-cam:${defId}`,
      new Vector3(focus.x + dist * 0.72, focus.y + dist * 0.55, focus.z + dist * 0.72),
      this.scene,
    )
    camera.minZ = 0.01
    camera.setTarget(focus)

    const prevClear = this.scene.clearColor.clone()
    this.scene.clearColor = new Color4(0, 0, 0, 0)
    try {
      const url = await CreateScreenshotUsingRenderTargetAsync(this.scene.getEngine(), camera, {
        width: 128,
        height: 128,
      })
      if (url && url.length > 200) this.cache.set(defId, url)
    } finally {
      this.scene.clearColor = prevClear
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
