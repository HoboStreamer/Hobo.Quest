import HavokPhysics from '@babylonjs/havok'
import havokWasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url'
import {
  createContent,
  setMapOverride,
  type MapLight,
  compileMapFileV2,
  parseMapFile,
  type MapTextureEntry,
} from '@hobo/content'
import { createHavokWorldForScene } from '@hobo/physics/havok'
import { FixedTimestep } from '@hobo/shared'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Appearance } from '@hobo/protocol'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Scene } from '@babylonjs/core/scene.js'
import { WATER_LEVEL } from '@hobo/content'
import { InteractionController } from './game/interactionController.js'
import { LocalPlayer } from './game/localPlayer.js'
import { InputTracker } from './input/inputTracker.js'
import { Connection, gameSocketUrl, getIdentity, saveName } from './net/connection.js'
import { BeamRenderer, type BeamState } from './render/beams.js'
import { EntityView } from './render/entityView.js'
import { Environment } from './render/environment.js'
import { FirstPersonBody } from './render/firstPersonBody.js'
import {
  buildStaticWorld,
  createEngine,
  createScene,
  buildTerrainPatches,
  rebuildTerrainPatchVisuals,
  registerMapAssets,
  rebuildTerrainVisual,
} from './render/sceneSetup.js'
import { buildMapLights } from './render/mapStyle.js'
import { Viewmodel } from './render/viewmodel.js'
import { ClientState } from './state/clientState.js'
import { characterSelect, type CharacterInfo } from './ui/characterSelect.js'
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
  // Edited map (must match the server's copy for prediction parity).
  let mapLightsBoot: MapLight[] | undefined
  try {
    // /map.json is native v2. parseMapFile still accepts a legacy v1 file
    // and migrates it, so old artifacts keep working — one direction only.
    const parsed = parseMapFile(await (await fetch('/map.json')).json())
    if (parsed.ok) {
      registerMapAssets({
        textures: parsed.map.textures as MapTextureEntry[],
        models: parsed.map.models,
      })
      setMapOverride(compileMapFileV2(parsed.map))
      content.world.statics.push(...parsed.map.statics)
      mapLightsBoot = parsed.map.lights
    }
  } catch {
    // no edited map — procedural terrain
  }
  const engine = await createEngine(canvas)
  const scene = createScene(engine)
  buildStaticWorld(scene, content)
  buildTerrainPatches(scene, content)
  buildMapLights(scene, mapLightsBoot)

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

  // MMO-style character select: pick an existing drifter or claim a slot.
  // hobo.tools SSO: a session token can arrive via ?hobo_token= (redirect
  // back from hobo.tools) and is remembered; guests play without one.
  const ssoParam = new URLSearchParams(location.search).get('hobo_token')
  if (ssoParam) {
    localStorage.setItem('hq_sso', ssoParam)
    history.replaceState(null, '', location.pathname)
  }
  const ssoCookie = document.cookie
    .split('; ')
    .find((c) => c.startsWith('hq_sso='))
    ?.slice('hq_sso='.length)
  const sso =
    localStorage.getItem('hq_sso') ?? (ssoCookie ? decodeURIComponent(ssoCookie) : undefined)
  let characters: CharacterInfo[] = []
  try {
    const q = `token=${encodeURIComponent(identity.token)}${sso ? `&auth=${encodeURIComponent(sso)}` : ''}`
    characters = (await (await fetch(`/api/characters?${q}`)).json()) as CharacterInfo[]
  } catch {
    characters = []
  }
  const choice = await characterSelect(uiRoot, characters, Boolean(sso))
  let name: string
  let appearance: Appearance
  let releaseCamera: () => void
  if (choice.existing?.appearance) {
    name = choice.existing.name
    appearance = { ...choice.existing.appearance, height: 1, build: 1 }
    releaseCamera = () => {}
  } else {
    const created = await customizeScreen(scene, content, uiRoot, identity.name, !sso)
    name = created.name
    appearance = created.appearance
    releaseCamera = created.releaseCamera
  }
  const slot = choice.slot
  saveName(name)

  const havok = await havokPromise
  const physics = createHavokWorldForScene(scene, havok)
  const { buildStaticPhysics, rebuildTerrainPhysics } = await import('./game/staticPhysics.js')
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
  interact.onShopOpen = () => hud.openShop()
  input.onWheel = (delta) => interact.onWheel(delta)

  state.events.on('actionResult', (r) => {
    if (r.action === 'use' && r.ok && interact.lastTargetWasPlayer) {
      interact.lastTargetWasPlayer = false
      hud.flashHitmarker()
    }
  })
  let rejected = false
  connection.onMessage = (msg) => {
    state.apply(msg)
    if (msg.t === 'map_reload') {
      void (async () => {
        try {
          const parsed = parseMapFile(await (await fetch('/map.json')).json())
          if (parsed.ok) {
            registerMapAssets({
              textures: parsed.map.textures as MapTextureEntry[],
              models: parsed.map.models,
            })
            setMapOverride(compileMapFileV2(parsed.map))
            rebuildTerrainPhysics(physics, content)
            rebuildTerrainVisual(scene, content)
            rebuildTerrainPatchVisuals(scene, content)
            buildMapLights(scene, parsed.map.lights)
          }
        } catch {
          // keep the old terrain if the fetch fails
        }
      })()
    }
    if (msg.t === 'time') environment.setDayFraction(msg.frac)
    if (msg.t === 'snap') {
      player.onSnapshot(msg)
      view.onSnapshot(msg, performance.now() / 1000)
    } else if (msg.t === 'reject') {
      rejected = true
      if (msg.reason === 'protocol_mismatch') {
        // A stale cached bundle is talking to a newer server. A reload
        // revalidates the page and pulls the new client. Guard against a
        // reload loop if something still pins the old version.
        const last = Number(localStorage.getItem('hq_reload_ts') ?? '0')
        if (Date.now() - last > 60_000) {
          localStorage.setItem('hq_reload_ts', String(Date.now()))
          hud.setStatus('game updated — loading the new version…')
          hud.toast('Game updated! Reloading…', false)
          setTimeout(() => location.reload(), 1200)
        } else {
          hud.setStatus('version mismatch — hard-refresh (Ctrl+Shift+R) to update')
        }
      } else if (msg.reason === 'invalid_hello') {
        // Something we sent no longer fits the server's schema (stale
        // saved session/appearance). Shed the stored state and retry once.
        localStorage.removeItem('hq_sso')
        document.cookie = 'hq_sso=; Path=/; Max-Age=0'
        localStorage.removeItem('hobo.appearance')
        const last = Number(localStorage.getItem('hq_reload_ts') ?? '0')
        if (Date.now() - last > 60_000) {
          localStorage.setItem('hq_reload_ts', String(Date.now()))
          hud.setStatus('session data was out of date — reloading…')
          setTimeout(() => location.reload(), 1200)
        } else {
          hud.setStatus('could not join — try signing in again from the home page')
        }
      } else if (msg.reason === 'guest_one_character') {
        hud.setStatus('guests get one character — sign in with hobo.tools for 3 slots')
      } else if (msg.reason === 'auth_failed') {
        localStorage.removeItem('hq_sso')
        hud.setStatus('hobo.tools sign-in expired — refresh to continue as guest or sign in again')
      } else {
        hud.setStatus(`rejected: ${msg.reason} — refresh the page`)
      }
    }
  }
  connection.onClose = () => {
    if (rejected) return
    // Deploys restart the server; come back on our own instead of
    // freezing on a dead socket. Reload = full clean resync.
    hud.setStatus('connection lost — reconnecting automatically…')
    hud.toast('Disconnected — reconnecting…', true)
    const poll = setInterval(() => {
      fetch('/healthz')
        .then((r) => {
          if (r.ok) {
            clearInterval(poll)
            location.reload()
          }
        })
        .catch(() => {})
    }, 2000)
  }

  hud.setStatus('connecting…')
  try {
    await connection.connect(gameSocketUrl(), identity.token, name, appearance, slot, sso)
  } catch {
    hud.setStatus('could not reach server — is it running?')
    return
  }

  let wasSubmerged = false

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
      player.viewDir(_viewFwd)
      _viewFwdV.set(_viewFwd.x, _viewFwd.y, _viewFwd.z)
      if (heldPos) {
        activeBeams.set(state.myEntityId, {
          from: viewmodel.beamOrigin(),
          to: heldPos,
          tangent: _viewFwdV,
          latched: true,
        })
      } else {
        interact.beamTarget(_beamEnd)
        _beamEndV.set(_beamEnd.x, _beamEnd.y, _beamEnd.z)
        activeBeams.set(state.myEntityId, {
          from: viewmodel.beamOrigin(),
          to: _beamEndV,
          tangent: _viewFwdV,
          latched: false,
        })
      }
    }
    beams.update(elapsed, activeBeams)

    // Underwater: dense teal fog while the camera is submerged.
    const submerged = player.camera.position.y < WATER_LEVEL
    if (submerged !== wasSubmerged) {
      wasSubmerged = submerged
      if (submerged) {
        scene.fogMode = Scene.FOGMODE_EXP2
        scene.fogDensity = 0.09
        scene.fogColor = new Color3(0.08, 0.25, 0.3)
      } else {
        scene.fogMode = Scene.FOGMODE_NONE
      }
    }

    hud.setPrompt(promptFor(interact, content, state))
    hud.setStatus(
      `${name} · tick ${state.serverTick} · ${engine.getFps().toFixed(0)} fps · ${state.entities.size} entities`,
    )
  }
}

const _beamEnd = { x: 0, y: 0, z: 0 }
const _beamEndV = new Vector3()
const _viewFwd = { x: 0, y: 0, z: 0 }
const _viewFwdV = new Vector3()

/** Context-sensitive crosshair prompt based on aim target + equipped tool. */
function promptFor(
  interact: InteractionController,
  content: ReturnType<typeof createContent>,
  state: ClientState,
): string | null {
  const target = interact.aim()
  const tool = interact.equippedToolKind()
  if (!target) {
    if (interact.standingInWater()) return 'E — drink'
    return null
  }
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
    if (target.def && content.item(target.def)?.door && target.frozen) {
      return 'E — open / close door'
    }
    if (target.def && content.item(target.def)?.shop) {
      return 'E — trade with the merchant'
    }
    if (target.def && content.item(target.def)?.planter) {
      const entity = state.entities.get(target.entityId)
      if (entity?.plant) {
        const done = Date.now() - entity.plant.plantedAt >= entity.plant.growSeconds * 1000
        return done ? 'E — harvest' : '🌱 growing…'
      }
      const held = state.activeItemDef()
      if (held && content.item(held)?.seed) return 'E — plant seeds'
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
