import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Appearance } from '@hobo/protocol'
import { materialFor } from '../sceneSetup.js'
import { hairColor, outfitColor, skinTone } from './palettes.js'
import { createTaperedBox } from './taperedBox.js'

/**
 * Parametric low-poly humanoid rig.
 *
 * A joint hierarchy of TransformNodes with flat-shaded tapered-box segments
 * parented to them — no skinning, in the spirit of the reference models but
 * fully data-driven: every proportion derives from Appearance (body type,
 * height, build) so customization needs no new assets. The animator poses
 * joints; rendering never touches physics or networking.
 *
 * Conventions: root origin at the FEET (ground). +Z faces forward (matches
 * player yaw). Limb joints rotate at the top of their segment.
 */

export interface RigJoints {
  root: TransformNode
  /** Vertical bob/lean node between root and pelvis. */
  bob: TransformNode
  spine: TransformNode
  chest: TransformNode
  neck: TransformNode
  head: TransformNode
  shoulderL: TransformNode
  shoulderR: TransformNode
  elbowL: TransformNode
  elbowR: TransformNode
  hipL: TransformNode
  hipR: TransformNode
  kneeL: TransformNode
  kneeR: TransformNode
  /** Attachment for held tools (right hand). */
  handR: TransformNode
}

export interface AvatarRig {
  joints: RigJoints
  /** Eye height above the root (for sanity checks / camera alignment). */
  eyeHeight: number
  setHeadVisible(visible: boolean): void
  dispose(): void
}

interface Dims {
  legLen: number
  thighLen: number
  shinLen: number
  pelvisH: number
  torsoH: number
  chestH: number
  neckH: number
  headH: number
  headW: number
  shoulderHalf: number
  hipHalf: number
  armUpperLen: number
  armForeLen: number
  handLen: number
  thighW: number
  shinW: number
  armW: number
  chestWTop: number
  chestWBot: number
  pelvisW: number
}

function dimensionsFor(a: Appearance): Dims {
  const h = a.height
  const b = a.build
  const female = a.body === 'female'
  return {
    legLen: 0.84 * h,
    thighLen: 0.43 * h,
    shinLen: 0.41 * h,
    pelvisH: 0.14 * h,
    torsoH: 0.24 * h,
    chestH: 0.28 * h,
    neckH: 0.05 * h,
    headH: 0.23 * h,
    headW: 0.17 * (0.9 + b * 0.1),
    shoulderHalf: (female ? 0.185 : 0.22) * b,
    hipHalf: (female ? 0.115 : 0.1) * b,
    armUpperLen: 0.3 * h,
    armForeLen: 0.27 * h,
    handLen: 0.1 * h,
    thighW: (female ? 0.13 : 0.14) * b,
    shinW: 0.1 * b,
    armW: (female ? 0.075 : 0.09) * b,
    chestWTop: (female ? 0.3 : 0.38) * b,
    chestWBot: (female ? 0.24 : 0.3) * b,
    pelvisW: (female ? 0.3 : 0.28) * b,
  }
}

