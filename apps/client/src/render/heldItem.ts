import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
import { createToolProp, type ToolProp } from './avatar/toolProps.js'
import { meshForShape } from './sceneSetup.js'

/**
 * The one way ANY item becomes a visible in-hand model: tools use their
 * authored prop, everything else shows its actual world model (the same
 * shape/color it has when dropped) normalized to hand size. Third-person
 * hands and the first-person viewmodel both build from this, so an item
 * always looks like itself everywhere.
 */
export interface HeldItemNode {
  root: TransformNode
  /** Beam origin for physgun-style tools (null for ordinary items). */
  muzzle: TransformNode | null
  dispose(): void
}

const HAND_SIZE = 0.34

export function createHeldItemNode(
  scene: Scene,
  content: ContentRegistry,
  defId: string,
  name: string,
): HeldItemNode | null {
  const def = content.item(defId)
  if (!def) return null

  if (def.tool) {
    const kind = toolVisualKind(def.tool.kind)
    const prop: ToolProp = createToolProp(scene, kind, name)
    return { root: prop.root, muzzle: prop.muzzle, dispose: () => prop.dispose() }
  }

  const rep = content.worldRepOf(defId)
  const shape = rep.shape
  const maxDim =
    shape.type === 'box'
      ? Math.max(shape.size[0], shape.size[1], shape.size[2])
      : shape.type === 'cylinder'
        ? Math.max(shape.radius * 2, shape.height)
        : shape.radius * 2
  const root = new TransformNode(`${name}:held`, scene)
  const mesh = meshForShape(scene, `${name}:heldmesh`, shape, rep.color)
  mesh.parent = root
  const scale = HAND_SIZE / Math.max(maxDim, 0.01)
  mesh.scaling.setAll(Math.min(scale, 1))
  return {
    root,
    muzzle: null,
    dispose: () => {
      mesh.dispose()
      root.dispose()
    },
  }
}

function toolVisualKind(kind: string): 'physgun' | 'axe' | 'pickaxe' | 'generic' {
  if (kind === 'physgun' || kind === 'axe' || kind === 'pickaxe') return kind
  return 'generic'
}
