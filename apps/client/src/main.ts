import HavokPhysics from '@babylonjs/havok'
import havokWasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url'
import { createContent } from '@hobo/content'
import { createHavokWorldForScene } from '@hobo/physics/havok'
import { FixedTimestep } from '@hobo/shared'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { InteractionController } from './game/interactionController.js'
import { LocalPlayer } from './game/localPlayer.js'
import { InputTracker } from './input/inputTracker.js'
import { Connection, gameSocketUrl, getIdentity, saveName } from './net/connection.js'
import { BeamRenderer, type BeamState } from './render/beams.js'
import { EntityView } from './render/entityView.js'
import { Environment } from './render/environment.js'
import { FirstPersonBody } from './render/firstPersonBody.js'
import { buildStaticWorld, createEngine, createScene } from './render/sceneSetup.js'
import { Viewmodel } from './render/viewmodel.js'
import { ClientState } from './state/clientState.js'
import { customizeScreen } from './ui/customizeScreen.js'
import { Hud } from './ui/hud.js'
import { IconFactory } from './ui/iconFactory.js'
import { registerPhysgunModule } from './weapons/physgunModule.js'
import { WeaponSettings, weaponModuleFor } from './weapons/registry.js'

/**
 * Client bootstrap: engine/scene -> character customization (live preview)
 * -> connect -> fixed-timestep prediction + interpolated render loop with
 * first-person body, viewmodel and physgun beams.
 */
async function start(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const uiRoot = document.getElementById('ui') as HTMLElement

  const identity = getIdentity()
  const content = createContent()
  const engine = await createEngine(canvas)
  const scene = createScene(engine)
  buildStaticWorld(scene, content)

  // Havok loads while the player customizes their character.
  const havokPromise = HavokPhysics({ locateFile: () => havokWasmUrl })

  const environment = new Environment(scene, engine)

  // Render immediately so the customization preview is live.
  let gameLoop: (() => void) | null = null
  let last = performance.now()
  let envLast = performance.now()
  engine.runRenderLoop(() => {
    gameLoop?.()
    if (scene.activeCamera) {
      const now = performance.now()
      environment.update(Math.min((now - envLast) / 1000, 0.25), scene.activeCamera.globalPosition)
      envLast = now
      scene.render()
    }
  })
  window.addEventListener('resize', () => engine.resize())
  // Ctrl+W while crouching would close the tab; the browser won't let us
  // block the shortcut itself, but it will show a leave confirmation.
  window.addEventListener('beforeunload', (e) => {
    e.preventDefault()
  })

  const { name, appearance, releaseCamera } = await customizeScreen(
    scene,
    content,
    uiRoot,
    identity.name,
  )
  saveName(name)

  const havok = await havokPromise
  const physics = createHavokWorldForScene(scene, havok)
  const { buildStaticPhysics } = await import('./game/staticPhysics.js')
  buildStaticPhysics(physics, content)

  const state = new ClientState()
  const connection = new Connection()
  const input = new InputTracker(canvas)
  const view = new EntityView(scene, physics, content, state)
  const icons = new IconFactory(scene, content)
  const weaponSettings = new WeaponSettings()
  registerPhysgunModule()
  const hud = new Hud(uiRoot, state, content, connection, icons, weaponSettings)

  const world = content.world
  const player = new LocalPlayer(scene, physics, input, connection, state, {
    x: world.spawnPoint[0],
    y: world.spawnPoint[1],
    z: world.spawnPoint[2],
  })
  scene.activeCamera = player.camera
  releaseCamera()
  environment.attachCamera(player.camera)
  const interact = new InteractionController(
    physics,
    player,
    view,
    state,
    content,
    connection,
    input,
    weaponSettings,
  )
  // Debug handles for the automated visual/E2E harness.
  ;(window as unknown as Record<string, unknown>).__hobo = {
    input,
    interact,
    state,
    connection,
    player,
    icons,
  }
  const fpBody = new FirstPersonBody(scene, content, appearance, player, state)
  const viewmodel = new Viewmodel(scene, content, player.camera, appearance)
  const beams = new BeamRenderer(scene)

  interact.onSwing = () => {
    viewmodel.triggerSwing()
    fpBody.triggerSwing()
  }

  hud.onUiCaptureChange = (captured) => {
    input.uiCapture = captured
    if (captured) input.exitLock()
    else input.requestLock() // straight back into the game when the menu closes
  }
  input.onAction = (action) => {
    switch (action.kind) {
      case 'toggle_menu':
        hud.toggleMenu()
        return
      case 'hotbar1':
      case 'hotbar2':
      case 'hotbar3':
      case 'hotbar4':
      case 'hotbar5':
      case 'hotbar6': {
        const slot = Number(action.kind.slice(-1)) - 1
        connection.send({ t: 'hotbar', slot })
        // Mirror the server's toggle rules: same slot = holster/unholster.
        if (slot === state.activeHotbar) {
          state.holstered = !state.holstered
        } else {
          state.activeHotbar = slot
          state.holstered = false
        }
        interact.onHotbarChanged()
        hud.renderHotbar()
        return
      }
      default:
        interact.handle(action)
    }
  }
  input.onWheel = (delta) => interact.onWheel(delta)

  connection.onMessage = (msg) => {
    state.apply(msg)
    if (msg.t === 'time') environment.setDayFraction(msg.frac)
    if (msg.t === 'snap') {
      player.onSnapshot(msg)
      view.onSnapshot(msg, performance.now() / 1000)
    } else if (msg.t === 'reject') {
      hud.setStatus(`rejected: ${msg.reason} — refresh the page`)
    }
  }
  connection.onClose = () => {
    hud.setStatus('disconnected — refresh to reconnect')
    hud.toast('Disconnected from server', true)
  }

  hud.setStatus('connecting…')
  try {
    await connection.connect(gameSocketUrl(), identity.token, name, appearance)
  } catch {
    hud.setStatus('could not reach server — is it running?')
    return
  }

  // Fixed-timestep prediction; interpolated rendering.
  const timestep = new FixedTimestep(1 / state.tickRate)
  gameLoop = () => {
    const now = performance.now()
    const elapsed = Math.min((now - last) / 1000, 0.25)
    last = now
    if (!connection.open || !state.myEntityId) return

    const steps = timestep.consume(elapsed)
    for (let i = 0; i < steps; i++) {
      player.fixedUpdate()
      interact.flushTick()
    }
    physics.step(0) // query-only world: refresh broadphase, no dynamics
    player.frameUpdate(timestep.alpha, elapsed)
    view.update(now / 1000)

    // First-person presentation: body, viewmodel, beams.
    const selfHolding = [...state.heldBy.values()].includes(state.myEntityId)
    fpBody.update(elapsed, now / 1000, player.renderPos, selfHolding)
    const speed = Math.hypot(player.move.vel.x, player.move.vel.z)
    const look = input.consumeLookDelta()
    viewmodel.setItem(state.activeItemDef())
    viewmodel.update(elapsed, speed, player.move.grounded, look.dx, look.dy)

    // Beams (modular: any weapon whose module declares firesBeam gets this
    // muzzle-anchored beam pipeline). Mine fires whenever the trigger is
    // held (dim searching ray → bright latched beam anchored to the exact
    // grab point); other players' render only while they hold props.
    const activeBeams = new Map<string, BeamState>()
    for (const [target, holder] of state.heldBy) {
      if (holder === state.myEntityId) continue
      const to = view.grabPointOf(target, state.heldGrab.get(holder))
      const from = view.avatarFor(holder)?.beamOrigin()
      if (from && to) activeBeams.set(holder, { from, to, latched: true })
    }
    const activeModule = weaponModuleFor(interact.equippedToolKind())
    if (activeModule?.firesBeam && interact.physgunActive) {
      const heldTarget = [...state.heldBy.entries()].find(
        ([, holder]) => holder === state.myEntityId,
      )?.[0]
      const heldPos = heldTarget
        ? view.grabPointOf(heldTarget, state.heldGrab.get(state.myEntityId))
        : null
      if (heldPos) {
        activeBeams.set(state.myEntityId, {
          from: viewmodel.beamOrigin(),
          to: heldPos,
          latched: true,
        })
      } else {
        interact.beamTarget(_beamEnd)
        _beamEndV.set(_beamEnd.x, _beamEnd.y, _beamEnd.z)
        activeBeams.set(state.myEntityId, {
          from: viewmodel.beamOrigin(),
          to: _beamEndV,
          latched: false,
        })
      }
    }
    beams.update(elapsed, activeBeams)

    hud.setPrompt(promptFor(interact, content, state))
    hud.setStatus(
      `${name} · tick ${state.serverTick} · ${engine.getFps().toFixed(0)} fps · ${state.entities.size} entities`,
    )
  }
}

