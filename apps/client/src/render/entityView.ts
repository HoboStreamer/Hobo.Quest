import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { Quaternion } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import type { ContentRegistry, WorldShape } from '@hobo/content'
import { DEFAULT_MOVEMENT } from '@hobo/gameplay'
import { CollisionLayer, type BodyId, type PhysicsWorld, type ShapeDesc } from '@hobo/physics'
import type { ServerSnapshot, WireEntity } from '@hobo/protocol'
import { quat, vec3, wrapAngle } from '@hobo/shared'
import type { ClientState } from '../state/clientState.js'
import { Avatar } from './avatar/avatar.js'
import { materialFor, meshForShape } from './sceneSetup.js'

/**
 * Maintains the renderable + collidable view of replicated entities:
 * prop/resource meshes with mirror physics bodies (so prediction sweeps
 * and aim rays collide with them), full animated avatars for remote
 * players, and interpolation buffers so remote motion renders smoothly
 * between snapshots.
 */

interface InterpSample {
  t: number
  pos: [number, number, number]
  rot: [number, number, number, number]
  /** Player extras (animation inputs). */
  yaw?: number
  pitch?: number
  speed?: number
  grounded?: boolean
  item?: string | undefined
}

interface EntityVisual {
  entity: WireEntity
  mesh: Mesh | null
  avatar: Avatar | null
  bodyId: BodyId | null
  buffer: InterpSample[]
}

const INTERP_DELAY = 0.13
const _pos = vec3()
const _rot = quat()

export class EntityView {
  private readonly visuals = new Map<string, EntityVisual>()
  private readonly entityByBody = new Map<BodyId, string>()
  /** EMA of (serverTime - localTime) for the interpolation clock. */
  private clockOffset: number | null = null
  private lastUpdateTime = 0

  constructor(
    private readonly scene: Scene,
    private readonly physics: PhysicsWorld,
    private readonly content: ContentRegistry,
    private readonly state: ClientState,
  ) {
    state.events.on('entityAdded', (e) => this.add(e))
    state.events.on('entityRemoved', (id) => this.remove(id))
    state.events.on('entityUpdated', (e) => this.applyAuthoritative(e))
  }

  entityIdForBody(bodyId: BodyId): string | undefined {
    return this.entityByBody.get(bodyId)
  }

  avatarFor(entityId: string): Avatar | null {
    return this.visuals.get(entityId)?.avatar ?? null
  }

  private add(e: WireEntity): void {
    if (e.id === this.state.myEntityId) return // first-person body handles self
    if (this.visuals.has(e.id)) return

    let mesh: Mesh | null = null
    let avatar: Avatar | null = null
    let bodyId: BodyId | null = null

    if (e.kind === 'player') {
      avatar = new Avatar(
        this.scene,
        this.content,
        Avatar.appearanceOrDefault(e.appearance),
        `player:${e.id}`,
      )
    } else if (e.kind === 'prop' && e.def) {
      const def = this.content.item(e.def)
      if (def?.world) {
        mesh = meshForShape(this.scene, `prop:${e.id}`, def.world.shape, def.world.color)
        bodyId = this.physics.addBody({
          shape: toPhysicsShape(def.world.shape),
          motion: 'static',
          pos: vec3(e.pos[0], e.pos[1], e.pos[2]),
          rot: quat(e.rot[0], e.rot[1], e.rot[2], e.rot[3]),
          layer: CollisionLayer.Prop,
          collidesWith: CollisionLayer.Player,
        })
      } else {
        mesh = CreateBox(`prop:${e.id}`, { size: 0.5 }, this.scene)
      }
    } else {
      // Resource node: visual archetype + collision body from the node type.
      const nodeType = this.content.nodeType(e.def ?? '')
      mesh = buildNodeVisual(this.scene, e.id, nodeType?.visual ?? 'scrap')
      bodyId = this.physics.addBody({
        shape: nodeType
          ? toPhysicsShape(nodeType.bodyShape)
          : { type: 'box', size: [0.8, 0.5, 0.8] },
        motion: 'static',
        pos: vec3(e.pos[0], e.pos[1] + (nodeType?.bodyOffsetY ?? 0.4), e.pos[2]),
        layer: CollisionLayer.Prop,
        collidesWith: CollisionLayer.Player,
      })
      setDepletedLook(mesh, (e.remaining ?? 1) <= 0)
    }

    if (mesh) {
      mesh.position.set(e.pos[0], e.pos[1], e.pos[2])
      mesh.rotationQuaternion = new Quaternion(e.rot[0], e.rot[1], e.rot[2], e.rot[3])
    }
    if (bodyId !== null) this.entityByBody.set(bodyId, e.id)
    this.visuals.set(e.id, { entity: e, mesh, avatar, bodyId, buffer: [] })
  }

