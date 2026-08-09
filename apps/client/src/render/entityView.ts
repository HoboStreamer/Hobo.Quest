import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { Quaternion } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateCapsule } from '@babylonjs/core/Meshes/Builders/capsuleBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import type { ContentRegistry, WorldShape } from '@hobo/content'
import { DEFAULT_MOVEMENT } from '@hobo/gameplay'
import { CollisionLayer, type BodyId, type PhysicsWorld, type ShapeDesc } from '@hobo/physics'
import type { ServerSnapshot, WireEntity } from '@hobo/protocol'
import { quat, vec3 } from '@hobo/shared'
import type { ClientState } from '../state/clientState.js'
import { materialFor, meshForShape } from './sceneSetup.js'

/**
 * Maintains the renderable + collidable view of replicated entities:
 * meshes for drawing, mirror physics bodies (static) so local prediction
 * and aim raycasts collide with replicated props, and interpolation
 * buffers so remote motion renders smoothly between snapshots.
 */

interface InterpSample {
  t: number
  pos: [number, number, number]
  rot: [number, number, number, number]
}

interface EntityVisual {
  entity: WireEntity
  mesh: Mesh
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

  private add(e: WireEntity): void {
    if (e.id === this.state.myEntityId) return // first-person: no self mesh
    if (this.visuals.has(e.id)) return

    let mesh: Mesh
    let bodyId: BodyId | null = null
    if (e.kind === 'player') {
      mesh = CreateCapsule(
        `player:${e.id}`,
        { radius: DEFAULT_MOVEMENT.capsuleRadius, height: DEFAULT_MOVEMENT.capsuleHeight },
        this.scene,
      )
      mesh.material = materialFor(this.scene, '#c08a50')
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
      // Resource node: a low rubble pile, color hinted by the item it yields.
      mesh = CreateBox(`res:${e.id}`, { width: 0.9, height: 0.5, depth: 0.9 }, this.scene)
      const color = e.def === 'wood_plank' ? '#8a6a3a' : '#6a7a85'
      mesh.material = materialFor(this.scene, color)
      bodyId = this.physics.addBody({
        shape: { type: 'box', size: [0.9, 0.5, 0.9] },
        motion: 'static',
        pos: vec3(e.pos[0], e.pos[1], e.pos[2]),
        layer: CollisionLayer.Prop,
        collidesWith: CollisionLayer.Player,
      })
    }
    mesh.position.set(e.pos[0], e.pos[1], e.pos[2])
    mesh.rotationQuaternion = new Quaternion(e.rot[0], e.rot[1], e.rot[2], e.rot[3])

    if (bodyId !== null) this.entityByBody.set(bodyId, e.id)
    this.visuals.set(e.id, { entity: e, mesh, bodyId, buffer: [] })
  }

  private remove(id: string): void {
    const v = this.visuals.get(id)
    if (!v) return
    v.mesh.dispose()
    if (v.bodyId !== null) {
      this.physics.removeBody(v.bodyId)
      this.entityByBody.delete(v.bodyId)
    }
    this.visuals.delete(id)
  }

  /** Authoritative transform pin (freeze/settle/unfreeze corrections). */
  private applyAuthoritative(e: WireEntity): void {
    const v = this.visuals.get(e.id)
    if (!v) return
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
        rot: yawToQuat(p.yaw),
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

  /** Per-frame: interpolate meshes toward buffered samples. */
  update(localTime: number): void {
    if (this.clockOffset === null) return
    const renderTime = localTime + this.clockOffset - INTERP_DELAY
    for (const v of this.visuals.values()) {
      if (v.buffer.length === 0) continue
      sampleBuffer(v.buffer, renderTime, _pos, _rot)
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
    return this.visuals.get(id)?.mesh.position ?? null
  }
}

const HELD_GLOW = new Color3(0.25, 0.35, 0.5)
const NO_GLOW = new Color3(0, 0, 0)

function pushSample(buffer: InterpSample[], sample: InterpSample): void {
  buffer.push(sample)
  // Keep ~0.6s of history.
  while (buffer.length > 12) buffer.shift()
}

function sampleBuffer(
  buffer: InterpSample[],
  t: number,
  outPos: { x: number; y: number; z: number },
  outRot: { x: number; y: number; z: number; w: number },
): void {
  const newest = buffer[buffer.length - 1] as InterpSample
  const oldest = buffer[0] as InterpSample
  let a = oldest
  let b = newest
  if (t <= oldest.t) {
    b = oldest
  } else if (t >= newest.t) {
    a = newest
  } else {
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
  const alpha = span > 1e-6 ? (t - a.t) / span : 1
  outPos.x = a.pos[0] + (b.pos[0] - a.pos[0]) * alpha
  outPos.y = a.pos[1] + (b.pos[1] - a.pos[1]) * alpha
  outPos.z = a.pos[2] + (b.pos[2] - a.pos[2]) * alpha
  // nlerp is fine at snapshot rates.
  const dot = a.rot[0] * b.rot[0] + a.rot[1] * b.rot[1] + a.rot[2] * b.rot[2] + a.rot[3] * b.rot[3]
  const sign = dot < 0 ? -1 : 1
  outRot.x = a.rot[0] + (b.rot[0] * sign - a.rot[0]) * alpha
  outRot.y = a.rot[1] + (b.rot[1] * sign - a.rot[1]) * alpha
  outRot.z = a.rot[2] + (b.rot[2] * sign - a.rot[2]) * alpha
  outRot.w = a.rot[3] + (b.rot[3] * sign - a.rot[3]) * alpha
  const len = Math.hypot(outRot.x, outRot.y, outRot.z, outRot.w)
  if (len > 1e-6) {
    outRot.x /= len
    outRot.y /= len
    outRot.z /= len
    outRot.w /= len
  }
}

function yawToQuat(yaw: number): [number, number, number, number] {
  const half = yaw * 0.5
  return [0, Math.sin(half), 0, Math.cos(half)]
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