export function buildAvatarRig(scene: Scene, appearance: Appearance, name: string): AvatarRig {
  const d = dimensionsFor(appearance)
  const skin = skinTone(appearance.skin)
  const hair = hairColor(appearance.hairColor)
  const top = outfitColor(appearance.top)
  const bottom = outfitColor(appearance.bottom)
  const shoes = outfitColor(appearance.shoes)
  const meshes: Mesh[] = []
  const headMeshes: Mesh[] = []

  const mesh = (
    n: string,
    opts: Parameters<typeof createTaperedBox>[1],
    color: string,
    parent: TransformNode,
    pos: [number, number, number] = [0, 0, 0],
    isHead = false,
  ): Mesh => {
    const m = createTaperedBox(`${name}:${n}`, opts, scene)
    m.material = materialFor(scene, color)
    m.parent = parent
    m.position.set(pos[0], pos[1], pos[2])
    meshes.push(m)
    if (isHead) headMeshes.push(m)
    return m
  }

  const node = (n: string, parent: TransformNode | null, x: number, y: number, z: number) => {
    const t = new TransformNode(`${name}:${n}`, scene)
    if (parent) t.parent = parent
    t.position.set(x, y, z)
    return t
  }

  const root = node('root', null, 0, 0, 0)
  const bob = node('bob', root, 0, 0, 0)

  const hipY = d.legLen
  // ── Pelvis / shorts ────────────────────────────────────────────────
  const spine = node('spine', bob, 0, hipY + d.pelvisH * 0.6, 0)
  mesh(
    'pelvis',
    {
      topWidth: d.pelvisW,
      topDepth: 0.16 * appearance.build,
      bottomWidth: d.pelvisW + 0.02,
      bottomDepth: 0.17 * appearance.build,
      height: d.pelvisH,
      anchor: 'top',
    },
    bottom,
    spine,
    [0, d.pelvisH * 0.4, 0],
  )

  // ── Torso ──────────────────────────────────────────────────────────
  mesh(
    'belly',
    {
      topWidth: d.chestWBot,
      topDepth: 0.15 * appearance.build,
      bottomWidth: d.pelvisW - 0.01,
      bottomDepth: 0.16 * appearance.build,
      height: d.torsoH,
      anchor: 'bottom',
    },
    skin,
    spine,
    [0, d.pelvisH * 0.4 - 0.005, 0],
  )
  const chest = node('chest', spine, 0, d.pelvisH * 0.4 + d.torsoH, 0)
  mesh(
    'chest',
    {
      topWidth: d.chestWTop,
      topDepth: 0.17 * appearance.build,
      bottomWidth: d.chestWBot,
      bottomDepth: 0.15 * appearance.build,
      height: d.chestH,
      anchor: 'bottom',
    },
    top,
    chest,
  )
  if (appearance.body === 'female') {
    mesh(
      'bust',
      {
        topWidth: d.chestWTop * 0.8,
        topDepth: 0.05,
        bottomWidth: d.chestWBot * 0.85,
        bottomDepth: 0.085,
        height: d.chestH * 0.42,
        anchor: 'top',
      },
      top,
      chest,
      [0, d.chestH * 0.78, 0.075],
    )
  }

  // ── Head ───────────────────────────────────────────────────────────
  const neck = node('neck', chest, 0, d.chestH, 0)
  mesh(
    'neckM',
    {
      topWidth: 0.07,
      topDepth: 0.07,
      bottomWidth: 0.08,
      bottomDepth: 0.08,
      height: d.neckH + 0.02,
      anchor: 'bottom',
    },
    skin,
    neck,
    [0, -0.01, 0],
  )
  const head = node('head', neck, 0, d.neckH, 0)
  mesh(
    'skull',
    {
      topWidth: d.headW * 0.92,
      topDepth: d.headW * 0.95,
      bottomWidth: d.headW * 0.8,
      bottomDepth: d.headW * 0.82,
      height: d.headH,
      anchor: 'bottom',
      bottomShiftZ: 0.005,
    },
    skin,
    head,
    [0, 0, 0],
    true,
  )
  const face = d.headW / 2 + 0.002
  const eyeY = d.headH * 0.55
  const eyeBox = {
    topWidth: 0.022,
    topDepth: 0.012,
    bottomWidth: 0.022,
    bottomDepth: 0.012,
    height: 0.026,
    anchor: 'top' as const,
  }
  mesh('eyeL', eyeBox, '#1e1a18', head, [-0.036, eyeY + 0.013, face], true)
  mesh('eyeR', eyeBox, '#1e1a18', head, [0.036, eyeY + 0.013, face], true)
  const browBox = {
    topWidth: 0.04,
    topDepth: 0.012,
    bottomWidth: 0.04,
    bottomDepth: 0.012,
    height: 0.012,
    anchor: 'top' as const,
  }
  mesh('browL', browBox, hair, head, [-0.036, eyeY + 0.045, face], true)
  mesh('browR', browBox, hair, head, [0.036, eyeY + 0.045, face], true)
  mesh(
    'nose',
    {
      topWidth: 0.024,
      topDepth: 0.03,
      bottomWidth: 0.03,
      bottomDepth: 0.024,
      height: 0.05,
      anchor: 'top',
    },
    skin,
    head,
    [0, eyeY + 0.005, face + 0.006],
    true,
  )
  mesh(
    'mouth',
    {
      topWidth: 0.045,
      topDepth: 0.008,
      bottomWidth: 0.04,
      bottomDepth: 0.008,
      height: 0.01,
      anchor: 'top',
    },
    '#a06050',
    head,
    [0, d.headH * 0.28, face],
    true,
  )

  buildHair(appearance, d, head, hair, mesh)
  buildFacialHair(appearance, d, head, hair, face, mesh)

  // ── Arms ───────────────────────────────────────────────────────────
  const shoulderY = d.chestH * 0.88
  const armDefs: ['L' | 'R', number][] = [
    ['L', -1],
    ['R', 1],
  ]
  const shoulders: Record<string, TransformNode> = {}
  const elbows: Record<string, TransformNode> = {}
  let handR: TransformNode | null = null
  for (const [side, sign] of armDefs) {
    const shoulder = node(
      `shoulder${side}`,
      chest,
      sign * (d.shoulderHalf + d.armW * 0.4),
      shoulderY,
      0,
    )
    shoulders[side] = shoulder
    mesh(
      `upperArm${side}`,
      {
        topWidth: d.armW,
        topDepth: d.armW,
        bottomWidth: d.armW * 0.85,
        bottomDepth: d.armW * 0.85,
        height: d.armUpperLen,
        anchor: 'top',
      },
      skin,
      shoulder,
    )
    const elbow = node(`elbow${side}`, shoulder, 0, -d.armUpperLen, 0)
    elbows[side] = elbow
    mesh(
      `foreArm${side}`,
      {
        topWidth: d.armW * 0.82,
        topDepth: d.armW * 0.82,
        bottomWidth: d.armW * 0.6,
        bottomDepth: d.armW * 0.6,
        height: d.armForeLen,
        anchor: 'top',
      },
      skin,
      elbow,
    )
    const hand = node(`hand${side}`, elbow, 0, -d.armForeLen, 0)
    mesh(
      `handM${side}`,
      {
        topWidth: d.armW * 0.62,
        topDepth: d.armW * 0.72,
        bottomWidth: d.armW * 0.5,
        bottomDepth: d.armW * 0.6,
        height: d.handLen,
        anchor: 'top',
      },
      skin,
      hand,
    )
    if (side === 'R') handR = hand
  }

  // ── Legs ───────────────────────────────────────────────────────────
  const hips: Record<string, TransformNode> = {}
  const knees: Record<string, TransformNode> = {}
  for (const [side, sign] of armDefs) {
    const hip = node(`hip${side}`, bob, sign * d.hipHalf, hipY, 0)
    hips[side] = hip
    // Upper thigh wears the shorts color, lower part skin.
    mesh(
      `thighTop${side}`,
      {
        topWidth: d.thighW,
        topDepth: d.thighW + 0.015,
        bottomWidth: d.thighW * 0.92,
        bottomDepth: d.thighW,
        height: d.thighLen * 0.45,
        anchor: 'top',
      },
      bottom,
      hip,
    )
    mesh(
      `thigh${side}`,
      {
        topWidth: d.thighW * 0.9,
        topDepth: d.thighW * 0.98,
        bottomWidth: d.thighW * 0.72,
        bottomDepth: d.thighW * 0.8,
        height: d.thighLen * 0.58,
        anchor: 'top',
      },
      skin,
      hip,
      [0, -d.thighLen * 0.42, 0],
    )
    const knee = node(`knee${side}`, hip, 0, -d.thighLen, 0)
    knees[side] = knee
    mesh(
      `shin${side}`,
      {
        topWidth: d.shinW,
        topDepth: d.shinW + 0.01,
        bottomWidth: d.shinW * 0.6,
        bottomDepth: d.shinW * 0.7,
        height: d.shinLen - 0.05,
        anchor: 'top',
      },
      skin,
      knee,
    )
    mesh(
      `foot${side}`,
      {
        topWidth: d.shinW * 0.75,
        topDepth: 0.14,
        bottomWidth: d.shinW * 0.85,
        bottomDepth: 0.17,
        height: 0.06,
        anchor: 'top',
        bottomShiftZ: 0.035,
      },
      shoes,
      knee,
      [0, -(d.shinLen - 0.055), 0.03],
    )
  }

  const joints: RigJoints = {
    root,
    bob,
    spine,
    chest,
    neck,
    head,
    shoulderL: shoulders.L as TransformNode,
    shoulderR: shoulders.R as TransformNode,
    elbowL: elbows.L as TransformNode,
    elbowR: elbows.R as TransformNode,
    hipL: hips.L as TransformNode,
    hipR: hips.R as TransformNode,
    kneeL: knees.L as TransformNode,
    kneeR: knees.R as TransformNode,
    handR: handR as TransformNode,
  }

  return {
    joints,
    eyeHeight:
      hipY + d.pelvisH * 0.6 + d.pelvisH * 0.4 + d.torsoH + d.chestH + d.neckH + d.headH * 0.55,
    setHeadVisible(visible: boolean): void {
      for (const m of headMeshes) m.isVisible = visible
    },
    dispose(): void {
      for (const m of meshes) m.dispose()
      root.dispose()
    },
  }
}