  private remove(id: string): void {
    const v = this.visuals.get(id)
    if (!v) return
    if (v.mesh) {
      for (const child of v.mesh.getChildMeshes()) child.dispose()
      v.mesh.dispose()
    }
    v.avatar?.dispose()
    if (v.bodyId !== null) {
      this.physics.removeBody(v.bodyId)
      this.entityByBody.delete(v.bodyId)
    }
    this.visuals.delete(id)
  }

  /** Authoritative pin: freeze/settle transforms, resource depletion state. */
  private applyAuthoritative(e: WireEntity): void {
    const v = this.visuals.get(e.id)
    if (!v) return
    if (e.kind === 'resource') {
      if (v.mesh) setDepletedLook(v.mesh, (e.remaining ?? 0) <= 0)
      return
    }
    if (!v.mesh) return
    v.buffer.length = 0
    v.mesh.position.set(e.pos[0], e.pos[1], e.pos[2])
    v.mesh.rotationQuaternion?.set(e.rot[0], e.rot[1], e.rot[2], e.rot[3])
    if (v.bodyId !== null) {
      this.physics.setTransform(
        v.bodyId,
        vec3(e.pos[0], e.pos[1], e.pos[2]),
        quat(e.rot[0], e.rot[1], e.rot[2], e.rot[3]),
      )
    }
  }

  /** Feed a snapshot into interpolation buffers. */
  onSnapshot(snap: ServerSnapshot, localTime: number): void {
    const serverTime = snap.tick / this.state.tickRate
    const offset = serverTime - localTime
    this.clockOffset =
      this.clockOffset === null ? offset : this.clockOffset + (offset - this.clockOffset) * 0.1

    for (const p of snap.players) {
      if (p.id === this.state.myEntityId) continue
      const v = this.visuals.get(p.id)
      if (!v) continue
      pushSample(v.buffer, {
        t: serverTime,
        pos: p.pos,
        rot: [0, 0, 0, 1],
        yaw: p.yaw,
        pitch: p.pitch,
        speed: Math.hypot(p.vel[0], p.vel[2]),
        grounded: p.grounded,
        item: p.item,
      })
    }
    for (const b of snap.bodies) {
      const v = this.visuals.get(b.id)
      if (!v) continue
      pushSample(v.buffer, { t: serverTime, pos: b.pos, rot: b.rot })
      v.entity.pos = b.pos
      v.entity.rot = b.rot
      if (v.bodyId !== null) {
        this.physics.setTransform(
          v.bodyId,
          vec3(b.pos[0], b.pos[1], b.pos[2]),
          quat(b.rot[0], b.rot[1], b.rot[2], b.rot[3]),
        )
      }
    }
  }

  /** Per-frame: interpolate meshes/avatars toward buffered samples. */
  update(localTime: number): void {
    const dt = this.lastUpdateTime > 0 ? Math.min(localTime - this.lastUpdateTime, 0.1) : 0.016
    this.lastUpdateTime = localTime
    if (this.clockOffset === null) return
    const renderTime = localTime + this.clockOffset - INTERP_DELAY

    for (const v of this.visuals.values()) {
      if (v.buffer.length === 0) continue
      const bracket = findBracket(v.buffer, renderTime)
      const { a, b, alpha } = bracket
      _pos.x = a.pos[0] + (b.pos[0] - a.pos[0]) * alpha
      _pos.y = a.pos[1] + (b.pos[1] - a.pos[1]) * alpha
      _pos.z = a.pos[2] + (b.pos[2] - a.pos[2]) * alpha

      if (v.avatar) {
        const yaw = lerpAngle(a.yaw ?? 0, b.yaw ?? a.yaw ?? 0, alpha)
        const latest = v.buffer[v.buffer.length - 1] as InterpSample
        const beamActive = [...this.state.heldBy.values()].includes(v.entity.id)
        v.avatar.update({
          dt,
          time: localTime,
          x: _pos.x,
          y: _pos.y - DEFAULT_MOVEMENT.capsuleHeight / 2,
          z: _pos.z,
          yaw,
          pitch: lerpAngle(a.pitch ?? 0, b.pitch ?? a.pitch ?? 0, alpha),
          speed: latest.speed ?? 0,
          grounded: latest.grounded ?? true,
          itemDef: latest.item,
          beamActive,
        })
        continue
      }

      if (!v.mesh) continue
      nlerpQuat(a.rot, b.rot, alpha, _rot)
      v.mesh.position.set(_pos.x, _pos.y, _pos.z)
      v.mesh.rotationQuaternion?.set(_rot.x, _rot.y, _rot.z, _rot.w)
      // Held props glow subtly so every player can see what's being moved.
      const mat = v.mesh.material as StandardMaterial | null
      if (mat && 'emissiveColor' in mat) {
        const held = this.state.heldBy.has(v.entity.id)
        mat.emissiveColor = held ? HELD_GLOW : NO_GLOW
      }
    }
  }

