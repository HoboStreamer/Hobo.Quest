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
 * parented to them — no skinning, fully data-driven from Appearance.
 *
 * Assembly rules that keep the body seamless:
 *  - every segment's top extends PAST its joint (OVERLAP) into the segment
 *    above, so bending never exposes gaps or interior top faces;
 *  - adjoining segment widths match at the junction (thigh bottom == shin
 *    top, etc.) so silhouettes stay continuous;
 *  - thigh + shin + foot exactly total the leg length, so feet stand ON the
 *    ground instead of clipping through it.
 *
 * Conventions: root origin at the FEET (ground). +Z faces forward (player
 * yaw). Limb joints rotate at the top of their segment.
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

/** How far each segment reaches past its joint into the parent segment. */
const OVERLAP = 0.035

interface Dims {
  legLen: number
  thighLen: number
  shinLen: number
  footH: number
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
  const legLen = 0.84 * h
  const footH = 0.06
  // Legs are budgeted to land exactly on the ground.
  const thighLen = (legLen - footH) * 0.52
  const shinLen = (legLen - footH) * 0.48
  const thighW = (female ? 0.13 : 0.14) * b
  return {
    legLen,
    thighLen,
    shinLen,
    footH,
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
    thighW,
    // Shin top matches thigh bottom (0.78 * thighW) for a continuous line.
    shinW: thighW * 0.78,
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
  const beltDepth = 0.17 * appearance.build

  // ── Pelvis / shorts (spine pivot sits just above the hips) ─────────
  const spine = node('spine', bob, 0, hipY + d.pelvisH * 0.5, 0)
  mesh(
    'pelvis',
    {
      topWidth: d.pelvisW * 0.8,
      topDepth: (beltDepth - 0.01) * 0.72,
      bottomWidth: d.pelvisW + 0.025,
      bottomDepth: beltDepth,
      height: d.pelvisH + OVERLAP,
      anchor: 'top',
    },
    bottom,
    spine,
    [0, d.pelvisH * 0.5, 0],
  )

  // ── Torso (belly overlaps down into the pelvis) ────────────────────
  mesh(
    'belly',
    {
      topWidth: d.chestWBot,
      topDepth: beltDepth - 0.02,
      bottomWidth: d.pelvisW * 0.9,
      bottomDepth: (beltDepth - 0.01) * 0.88,
      height: d.torsoH + OVERLAP,
      anchor: 'bottom',
    },
    skin,
    spine,
    [0, d.pelvisH * 0.5 - d.torsoH - OVERLAP + (d.torsoH + OVERLAP), 0],
  )
  // (belly anchored bottom at spine top: position its base at pelvis top)
  const belly = meshes[meshes.length - 1] as Mesh
  belly.position.set(0, d.pelvisH * 0.5 - OVERLAP, 0)

  const chest = node('chest', spine, 0, d.pelvisH * 0.5 + d.torsoH, 0)
  mesh(
    'chest',
    {
      topWidth: d.chestWTop,
      topDepth: beltDepth,
      bottomWidth: d.chestWBot * 1.07,
      bottomDepth: (beltDepth - 0.02) * 1.1,
      height: d.chestH + OVERLAP,
      anchor: 'bottom',
    },
    top,
    chest,
    [0, -OVERLAP, 0],
  )
  if (appearance.body === 'female') {
    mesh(
      'bust',
      {
        topWidth: d.chestWTop * 0.78,
        topDepth: 0.045,
        bottomWidth: d.chestWBot * 0.85,
        bottomDepth: 0.08,
        height: d.chestH * 0.4,
        anchor: 'top',
      },
      top,
      chest,
      [0, d.chestH * 0.76, beltDepth / 2 - 0.02],
    )
  }

  // ── Head ───────────────────────────────────────────────────────────
  const neck = node('neck', chest, 0, d.chestH, 0)
  mesh(
    'neckM',
    {
      topWidth: 0.075,
      topDepth: 0.08,
      bottomWidth: 0.085,
      bottomDepth: 0.09,
      height: d.neckH + OVERLAP * 2,
      anchor: 'bottom',
    },
    skin,
    neck,
    [0, -OVERLAP * 2, 0],
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
    [0, -0.01, 0],
    true,
  )
  const face = d.headW / 2 + 0.002
  const eyeY = d.headH * 0.52
  const eyeBox = {
    topWidth: 0.024,
    topDepth: 0.012,
    bottomWidth: 0.024,
    bottomDepth: 0.012,
    height: 0.024,
    anchor: 'top' as const,
  }
  mesh('eyeL', eyeBox, '#1e1a18', head, [-0.036, eyeY + 0.012, face], true)
  mesh('eyeR', eyeBox, '#1e1a18', head, [0.036, eyeY + 0.012, face], true)
  const browBox = {
    topWidth: 0.042,
    topDepth: 0.012,
    bottomWidth: 0.042,
    bottomDepth: 0.012,
    height: 0.011,
    anchor: 'top' as const,
  }
  mesh('browL', browBox, hair, head, [-0.036, eyeY + 0.04, face], true)
  mesh('browR', browBox, hair, head, [0.036, eyeY + 0.04, face], true)
  mesh(
    'nose',
    {
      topWidth: 0.024,
      topDepth: 0.028,
      bottomWidth: 0.03,
      bottomDepth: 0.022,
      height: 0.045,
      anchor: 'top',
    },
    skin,
    head,
    [0, eyeY, face + 0.004],
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
    [0, d.headH * 0.26, face],
    true,
  )

  buildHair(appearance, d, head, hair, mesh)
  buildFacialHair(appearance, d, head, hair, face, mesh)

  // ── Arms (upper arm overlaps up into the shoulder line) ────────────
  const shoulderY = d.chestH * 0.86
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
      sign * (d.chestWTop / 2 + d.armW * 0.38),
      shoulderY,
      0,
    )
    shoulders[side] = shoulder
    mesh(
      `upperArm${side}`,
      {
        topWidth: d.armW * 0.8,
        topDepth: d.armW * 0.8,
        bottomWidth: d.armW * 0.85,
        bottomDepth: d.armW * 0.85,
        height: d.armUpperLen + OVERLAP,
        anchor: 'top',
      },
      skin,
      shoulder,
      [0, OVERLAP, 0],
    )
    const elbow = node(`elbow${side}`, shoulder, 0, -d.armUpperLen, 0)
    elbows[side] = elbow
    mesh(
      `foreArm${side}`,
      {
        topWidth: d.armW * 0.68,
        topDepth: d.armW * 0.68,
        bottomWidth: d.armW * 0.6,
        bottomDepth: d.armW * 0.6,
        height: d.armForeLen + OVERLAP,
        anchor: 'top',
      },
      skin,
      elbow,
      [0, OVERLAP, 0],
    )
    const hand = node(`hand${side}`, elbow, 0, -d.armForeLen, 0)
    mesh(
      `handM${side}`,
      {
        topWidth: d.armW * 0.48,
        topDepth: d.armW * 0.55,
        bottomWidth: d.armW * 0.52,
        bottomDepth: d.armW * 0.62,
        height: d.handLen + OVERLAP,
        anchor: 'top',
      },
      skin,
      hand,
      [0, OVERLAP, 0],
    )
    if (side === 'R') handR = hand
  }

  // ── Legs (thigh + shin + foot == legLen; overlapped junctions) ─────
  const hips: Record<string, TransformNode> = {}
  const knees: Record<string, TransformNode> = {}
  for (const [side, sign] of armDefs) {
    const hip = node(`hip${side}`, bob, sign * d.hipHalf, hipY, 0)
    hips[side] = hip
    // Shorts-colored upper thigh, overlapping up into the pelvis.
    mesh(
      `thighTop${side}`,
      {
        topWidth: d.thighW * 0.68,
        topDepth: d.thighW * 0.7,
        bottomWidth: d.thighW * 0.94,
        bottomDepth: d.thighW + 0.005,
        height: d.thighLen * 0.5 + OVERLAP,
        anchor: 'top',
      },
      bottom,
      hip,
      [0, OVERLAP, 0],
    )
    mesh(
      `thigh${side}`,
      {
        topWidth: d.thighW * 0.76,
        topDepth: d.thighW * 0.82,
        bottomWidth: d.thighW * 0.78,
        bottomDepth: d.thighW * 0.85,
        height: d.thighLen * 0.5 + OVERLAP,
        anchor: 'top',
      },
      skin,
      hip,
      [0, -d.thighLen * 0.5 + OVERLAP, 0],
    )
    const knee = node(`knee${side}`, hip, 0, -d.thighLen, 0)
    knees[side] = knee
    mesh(
      `shin${side}`,
      {
        topWidth: d.shinW * 0.8,
        topDepth: d.shinW * 0.85,
        bottomWidth: d.shinW * 0.62,
        bottomDepth: d.shinW * 0.72,
        height: d.shinLen + OVERLAP,
        anchor: 'top',
      },
      skin,
      knee,
      [0, OVERLAP, 0],
    )
    // Foot: ankle sits at shin bottom; sole lands exactly on the ground.
    mesh(
      `foot${side}`,
      {
        topWidth: d.shinW * 0.55,
        topDepth: 0.1,
        bottomWidth: d.shinW * 0.95,
        bottomDepth: 0.16,
        height: d.footH + 0.02,
        anchor: 'top',
        bottomShiftZ: 0.045,
      },
      shoes,
      knee,
      [0, -d.shinLen + 0.02, 0.02],
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
      hipY + d.pelvisH * 0.5 + d.pelvisH * 0.5 + d.torsoH + d.chestH + d.neckH + d.headH * 0.55,
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
  const capW = d.headW * 1.02
  const capBase = d.headH * 0.78
  // Cap hugs the skull top (slightly wider so no skin pokes through).
  mesh(
    'hairCap',
    {
      topWidth: capW * 0.88,
      topDepth: capW * 0.92,
      bottomWidth: capW,
      bottomDepth: capW * 1.04,
      height: d.headH * 0.34,
      anchor: 'bottom',
      topShiftZ: -0.008,
    },
    hair,
    head,
    [0, capBase, -0.004],
    true,
  )
  const backLen: Record<string, number> = {
    buzz: 0.06,
    short: 0.09,
    bun: 0.09,
    messy: 0.11,
    long: 0.34,
    ponytail: 0.08,
  }
  mesh(
    'hairBack',
    {
      topWidth: capW,
      topDepth: 0.05,
      bottomWidth: capW * (a.hairStyle === 'long' ? 0.85 : 0.95),
      bottomDepth: 0.04,
      height: backLen[a.hairStyle] ?? 0.07,
      anchor: 'top',
    },
    hair,
    head,
    [0, capBase + d.headH * 0.2, -d.headW / 2 + 0.008],
    true,
  )
  if (a.hairStyle !== 'buzz') {
    // Fringe sits flush against the top of the forehead.
    mesh(
      'hairFringe',
      {
        topWidth: capW * 0.9,
        topDepth: 0.05,
        bottomWidth: capW * 0.78,
        bottomDepth: 0.035,
        height: d.headH * 0.18,
        anchor: 'top',
      },
      hair,
      head,
      [0, capBase + d.headH * 0.26, d.headW / 2 - 0.014],
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
      [0, capBase + d.headH * 0.22, -d.headW / 2 - 0.02],
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
      [0, capBase + d.headH * 0.14, -d.headW / 2 - 0.015],
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
      [-d.headW * 0.35, capBase + d.headH * 0.3, 0.01],
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
      [d.headW * 0.3, capBase + d.headH * 0.32, -0.02],
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
      [0, d.headH * 0.36, face + 0.006],
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
      [0, d.headH * 0.22, face - 0.002],
      true,
    )
  }
  if (a.facialHair === 'full') {
    for (const sign of [-1, 1]) {
      mesh(
        `beard${sign}`,
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
        [sign * d.headW * 0.42, d.headH * 0.42, 0.01],
        true,
      )
    }
  }
}