type MeshFn = (
  n: string,
  opts: Parameters<typeof createTaperedBox>[1],
  color: string,
  parent: TransformNode,
  pos?: [number, number, number],
  isHead?: boolean,
) => Mesh

function buildHair(a: Appearance, d: Dims, head: TransformNode, hair: string, mesh: MeshFn): void {
  if (a.hairStyle === 'bald') return
  const capW = d.headW * 0.98
  const capY = d.headH * 0.82
  // Base cap for every style
  mesh(
    'hairCap',
    {
      topWidth: capW * 0.9,
      topDepth: capW * 0.95,
      bottomWidth: capW,
      bottomDepth: capW * 1.02,
      height: d.headH * 0.3,
      anchor: 'bottom',
      topShiftZ: -0.008,
    },
    hair,
    head,
    [0, capY, -0.004],
    true,
  )
  // Back panel reaching down (varies per style)
  const backLen: Record<string, number> = {
    buzz: 0.05,
    short: 0.08,
    bun: 0.08,
    messy: 0.1,
    long: 0.34,
    ponytail: 0.07,
  }
  mesh(
    'hairBack',
    {
      topWidth: capW,
      topDepth: 0.045,
      bottomWidth: capW * (a.hairStyle === 'long' ? 0.85 : 0.95),
      bottomDepth: 0.04,
      height: backLen[a.hairStyle] ?? 0.07,
      anchor: 'top',
    },
    hair,
    head,
    [0, capY + d.headH * 0.12, -d.headW / 2 + 0.005],
    true,
  )
  if (a.hairStyle !== 'buzz') {
    // Fringe
    mesh(
      'hairFringe',
      {
        topWidth: capW * 0.92,
        topDepth: 0.04,
        bottomWidth: capW * 0.8,
        bottomDepth: 0.03,
        height: d.headH * 0.16,
        anchor: 'top',
      },
      hair,
      head,
      [0, capY + d.headH * 0.16, d.headW / 2 - 0.012],
      true,
    )
  }
  if (a.hairStyle === 'bun') {
    mesh(
      'hairBun',
      {
        topWidth: 0.07,
        topDepth: 0.07,
        bottomWidth: 0.09,
        bottomDepth: 0.09,
        height: 0.07,
        anchor: 'bottom',
      },
      hair,
      head,
      [0, capY + d.headH * 0.18, -d.headW / 2 - 0.02],
      true,
    )
  }
  if (a.hairStyle === 'ponytail') {
    mesh(
      'hairTail',
      {
        topWidth: 0.05,
        topDepth: 0.05,
        bottomWidth: 0.03,
        bottomDepth: 0.03,
        height: 0.28,
        anchor: 'top',
        bottomShiftZ: -0.04,
      },
      hair,
      head,
      [0, capY + d.headH * 0.1, -d.headW / 2 - 0.015],
      true,
    )
  }
  if (a.hairStyle === 'messy') {
    mesh(
      'hairTuftL',
      {
        topWidth: 0.05,
        topDepth: 0.06,
        bottomWidth: 0.03,
        bottomDepth: 0.04,
        height: 0.06,
        anchor: 'bottom',
      },
      hair,
      head,
      [-d.headW * 0.35, capY + d.headH * 0.22, 0.01],
      true,
    )
    mesh(
      'hairTuftR',
      {
        topWidth: 0.06,
        topDepth: 0.05,
        bottomWidth: 0.04,
        bottomDepth: 0.03,
        height: 0.07,
        anchor: 'bottom',
      },
      hair,
      head,
      [d.headW * 0.3, capY + d.headH * 0.25, -0.02],
      true,
    )
  }
}

