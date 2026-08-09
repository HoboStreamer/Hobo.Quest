import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { materialFor } from '../sceneSetup.js'
import { createTaperedBox } from './taperedBox.js'

/**
 * Procedural third-person held-item props, attached to the avatar's right
 * hand. Deliberately chunky/readable at distance; the first-person
 * viewmodel is a separate, more detailed presentation.
 */
export type ToolPropKind = 'physgun' | 'axe' | 'pickaxe' | 'generic'

export interface ToolProp {
  root: TransformNode
  /** Beam origin for physgun-style tools. */
  muzzle: TransformNode
  dispose(): void
}

export function createToolProp(scene: Scene, kind: ToolPropKind, name: string): ToolProp {
  const root = new TransformNode(`${name}:tool`, scene)
  const meshes: Mesh[] = []
  const part = (
    n: string,
    opts: Parameters<typeof createTaperedBox>[1],
    color: string,
    pos: [number, number, number],
    rotX = 0,
  ): Mesh => {
    const m = createTaperedBox(`${name}:tool:${n}`, opts, scene)
    m.material = materialFor(scene, color)
    m.parent = root
    m.position.set(pos[0], pos[1], pos[2])
    m.rotation.x = rotX
    meshes.push(m)
    return m
  }

  const muzzle = new TransformNode(`${name}:muzzle`, scene)
  muzzle.parent = root

  if (kind === 'physgun') {
    part(
      'body',
      {
        topWidth: 0.07,
        topDepth: 0.3,
        bottomWidth: 0.08,
        bottomDepth: 0.26,
        height: 0.08,
        anchor: 'top',
      },
      '#2c3540',
      [0, 0.04, 0.1],
    )
    part(
      'grip',
      {
        topWidth: 0.045,
        topDepth: 0.07,
        bottomWidth: 0.04,
        bottomDepth: 0.06,
        height: 0.1,
        anchor: 'top',
        bottomShiftZ: -0.03,
      },
      '#1d242c',
      [0, -0.03, 0],
    )
    part(
      'coil',
      {
        topWidth: 0.05,
        topDepth: 0.05,
        bottomWidth: 0.06,
        bottomDepth: 0.06,
        height: 0.05,
        anchor: 'top',
      },
      '#58a4c4',
      [0, 0.03, 0.26],
    )
    muzzle.position.set(0, 0.01, 0.3)
  } else if (kind === 'axe' || kind === 'pickaxe') {
    part(
      'handle',
      {
        topWidth: 0.03,
        topDepth: 0.03,
        bottomWidth: 0.035,
        bottomDepth: 0.035,
        height: 0.5,
        anchor: 'top',
      },
      '#6d4c2a',
      [0, 0.25, 0],
    )
    if (kind === 'axe') {
      part(
        'head',
        {
          topWidth: 0.02,
          topDepth: 0.16,
          bottomWidth: 0.03,
          bottomDepth: 0.2,
          height: 0.09,
          anchor: 'top',
        },
        '#8a8d90',
        [0, 0.26, 0.06],
      )
    } else {
      part(
        'head',
        {
          topWidth: 0.025,
          topDepth: 0.34,
          bottomWidth: 0.035,
          bottomDepth: 0.28,
          height: 0.05,
          anchor: 'top',
        },
        '#8a8d90',
        [0, 0.25, 0],
      )
    }
    muzzle.position.set(0, 0.25, 0)
  } else {
    part(
      'box',
      {
        topWidth: 0.1,
        topDepth: 0.1,
        bottomWidth: 0.12,
        bottomDepth: 0.12,
        height: 0.12,
        anchor: 'top',
      },
      '#8a7a5a',
      [0, 0.02, 0.04],
    )
    muzzle.position.set(0, 0, 0.1)
  }

  return {
    root,
    muzzle,
    dispose(): void {
      for (const m of meshes) m.dispose()
      muzzle.dispose()
      root.dispose()
    },
  }
}

export function toolPropKindFor(
  itemDefId: string | undefined,
  toolKind: string | undefined,
): ToolPropKind | null {
  if (toolKind === 'physgun') return 'physgun'
  if (toolKind === 'axe') return 'axe'
  if (toolKind === 'pickaxe') return 'pickaxe'
  if (itemDefId) return 'generic'
  return null
}
