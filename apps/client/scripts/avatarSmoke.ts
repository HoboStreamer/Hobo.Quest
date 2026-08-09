/**
 * Headless avatar smoke test (NullEngine): builds rigs for a spread of
 * appearances, runs the animator through locomotion/air/tool states, and
 * sanity-checks proportions. Catches geometry/joint regressions without a
 * browser.
 *
 * Run: tsx apps/client/scripts/avatarSmoke.ts
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { createContent } from '@hobo/content'
import { defaultAppearance, randomAppearance, type Appearance } from '@hobo/protocol'
import { createRng } from '@hobo/shared'
import { Avatar } from '../src/render/avatar/avatar.js'
import { buildAvatarRig } from '../src/render/avatar/rig.js'

const engine = new NullEngine()
const scene = new Scene(engine)
const content = createContent()

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ok: ${label}`)
}

// 1. Rig proportions across the whole customization space.
const rng = createRng(1234)
const variants: Appearance[] = [defaultAppearance()]
for (let i = 0; i < 30; i++) variants.push(randomAppearance(() => rng.next()))
for (const [i, appearance] of variants.entries()) {
  const rig = buildAvatarRig(scene, appearance, `test${i}`)
  const expectedEye = 1.55 * appearance.height
  if (Math.abs(rig.eyeHeight - expectedEye) > 0.22) {
    throw new Error(
      `variant ${i} (${appearance.body}, h=${appearance.height}): eye ${rig.eyeHeight.toFixed(3)} vs ~${expectedEye.toFixed(3)}`,
    )
  }
  rig.setHeadVisible(false)
  rig.setHeadVisible(true)
  rig.dispose()
}
assert(true, `${variants.length} appearance variants build with sane eye heights`)

// 2. Animator runs through states without NaNs.
const avatar = new Avatar(scene, content, defaultAppearance(), 'anim')
const states = [
  { speed: 0, grounded: true, itemDef: undefined },
  { speed: 3, grounded: true, itemDef: 'physgun' },
  { speed: 7.2, grounded: true, itemDef: 'stone_axe' },
  { speed: 5, grounded: false, itemDef: 'physgun', beamActive: true },
]
let t = 0
for (const s of states) {
  for (let i = 0; i < 60; i++) {
    t += 1 / 60
    avatar.update({
      dt: 1 / 60,
      time: t,
      x: Math.sin(t),
      y: 0,
      z: t * (s.speed ?? 0),
      yaw: t * 0.3,
      pitch: Math.sin(t) * 0.8,
      ...s,
    })
  }
}
avatar.triggerSwing()
for (let i = 0; i < 30; i++) {
  t += 1 / 60
  avatar.update({
    dt: 1 / 60,
    time: t,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    speed: 2,
    grounded: true,
    itemDef: 'stone_axe',
  })
}
const pos = avatar.rootPosition
assert(Number.isFinite(pos.x) && Number.isFinite(pos.y), 'animator produced finite transforms')

// 3. Appearance rebuild (customization) does not leak or throw.
for (let i = 0; i < 10; i++) {
  avatar.setAppearance(randomAppearance(() => rng.next()))
}
const beam = avatar.beamOrigin()
assert(Number.isFinite(beam.x), 'beam origin resolves after rebuilds')
avatar.dispose()

const remaining = scene.meshes.length
assert(remaining < 40, `meshes cleaned up after dispose (${remaining} left: statics only)`)

scene.dispose()
engine.dispose()
console.log('AVATAR SMOKE OK')