function buildFacialHair(
  a: Appearance,
  d: Dims,
  head: TransformNode,
  hair: string,
  face: number,
  mesh: MeshFn,
): void {
  if (a.body !== 'male' || a.facialHair === 'none') return
  if (a.facialHair === 'mustache' || a.facialHair === 'full') {
    mesh(
      'mustache',
      {
        topWidth: 0.06,
        topDepth: 0.014,
        bottomWidth: 0.05,
        bottomDepth: 0.012,
        height: 0.016,
        anchor: 'top',
      },
      hair,
      head,
      [0, d.headH * 0.38, face + 0.006],
      true,
    )
  }
  if (a.facialHair === 'goatee' || a.facialHair === 'full') {
    mesh(
      'goatee',
      {
        topWidth: 0.045,
        topDepth: 0.02,
        bottomWidth: 0.035,
        bottomDepth: 0.016,
        height: 0.05,
        anchor: 'top',
      },
      hair,
      head,
      [0, d.headH * 0.24, face - 0.002],
      true,
    )
  }
  if (a.facialHair === 'full') {
    mesh(
      'beardL',
      {
        topWidth: 0.02,
        topDepth: d.headW * 0.7,
        bottomWidth: 0.016,
        bottomDepth: d.headW * 0.5,
        height: d.headH * 0.3,
        anchor: 'top',
      },
      hair,
      head,
      [-d.headW * 0.42, d.headH * 0.42, 0.01],
      true,
    )
    mesh(
      'beardR',
      {
        topWidth: 0.02,
        topDepth: d.headW * 0.7,
        bottomWidth: 0.016,
        bottomDepth: d.headW * 0.5,
        height: d.headH * 0.3,
        anchor: 'top',
      },
      hair,
      head,
      [d.headW * 0.42, d.headH * 0.42, 0.01],
      true,
    )
  }
}
