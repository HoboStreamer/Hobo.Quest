import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry, WorldShape } from '@hobo/content'
import { createToolProp, type ToolProp } from './avatar/toolProps.js'
import { meshForShape } from './sceneSetup.js'

/**
 * The one way ANY item becomes a visible in-hand model: tools use their
 * authored prop; everything else shows its actual world model (the same
 * shape/color it has when dropped), auto-fitted to the hand:
 *
 *  - uniformly scaled so its LONGEST dimension hits the requested grip
 *    size (viewmodel and third-person pass different sizes),
 *  - reoriented so elongated shapes lie across the palm (a log stands
 *    upright in the world but is carried horizontally),
 *  - grip-centered so the mesh pivots around where the hand holds it.
 *
 * Third-person hands and the first-person viewmodel both build from this,
 * so an item always looks like itself everywhere.
 */
export interface HeldItemNode {
  root: TransformNode
  /** Beam origin for physgun-style tools (null for ordinary items). */
  muzzle: TransformNode | null
  dispose(): void
}

/** Default grip size (third-person avatars). */
export const HAND_SIZE = 0.34

export function createHeldItemNode(
  scene: Scene,
  content: ContentRegistry,
  defId: string,
  name: string,
  gripSize = HAND_SIZE,
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
  const dims = shapeDims(shape)
  const maxDim = Math.max(dims[0], dims[1], dims[2], 0.01)
  const root = new TransformNode(`${name}:held`, scene)
  const mesh = meshForShape(scene, `${name}:heldmesh`, shape, rep.color)
  mesh.parent = root
  const scale = Math.min(gripSize / maxDim, 1)
  mesh.scaling.setAll(scale)

  // Elongated shapes carry HORIZONTALLY across the palm: a cylinder whose
  // height dominates (log, plank on edge) tips onto its side; tall boxes
  // likewise. Squat shapes stay upright.
  if (shape.type === 'cylinder' && shape.height > shape.radius * 2.2) {
    mesh.rotation.z = Math.PI / 2
    mesh.rotation.y = 0.35
  } else if (shape.type === 'box' && dims[1] > Math.max(dims[0], dims[2]) * 1.6) {
    mesh.rotation.z = Math.PI / 2
  }

  return {
    root,
    muzzle: null,
    dispose: () => {
      mesh.dispose()
      root.dispose()
    },
  }
}

function shapeDims(shape: WorldShape): [number, number, number] {
  switch (shape.type) {
    case 'box':
      return shape.size
    case 'cylinder':
      return [shape.radius * 2, shape.height, shape.radius * 2]
    case 'sphere':
      return [shape.radius * 2, shape.radius * 2, shape.radius * 2]
  }
}

function toolVisualKind(kind: string): 'physgun' | 'axe' | 'pickaxe' | 'generic' {
  if (kind === 'physgun' || kind === 'axe' || kind === 'pickaxe') return kind
  return 'generic'
}
