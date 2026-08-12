/**
 * Editor navigation.
 *
 * Babylon's own camera inputs are cleared: they fight the editor's action
 * system for the same keys and cannot be remapped, and their wheel handler
 * dollies along the view axis regardless of what is under the cursor. All
 * movement comes from here, driven by the centralised bindings.
 *
 * Three rules the previous handling broke:
 *  - MMB uses POINTER CAPTURE, so a drag keeps working past the canvas edge
 *    and the browser's middle-click autoscroll never appears.
 *  - Nothing moves while another gesture owns the pointer, so a gizmo drag
 *    cannot also orbit the camera.
 *  - The wheel zooms toward what is UNDER the cursor, not toward the centre
 *    of the screen, and scales its step by distance so approaching a small
 *    object does not overshoot it.
 */
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { InteractionController } from '../interaction/interactionController.js'

export interface CameraControllerOptions {
  scene: Scene
  camera: FreeCamera
  canvas: HTMLCanvasElement
  interaction: InteractionController
  /** True while the named binding's key is held (centralised bindings). */
  holding: (action: string) => boolean
  /**
   * True when the wheel belongs to something else — a placement preview
   * rotating, a brush radius. The context is the tool's, not the camera's.
   */
  wheelIsClaimed: () => boolean
}

/** Distance used when the cursor is over empty space. */
const FALLBACK_FOCUS = 40
const MIN_DOLLY = 0.25
const MAX_DOLLY = 400

export class EditorCameraController {
  private freeLook = false
  private mmb: 'orbit' | 'pan' | null = null
  private lastX = 0
  private lastY = 0
  private readonly disposers: (() => void)[] = []

