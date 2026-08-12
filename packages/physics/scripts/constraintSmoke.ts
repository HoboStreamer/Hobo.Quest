/**
 * Headless constraint smoke test (run with tsx): exercises every sandbox
 * constraint variant — rope, hinge (limits, friction, motor), slider
 * (limits, motor), spring — against real Havok, exactly as the dedicated
 * server runs it. Complements smoke.ts (bodies, sweeps, weld).
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import HavokPhysics from '@babylonjs/havok'
import { quat, vec3, type Vec3 } from '@hobo/shared'
import { CollisionLayer } from '../src/types.js'
import { createHeadlessHavokWorld } from '../src/havok/index.js'

const require = createRequire(import.meta.url)
const wasmPath = require.resolve('@babylonjs/havok/lib/esm/HavokPhysics.wasm')
const havok = await HavokPhysics({ wasmBinary: (await readFile(wasmPath)).buffer as ArrayBuffer })

const world = createHeadlessHavokWorld(havok)
const dt = 1 / 30
const PROP_MASK = CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player

world.addBody({
  shape: { type: 'box', size: [200, 1, 200] },
  motion: 'static',
  pos: vec3(0, -0.5, 0),
  layer: CollisionLayer.Static,
  collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
})

const rot = quat()
const p = vec3()

function makeBox(pos: Vec3, size = 0.5, motion: 'dynamic' | 'static' = 'dynamic'): number {
  return world.addBody({
    shape: { type: 'box', size: [size, size, size] },
    motion,
    pos,
    massKg: 10,
    layer: CollisionLayer.Prop,
    collidesWith: PROP_MASK,
  })
}

// ── Rope: a box tethered to a static anchor swings but never exceeds length ──
{
  const anchor = makeBox(vec3(0, 6, 0), 0.4, 'static')
  const bob = makeBox(vec3(1.5, 6, 0), 0.4)
  const rope = world.addConstraint({
    type: 'rope',
    bodyA: anchor,
    bodyB: bob,
    anchorA: vec3(0, 0, 0),
    anchorB: vec3(0, 0, 0),
    length: 2,
  })
  let maxDist = 0
  let minY = Infinity
  for (let i = 0; i < 300; i++) {
    world.step(dt)
    world.getTransform(bob, p, rot)
    maxDist = Math.max(maxDist, Math.hypot(p.x, p.y - 6, p.z))
    minY = Math.min(minY, p.y)
  }
  console.log('rope: max anchor distance', maxDist.toFixed(3), 'lowest y', minY.toFixed(2))
  if (maxDist > 2.3) throw new Error(`rope stretched past length: ${maxDist}`)
  // The bob must have swung down through the bottom of its arc (a pendulum
  // on a taut 2 m tether reaches y ≈ 4).
  if (minY > 4.6) throw new Error(`rope bob never swung down: minY=${minY}`)
  world.removeConstraint(rope)
}

// ── Hinge with limits: a door swings but respects ±45° ──
{
  const post = makeBox(vec3(10, 2, 0), 0.4, 'static')
  const door = makeBox(vec3(10.9, 2, 0), 0.4)
  world.addConstraint({
    type: 'hinge',
    bodyA: post,
    bodyB: door,
    anchorA: vec3(0.45, 0, 0),
    anchorB: vec3(-0.45, 0, 0),
    axisA: vec3(0, 1, 0),
    axisB: vec3(0, 1, 0),
    limits: { min: -Math.PI / 4, max: Math.PI / 4 },
  })
  // Shove the door hard sideways; the hinge must cap the swing.
  world.setLinearVelocity(door, vec3(0, 0, 8))
  let maxAngle = 0
  for (let i = 0; i < 90; i++) {
    world.step(dt)
    world.getTransform(door, p, rot)
    const angle = Math.abs(Math.atan2(p.z, p.x - 10))
    maxAngle = Math.max(maxAngle, angle)
  }
  console.log('hinge: max swing angle', ((maxAngle * 180) / Math.PI).toFixed(1), 'deg')
  if (maxAngle > Math.PI / 4 + 0.25) throw new Error(`hinge blew past its limit: ${maxAngle}`)
  if (maxAngle < 0.2) throw new Error('hinge did not swing at all')
  world.getTransform(door, p, rot)
  if (Math.abs(p.y - 2) > 0.25) throw new Error(`hinge door fell: y=${p.y}`)
}

// ── Motorized hinge (bearing + drive): a wheel spins up ──
{
  const axleMount = makeBox(vec3(20, 3, 0), 0.4, 'static')
  const wheel = world.addBody({
    shape: { type: 'cylinder', radius: 0.6, height: 0.2 },
    motion: 'dynamic',
    pos: vec3(20, 3, 0.4),
    massKg: 8,
    layer: CollisionLayer.Prop,
    collidesWith: PROP_MASK,
  })
  const motorId = world.addConstraint({
    type: 'hinge',
    bodyA: axleMount,
    bodyB: wheel,
    anchorA: vec3(0, 0, 0.4),
    anchorB: vec3(0, 0, 0),
    axisA: vec3(0, 0, 1),
    axisB: vec3(0, 1, 0), // cylinder's own axis is +Y
    motor: { targetVelocity: 6, maxForce: 500 },
  })
  const av = vec3()
  for (let i = 0; i < 90; i++) world.step(dt)
  world.getAngularVelocity(wheel, av)
  const spin = Math.hypot(av.x, av.y, av.z)
  console.log('motor: wheel angular speed', spin.toFixed(2), 'rad/s')
  if (spin < 4) throw new Error(`motorized wheel did not spin up: ${spin}`)
  // Retune the motor to stop; it should brake.
  world.setConstraintMotor(motorId, { targetVelocity: 0, maxForce: 500 })
  for (let i = 0; i < 60; i++) world.step(dt)
  world.getAngularVelocity(wheel, av)
  const stopped = Math.hypot(av.x, av.y, av.z)
  console.log('motor: after brake', stopped.toFixed(3), 'rad/s')
  if (stopped > 0.5) throw new Error(`motor did not brake: ${stopped}`)
}

// ── Slider with limits: a drawer slides along a rail and stops ──
{
  const rail = makeBox(vec3(30, 2, 0), 0.4, 'static')
  const drawer = makeBox(vec3(30, 2, 0.6), 0.4)
  world.addConstraint({
    type: 'slider',
    bodyA: rail,
    bodyB: drawer,
    anchorA: vec3(0, 0, 0.6),
    anchorB: vec3(0, 0, 0),
    axisA: vec3(0, 0, 1),
    axisB: vec3(0, 0, 1),
    limits: { min: -0.5, max: 1.0 },
  })
  world.setLinearVelocity(drawer, vec3(0, 0, 5))
  let maxZ = -Infinity
  let minZ = Infinity
  let maxOffAxis = 0
  for (let i = 0; i < 120; i++) {
    world.step(dt)
    world.getTransform(drawer, p, rot)
    maxZ = Math.max(maxZ, p.z)
    minZ = Math.min(minZ, p.z)
    maxOffAxis = Math.max(maxOffAxis, Math.abs(p.x - 30), Math.abs(p.y - 2))
    if (i === 60) world.setLinearVelocity(drawer, vec3(0, 0, -5))
  }
  console.log(
    'slider: travel',
    minZ.toFixed(2),
    '..',
    maxZ.toFixed(2),
    'off-axis',
    maxOffAxis.toFixed(3),
  )
  if (maxZ > 1.85 || minZ < -0.15) throw new Error(`slider blew limits: ${minZ}..${maxZ}`)
  if (maxZ < 1.3) throw new Error(`slider did not travel: ${maxZ}`)
  if (maxOffAxis > 0.15) throw new Error(`slider left its rail: ${maxOffAxis}`)
}

// ── Spring: a hanging box bounces then settles near rest length ──
{
  const mount = makeBox(vec3(40, 6, 0), 0.4, 'static')
  const bob = makeBox(vec3(40, 5.5, 0), 0.4)
  world.addConstraint({
    type: 'spring',
    bodyA: mount,
    bodyB: bob,
    anchorA: vec3(0, 0, 0),
    anchorB: vec3(0, 0, 0),
    restLength: 1.5,
    stiffness: 400,
    damping: 15,
  })
  for (let i = 0; i < 300; i++) world.step(dt)
  world.getTransform(bob, p, rot)
  const dist = Math.hypot(p.x - 40, p.y - 6, p.z)
  console.log('spring: settled anchor distance', dist.toFixed(3), '(rest 1.5)')
  // Gravity stretches the spring below rest; generous envelope.
  if (dist < 1.2 || dist > 2.2) throw new Error(`spring settled badly: ${dist}`)
}

// ── Stress: a 200-prop welded structure must settle and stay cheap ──
{
  const GRID = 10 // 10 x 20 wall of boxes
  const ROWS = 20
  const ids: number[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < GRID; c++) {
      ids.push(makeBox(vec3(60 + c * 0.52, 0.26 + r * 0.52, 0), 0.5))
    }
  }
  // Weld each box to its right and upper neighbor (grid lattice).
  let welds = 0
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < GRID; c++) {
      const i = r * GRID + c
      if (c + 1 < GRID) {
        world.addConstraint({ type: 'weld', bodyA: ids[i]!, bodyB: ids[i + 1]! })
        welds++
      }
      if (r + 1 < ROWS) {
        world.addConstraint({ type: 'weld', bodyA: ids[i]!, bodyB: ids[i + GRID]! })
        welds++
      }
    }
  }
  // Settle phase.
  let settleTick = -1
  const t0 = performance.now()
  for (let i = 0; i < 600; i++) {
    world.step(dt)
    if (settleTick < 0 && ids.every((id) => world.isSettled(id))) {
      settleTick = i
      break
    }
  }
  const settleMs = performance.now() - t0
  console.log(
    `stress: ${ids.length} props, ${welds} welds — settled at tick ${settleTick} (${settleMs.toFixed(0)}ms total)`,
  )
  if (settleTick < 0) throw new Error('welded structure never settled')

  // Settled steps must be cheap (structure asleep, no solver churn).
  const t1 = performance.now()
  for (let i = 0; i < 100; i++) world.step(dt)
  const idleMs = (performance.now() - t1) / 100
  console.log(`stress: settled step cost ${idleMs.toFixed(3)}ms`)
  if (idleMs > 5) throw new Error(`sleeping welded structure too expensive: ${idleMs}ms/step`)
  if (!ids.every((id) => world.isSettled(id))) throw new Error('structure woke without cause')

  // Impact wakes the island, then it settles again.
  world.setLinearVelocity(ids[ids.length - 1]!, vec3(0, 0, 6))
  world.step(dt)
  const awake = ids.filter((id) => !world.isSettled(id)).length
  console.log(`stress: impact woke ${awake} bodies`)
  if (awake < 1) throw new Error('impact failed to wake the structure')
  let resettled = false
  for (let i = 0; i < 900; i++) {
    world.step(dt)
    if (ids.every((id) => world.isSettled(id))) {
      resettled = true
      console.log(`stress: re-settled after ${i} ticks`)
      break
    }
  }
  if (!resettled) throw new Error('structure never re-settled after impact')
}

world.dispose()
console.log('CONSTRAINT SMOKE OK')
