/**
 * Headless physics smoke test (run with tsx): loads the Havok wasm in Node,
 * builds a world, drops a dynamic box onto static ground, checks it settles,
 * and verifies capsule sweeps + raycasts. Exercises the exact code path the
 * dedicated server uses.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import HavokPhysics from '@babylonjs/havok'
import { quat, vec3 } from '@hobo/shared'
import { CollisionLayer } from '../src/types.js'
import { createHeadlessHavokWorld } from '../src/havok/index.js'

const require = createRequire(import.meta.url)
const wasmPath = require.resolve('@babylonjs/havok/lib/esm/HavokPhysics.wasm')
const havok = await HavokPhysics({ wasmBinary: (await readFile(wasmPath)).buffer as ArrayBuffer })

const world = createHeadlessHavokWorld(havok)

const ground = world.addBody({
  shape: { type: 'box', size: [100, 1, 100] },
  motion: 'static',
  pos: vec3(0, -0.5, 0),
  layer: CollisionLayer.Static,
  collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
})

const box = world.addBody({
  shape: { type: 'box', size: [0.7, 0.7, 0.7] },
  motion: 'dynamic',
  pos: vec3(0, 3, 0),
  massKg: 25,
  layer: CollisionLayer.Prop,
  collidesWith: CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
})

const dt = 1 / 30
for (let i = 0; i < 120; i++) world.step(dt)

const pos = vec3()
const rot = quat()
world.getTransform(box, pos, rot)
console.log('box rest pos:', pos, 'settled:', world.isSettled(box))
if (Math.abs(pos.y - 0.35) > 0.05) throw new Error(`box did not rest at 0.35: ${pos.y}`)
if (!world.isSettled(box)) throw new Error('box did not settle')

// Capsule sweep down over the box should hit its top
const hit = world.sweepCapsule(
  vec3(0, 3, 0),
  vec3(0, 0.5, 0),
  0.4,
  1.8,
  CollisionLayer.Static | CollisionLayer.Prop,
)
console.log('sweep hit:', hit)
if (!hit || hit.normal.y < 0.9) throw new Error('capsule sweep failed')

// Raycast should identify the box body
const ray = world.raycast(vec3(2, 0.35, 0), vec3(-2, 0.35, 0), CollisionLayer.Prop)
console.log('ray hit:', ray)
if (!ray || ray.bodyId !== box) throw new Error('raycast failed')

// Freeze then unfreeze
world.setMotionType(box, 'static')
world.setMotionType(box, 'dynamic')
world.step(dt)

// Kinematic player body pushes a prop
const player = world.addBody({
  shape: { type: 'capsule', radius: 0.4, height: 1.8 },
  motion: 'kinematic',
  pos: vec3(-3, 0.9, 0),
  layer: CollisionLayer.Player,
  collidesWith: CollisionLayer.Static | CollisionLayer.Prop,
})
for (let i = 0; i < 60; i++) {
  world.setTransform(player, vec3(-3 + i * 0.06, 0.9, 0))
  world.step(dt)
}
world.getTransform(box, pos, rot)
console.log('box after push:', pos, 'settled:', world.isSettled(box))
if (pos.x < 0.05) throw new Error('kinematic player failed to push prop')

// Weld: two stacked boxes welded together should move as one and keep
// their relative offset after being shoved.
const weldA = world.addBody({
  shape: { type: 'box', size: [0.5, 0.5, 0.5] },
  motion: 'dynamic',
  pos: vec3(10, 0.25, 0),
  massKg: 10,
  layer: CollisionLayer.Prop,
  collidesWith: CollisionLayer.Static | CollisionLayer.Prop,
})
const weldB = world.addBody({
  shape: { type: 'box', size: [0.5, 0.5, 0.5] },
  motion: 'dynamic',
  pos: vec3(10, 0.78, 0),
  massKg: 10,
  layer: CollisionLayer.Prop,
  collidesWith: CollisionLayer.Static | CollisionLayer.Prop,
})
for (let i = 0; i < 30; i++) world.step(dt)
const weldId = world.addConstraint({ type: 'weld', bodyA: weldA, bodyB: weldB })
world.setLinearVelocity(weldA, vec3(4, 0, 0))
for (let i = 0; i < 60; i++) world.step(dt)
const pa = vec3()
const pb = vec3()
world.getTransform(weldA, pa, rot)
world.getTransform(weldB, pb, rot)
console.log('weld: A', pa, 'B', pb)
if (pa.x < 10.3) throw new Error('welded pair did not slide')
const dy = pb.y - pa.y
if (Math.abs(pb.x - pa.x) > 0.25 || dy < 0.3 || dy > 0.75) {
  throw new Error(`weld did not hold relative pose (dx=${pb.x - pa.x}, dy=${dy})`)
}
world.removeConstraint(weldId)

world.removeBody(ground)
world.dispose()
console.log('PHYSICS SMOKE OK')