const _beamEnd = { x: 0, y: 0, z: 0 }
const _beamEndV = new Vector3()

/** Context-sensitive crosshair prompt based on aim target + equipped tool. */
function promptFor(
  interact: InteractionController,
  content: ReturnType<typeof createContent>,
  state: ClientState,
): string | null {
  const target = interact.aim()
  const tool = interact.equippedToolKind()
  if (!target) return null
  if (target.kind === 'resource') {
    const nodeType = content.nodeType(target.def ?? '')
    if (!nodeType) return null
    const itemName = content.item(nodeType.item)?.name ?? nodeType.item
    if (nodeType.requiredTool && tool !== nodeType.requiredTool) {
      return `LMB — hit for ${itemName} (much faster with ${nodeType.requiredTool})`
    }
    if (nodeType.requiredTool) return `LMB — harvest ${itemName}`
    return `E — gather ${itemName}`
  }
  if (target.kind === 'player') {
    const entity = state.entities.get(target.entityId)
    return `${entity?.name ?? 'drifter'}${tool && tool !== 'physgun' ? ' — LMB attack' : ''}`
  }
  if (target.kind === 'prop') {
    if (target.def && content.item(target.def)?.container) {
      return 'E — open storage'
    }
    if (interact.physgunActive)
      return 'RMB — freeze · E — rotate · Shift — grid · wheel — push/pull'
    const entity = state.entities.get(target.entityId)
    const owned = entity?.owner !== undefined && entity.owner !== state.myPlayerId
    if (owned) return 'Owned by another player'
    const itemName = content.item(target.def ?? '')?.name ?? 'prop'
    if (tool === 'physgun')
      return `Hold LMB — grab${target.frozen ? ' (unfreezes)' : ''} · E — pick up`
    return `E — pick up ${itemName}`
  }
  return null
}

start().catch((err: unknown) => {
  console.error('client fatal:', err)
  const status = document.createElement('div')
  status.className = 'status'
  status.textContent = `fatal: ${String(err)}`
  document.getElementById('ui')?.appendChild(status)
})