  constructor(private readonly opts: CameraControllerOptions) {
    const { camera, canvas } = opts
    camera.minZ = 0.1
    // No Babylon camera inputs at all — nothing to fight with, and every
    // movement key stays remappable.
    camera.inputs.clear()

    this.on(document, 'pointerlockchange', () => {
      this.freeLook = document.pointerLockElement === canvas
    })
    // Suppress the browser's middle-click autoscroll before it starts.
    this.on(canvas, 'mousedown', (e) => {
      if ((e as MouseEvent).button === 1) e.preventDefault()
    })
    this.on(canvas, 'auxclick', (e) => e.preventDefault())
    this.on(canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent))
    this.on(canvas, 'pointerup', (e) => this.onPointerUp(e as PointerEvent))
    this.on(canvas, 'pointermove', (e) => this.onPointerMove(e as PointerEvent))
    this.on(canvas, 'mousemove', (e) => this.onMouseMove(e as MouseEvent))
    this.on(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false })
  }

  private on(
    target: EventTarget,
    type: string,
    fn: (e: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, options)
    this.disposers.push(() => target.removeEventListener(type, fn, options))
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.disposers.length = 0
  }

  get isFreeLook(): boolean {
    return this.freeLook
  }

  get isDragging(): boolean {
    return this.mmb !== null
  }

  toggleFreeLook(): void {
    if (this.freeLook) document.exitPointerLock()
    else void this.opts.canvas.requestPointerLock()
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 1) return
    e.preventDefault()
    const want = this.opts.holding('cam.pan') || e.shiftKey ? 'pan' : 'orbit'
    // The camera is a gesture like any other: it must claim the pointer, and
    // it cannot start while a gizmo or brush gesture owns it.
    if (
      !this.opts.interaction.begin(want === 'pan' ? 'camera-pan' : 'camera-orbit', {
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
      })
    )
      return
    this.mmb = want
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.opts.canvas.setPointerCapture(e.pointerId)
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button !== 1) return
    if (this.mmb) this.opts.interaction.end()
    this.mmb = null
    if (this.opts.canvas.hasPointerCapture(e.pointerId))
      this.opts.canvas.releasePointerCapture(e.pointerId)
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.mmb || !this.opts.interaction.cameraMayMove()) return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    const { camera } = this.opts
    if (this.mmb === 'orbit') {
      camera.rotation.y += dx * 0.0038
      camera.rotation.x = clamp(camera.rotation.x + dy * 0.0038, -1.5, 1.5)
      return
    }
    const right = camera.getDirection(new Vector3(1, 0, 0))
    const up = camera.getDirection(new Vector3(0, 1, 0))
    camera.position.addInPlace(right.scale(-dx * 0.05))
    camera.position.addInPlace(up.scale(dy * 0.05))
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.freeLook || !this.opts.interaction.cameraMayMove()) return
    const { camera } = this.opts
    camera.rotation.y += e.movementX * 0.0032
    camera.rotation.x = clamp(camera.rotation.x + e.movementY * 0.0032, -1.5, 1.5)
  }

  /**
   * Cursor-centric dolly. Picks the point under the cursor and moves along
   * the ray toward it, so the thing you are looking at stays put and grows —
   * which is what makes approaching a doorway feel aimed rather than
   * approximate. Step scales with distance and clamps at both ends.
   */
  private onWheel(e: WheelEvent): void {
    if (this.opts.wheelIsClaimed()) return
    e.preventDefault()
    const { scene, camera } = this.opts
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m: AbstractMesh) => m.isPickable)
    const target =
      pick?.hit && pick.pickedPoint
        ? pick.pickedPoint
        : camera.position.add(camera.getDirection(Vector3.Forward()).scale(FALLBACK_FOCUS))
    const toTarget = target.subtract(camera.position)
    const distance = toTarget.length()
    if (distance < 1e-3) return
    const dir = toTarget.scale(1 / distance)
    // Fraction of the remaining distance, so far things move fast and near
    // things creep. Clamped so a trackpad flick cannot jump through a wall.
    const step = clamp(distance * 0.18, MIN_DOLLY, MAX_DOLLY)
    const sign = e.deltaY < 0 ? 1 : -1
    // Never quite arrive: stopping short keeps the pivot in front of you.
    if (sign > 0 && distance - step < MIN_DOLLY) return
    camera.position.addInPlace(dir.scale(step * sign))
  }

  /** Frame a world-space bounding sphere (F, Outliner focus). */
  frame(centre: Vector3, radius: number): void {
    const { camera } = this.opts
    const dist = Math.max(3, radius * 2.6)
    const back = camera.getDirection(Vector3.Forward()).scale(-dist)
    camera.position.copyFrom(centre.add(back))
  }

  /** Fly step for the movement actions, in world units for this frame. */
  fly(forward: number, right: number, up: number, speed: number): void {
    const { camera } = this.opts
    const f = camera.getDirection(Vector3.Forward())
    // Horizontal flight: pitching down must not drive you into the ground.
    f.y = 0
    if (f.lengthSquared() > 1e-6) f.normalize()
    const r = camera.getDirection(Vector3.Right())
    r.y = 0
    if (r.lengthSquared() > 1e-6) r.normalize()
    camera.position.addInPlace(f.scale(forward * speed))
    camera.position.addInPlace(r.scale(right * speed))
    camera.position.y += up * speed
  }

  /**
   * Project a world point to PAGE pixels.
   *
   * The canvas fills the viewport grid cell, not the window, so its own
   * coordinate space starts at the cell's top-left. Anything that wants to
   * put a cursor or a DOM element at a world position needs page
   * coordinates, so the offset is added here rather than at each call site
   * (which is how it went wrong: a projection that is right in canvas space
   * and used as a page position is silently off by the width of a panel).
   */
  worldToScreen(p: Vector3): [number, number] {
    const { scene } = this.opts
    const engine = scene.getEngine()
    const r = Vector3.Project(
      p,
      Matrix.Identity(),
      scene.getTransformMatrix(),
      this.opts.camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()),
    )
    const rect = this.opts.canvas.getBoundingClientRect()
    return [Math.round(r.x + rect.left), Math.round(r.y + rect.top)]
  }

  /** Page pixels → canvas pixels, the inverse of `worldToScreen`. */
  toCanvasSpace(pageX: number, pageY: number): [number, number] {
    const rect = this.opts.canvas.getBoundingClientRect()
    return [pageX - rect.left, pageY - rect.top]
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
