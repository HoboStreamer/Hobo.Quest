import HavokPhysics from '@babylonjs/havok'
import havokWasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url'
import { createContent } from '@hobo/content'
import { createHavokWorldForScene } from '@hobo/physics/havok'
import { FixedTimestep } from '@hobo/shared'
import { InteractionController } from './game/interactionController.js'
import { LocalPlayer } from './game/localPlayer.js'
import { InputTracker } from './input/inputTracker.js'
import { Connection, gameSocketUrl, getIdentity, saveName } from './net/connection.js'
import { EntityView } from './render/entityView.js'
import { buildStaticWorld, createEngine, createScene } from './render/sceneSetup.js'
import { ClientState } from './state/clientState.js'
import { Hud } from './ui/hud.js'

/**
 * Client bootstrap: name screen -> engine/scene/physics -> connect ->
 * fixed-timestep prediction loop + render loop.
 */
async function start(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const uiRoot = document.getElementById('ui') as HTMLElement

  const identity = getIdentity()
  const name = await nameScreen(uiRoot, identity.name)
  saveName(name)

  const content = createContent()
  const engine = await createEngine(canvas)
  const scene = createScene(engine)
  buildStaticWorld(scene, content)

  const havok = await HavokPhysics({ locateFile: () => havokWasmUrl })
  const physics = createHavokWorldForScene(scene, havok)
  // Mirror the server's static collision world for prediction sweeps.
  const { buildStaticPhysics } = await import('./game/staticPhysics.js')
  buildStaticPhysics(physics, content)

  const state = new ClientState()
  const connection = new Connection()
  const input = new InputTracker(canvas)
  const view = new EntityView(scene, physics, content, state)
  const hud = new Hud(uiRoot, state, content, connection)

  const world = content.world
  const player = new LocalPlayer(scene, physics, input, connection, state, {
    x: world.spawnPoint[0],
    y: world.spawnPoint[1],
    z: world.spawnPoint[2],
  })
  const interact = new InteractionController(physics, player, view, state, content, connection)

  hud.onUiCaptureChange = (captured) => {
    input.uiCapture = captured
    if (captured) input.exitLock()
  }
  input.onAction = (action) => {
    switch (action.kind) {
      case 'toggle_inventory':
        hud.toggleInventory()
        return
      case 'toggle_craft':
        hud.toggleCraft()
        return
      case 'toggle_skills':
        hud.toggleSkills()
        return
      case 'toggle_players':
        hud.togglePlayers()
        return
      case 'hotbar1':
      case 'hotbar2':
      case 'hotbar3':
      case 'hotbar4':
      case 'hotbar5':
      case 'hotbar6': {
        const slot = Number(action.kind.slice(-1)) - 1
        connection.send({ t: 'hotbar', slot })
        state.activeHotbar = slot // optimistic; server echoes via inventory msg
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
    await connection.connect(gameSocketUrl(), identity.token, name)
  } catch {
    hud.setStatus('could not reach server — is it running?')
    return
  }

  // Fixed-timestep prediction; interpolated rendering.
  const timestep = new FixedTimestep(1 / state.tickRate)
  let last = performance.now()
  engine.runRenderLoop(() => {
    const now = performance.now()
    const elapsed = Math.min((now - last) / 1000, 0.25)
    last = now

    if (connection.open && state.myEntityId) {
      const steps = timestep.consume(elapsed)
      for (let i = 0; i < steps; i++) {
        player.fixedUpdate()
        interact.flushTick()
      }
      physics.step(0) // query-only world: refresh broadphase, no dynamics
      player.frameUpdate(timestep.alpha)
      view.update(now / 1000)

      hud.setPrompt(promptFor(interact, content, state))
      hud.setStatus(
        `${name} · tick ${state.serverTick} · ${engine.getFps().toFixed(0)} fps · ${state.entities.size} entities`,
      )
    }
    scene.render()
  })

  window.addEventListener('resize', () => engine.resize())
}

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
      return `${nodeType.name} — requires ${nodeType.requiredTool}`
    }
    if (nodeType.requiredTool) return `LMB — harvest ${itemName}`
    return `E — gather ${itemName}`
  }
  if (target.kind === 'prop') {
    const entity = state.entities.get(target.entityId)
    const owned = entity?.owner !== undefined && entity.owner !== state.myPlayerId
    const suffix = owned ? ' · owned by another player' : ''
    if (tool === 'physgun') {
      return (target.frozen ? 'LMB — grab · Q — unfreeze' : 'Hold LMB — grab') + suffix
    }
    if (owned) return 'Owned by another player'
  }
  return null
}

function nameScreen(uiRoot: HTMLElement, savedName: string | null): Promise<string> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'overlay-center'
    overlay.innerHTML = `
      <h1>HOBO.QUEST</h1>
      <input id="name-input" maxlength="24" placeholder="drifter name" value="${savedName ?? ''}" />
      <button id="join-btn">Enter the Yard</button>
      <div class="hint">a persistent multiplayer physics sandbox</div>
    `
    uiRoot.appendChild(overlay)
    const inputEl = overlay.querySelector('#name-input') as HTMLInputElement
    const button = overlay.querySelector('#join-btn') as HTMLButtonElement
    const join = (): void => {
      const value = inputEl.value.trim() || 'Drifter'
      overlay.remove()
      resolve(value)
    }
    button.addEventListener('click', join)
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join()
    })
    inputEl.focus()
  })
}

start().catch((err: unknown) => {
  console.error('client fatal:', err)
  const status = document.createElement('div')
  status.className = 'status'
  status.textContent = `fatal: ${String(err)}`
  document.getElementById('ui')?.appendChild(status)
})