  positionOf(id: string): Vector3 | null {
    const v = this.visuals.get(id)
    if (!v) return null
    if (v.mesh) return v.mesh.position
    if (v.avatar) return v.avatar.rootPosition
    return null
  }
}

const HELD_GLOW = new Color3(0.25, 0.35, 0.5)
const NO_GLOW = new Color3(0, 0, 0)

function pushSample(buffer: InterpSample[], sample: InterpSample): void {
  buffer.push(sample)
  while (buffer.length > 12) buffer.shift()
}

function findBracket(
  buffer: InterpSample[],
  t: number,
): { a: InterpSample; b: InterpSample; alpha: number } {
  const newest = buffer[buffer.length - 1] as InterpSample
  const oldest = buffer[0] as InterpSample
  let a = oldest
  let b = newest
  if (t <= oldest.t) b = oldest
  else if (t >= newest.t) a = newest
  else {
    for (let i = buffer.length - 2; i >= 0; i--) {
      const s = buffer[i] as InterpSample
      if (s.t <= t) {
        a = s
        b = buffer[i + 1] as InterpSample
        break
      }
    }
  }
  const span = b.t - a.t
  return { a, b, alpha: span > 1e-6 ? (t - a.t) / span : 1 }
}

function lerpAngle(a: number, b: number, alpha: number): number {
  return a + wrapAngle(b - a) * alpha
}

function nlerpQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
  alpha: number,
  out: { x: number; y: number; z: number; w: number },
): void {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const sign = dot < 0 ? -1 : 1
  out.x = a[0] + (b[0] * sign - a[0]) * alpha
  out.y = a[1] + (b[1] * sign - a[1]) * alpha
  out.z = a[2] + (b[2] * sign - a[2]) * alpha
  out.w = a[3] + (b[3] * sign - a[3]) * alpha
  const len = Math.hypot(out.x, out.y, out.z, out.w)
  if (len > 1e-6) {
    out.x /= len
    out.y /= len
    out.z /= len
    out.w /= len
  }
}

/** Placeholder archetype visuals for resource nodes (root mesh at ground pos). */
function buildNodeVisual(
  scene: Scene,
  id: string,
  visual: 'tree' | 'rock' | 'scrap' | 'branches' | 'stones',
): Mesh {
  const root = CreateBox(`res:${id}:root`, { size: 0.01 }, scene)
  root.isVisible = false
  switch (visual) {
    case 'tree': {
      const trunk = CreateCylinder(`res:${id}`, { diameter: 0.6, height: 3.2 }, scene)
      trunk.position.y = 1.6
      trunk.material = materialFor(scene, '#6d4c2a')
      trunk.parent = root
      const canopy = CreateSphere(`res:${id}:canopy`, { diameter: 2.8, segments: 8 }, scene)
      canopy.material = materialFor(scene, '#3e6b34')
      canopy.parent = trunk
      canopy.position.y = 1.9
      break
    }
    case 'rock': {
      const rock = CreateBox(`res:${id}`, { width: 1.4, height: 1.1, depth: 1.4 }, scene)
      rock.position.y = 0.55
      rock.rotation.y = hashAngle(id)
      rock.material = materialFor(scene, '#7b7f83')
      rock.parent = root
      break
    }
    case 'scrap': {
      const pile = CreateBox(`res:${id}`, { width: 0.9, height: 0.5, depth: 0.9 }, scene)
      pile.position.y = 0.25
      pile.rotation.y = hashAngle(id)
      pile.material = materialFor(scene, '#5e6a70')
      pile.parent = root
      break
    }
    case 'branches': {
      const pile = CreateBox(`res:${id}`, { width: 0.85, height: 0.3, depth: 0.85 }, scene)
      pile.position.y = 0.15
      pile.rotation.y = hashAngle(id)
      pile.material = materialFor(scene, '#7a5a34')
      pile.parent = root
      break
    }
    case 'stones': {
      const pile = CreateBox(`res:${id}`, { width: 0.7, height: 0.28, depth: 0.7 }, scene)
      pile.position.y = 0.14
      pile.rotation.y = hashAngle(id)
      pile.material = materialFor(scene, '#8a8d90')
      pile.parent = root
      break
    }
  }
  return root
}

/** Deterministic pseudo-random yaw so identical piles don't look cloned. */
function hashAngle(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (h % 628) / 100
}

function setDepletedLook(root: Mesh, depleted: boolean): void {
  const value = depleted ? 0.3 : 1
  for (const child of root.getChildMeshes()) {
    ;(child as Mesh).visibility = value
  }
}

function toPhysicsShape(shape: WorldShape): ShapeDesc {
  switch (shape.type) {
    case 'box':
      return { type: 'box', size: shape.size }
    case 'cylinder':
      return { type: 'cylinder', radius: shape.radius, height: shape.height }
    case 'sphere':
      return { type: 'sphere', radius: shape.radius }
  }
}
