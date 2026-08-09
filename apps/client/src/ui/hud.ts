import type { ContentRegistry } from '@hobo/content'
import { HOTBAR_SLOTS } from '../constants.js'
import type { Connection } from '../net/connection.js'
import type { ClientState } from '../state/clientState.js'

/**
 * Minimal DOM HUD: hotbar, inventory grid, crafting list, prompts, toasts.
 * Reads ClientState via events; sends intents through the Connection. No
 * game logic here — the server decides everything.
 */
export class Hud {
  private root: HTMLElement
  private hotbarEl!: HTMLElement
  private invPanel!: HTMLElement
  private invGrid!: HTMLElement
  private craftPanel!: HTMLElement
  private promptEl!: HTMLElement
  private statusEl!: HTMLElement
  private toastArea!: HTMLElement
  private moveSrc: number | null = null

  inventoryOpen = false
  craftOpen = false
  onUiCaptureChange: ((captured: boolean) => void) | null = null

  constructor(
    root: HTMLElement,
    private readonly state: ClientState,
    private readonly content: ContentRegistry,
    private readonly connection: Connection,
  ) {
    this.root = root
    this.build()
    state.events.on('inventory', () => {
      this.renderHotbar()
      this.renderInventory()
      this.renderCrafting()
    })
    state.events.on('craftJobs', () => this.renderCrafting())
    state.events.on('actionResult', (r) => {
      if (!r.ok && r.error) this.toast(`${r.action}: ${humanize(r.error)}`, true)
    })
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="crosshair"></div>
      <div class="prompt" id="prompt"></div>
      <div class="toast-area" id="toasts"></div>
      <div class="status" id="status">connecting…</div>
      <div class="hotbar" id="hotbar"></div>
      <div class="panel" id="inventory-panel"><h2>Inventory</h2><div class="inv-grid" id="inv-grid"></div></div>
      <div class="panel" id="craft-panel"><h2>Crafting</h2><div id="craft-list"></div></div>
      <div class="help">WASD move · Space jump · Shift sprint · LMB physgun · wheel push/pull · R+mouse rotate · F freeze · Q unfreeze · E gather · X place · Tab inventory · C craft</div>
    `
    this.hotbarEl = this.byId('hotbar')
    this.invPanel = this.byId('inventory-panel')
    this.invGrid = this.byId('inv-grid')
    this.craftPanel = this.byId('craft-panel')
    this.promptEl = this.byId('prompt')
    this.statusEl = this.byId('status')
    this.toastArea = this.byId('toasts')
    this.renderHotbar()
  }

  private byId(id: string): HTMLElement {
    const el = this.root.querySelector(`#${id}`)
    if (!el) throw new Error(`missing ui element ${id}`)
    return el as HTMLElement
  }

  toggleInventory(): void {
    this.inventoryOpen = !this.inventoryOpen
    this.moveSrc = null
    this.invPanel.style.display = this.inventoryOpen ? 'block' : 'none'
    this.renderInventory()
    this.updateCapture()
  }

  toggleCraft(): void {
    this.craftOpen = !this.craftOpen
    this.craftPanel.style.display = this.craftOpen ? 'block' : 'none'
    this.renderCrafting()
    this.updateCapture()
  }

  closeAll(): void {
    this.inventoryOpen = false
    this.craftOpen = false
    this.invPanel.style.display = 'none'
    this.craftPanel.style.display = 'none'
    this.updateCapture()
  }

  private updateCapture(): void {
    this.onUiCaptureChange?.(this.inventoryOpen || this.craftOpen)
  }

  setPrompt(text: string | null): void {
    this.promptEl.style.display = text ? 'block' : 'none'
    if (text) this.promptEl.textContent = text
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text
  }

  toast(text: string, isError = false): void {
    const el = document.createElement('div')
    el.className = isError ? 'toast error' : 'toast'
    el.textContent = text
    this.toastArea.appendChild(el)
    setTimeout(() => el.remove(), 3600)
  }

  private slotStack(i: number) {
    return this.state.inventory?.slots.find((s) => s.i === i)?.stack ?? null
  }

  private slotEl(i: number, keyLabel: string | null): HTMLElement {
    const stack = this.slotStack(i)
    const el = document.createElement('div')
    el.className = 'slot'
    if (i === this.state.activeHotbar && i < HOTBAR_SLOTS) el.classList.add('active')
    if (this.moveSrc === i) el.classList.add('selected-src')
    if (keyLabel) {
      const key = document.createElement('span')
      key.className = 'key'
      key.textContent = keyLabel
      el.appendChild(key)
    }
    if (stack) {
      const def = this.content.item(stack.def)
      const name = document.createElement('span')
      name.textContent = def?.name ?? stack.def
      el.appendChild(name)
      if (stack.count > 1) {
        const count = document.createElement('span')
        count.className = 'count'
        count.textContent = String(stack.count)
        el.appendChild(count)
      }
    }
    el.addEventListener('click', () => this.clickSlot(i, false))
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.clickSlot(i, true)
    })
    return el
  }

  /** Click-to-move: first click selects source, second sends inv_move. Right-click splits half. */
  private clickSlot(i: number, split: boolean): void {
    if (!this.inventoryOpen) {
      if (i < HOTBAR_SLOTS) this.connection.send({ t: 'hotbar', slot: i })
      return
    }
    if (this.moveSrc === null) {
      if (this.slotStack(i)) this.moveSrc = i
    } else if (this.moveSrc === i) {
      this.moveSrc = null
    } else {
      const src = this.slotStack(this.moveSrc)
      const count = split && src && src.count > 1 ? Math.floor(src.count / 2) : undefined
      this.connection.send({
        t: 'inv_move',
        from: this.moveSrc,
        to: i,
        ...(count !== undefined ? { count } : {}),
      })
      this.moveSrc = null
    }
    this.renderInventory()
    this.renderHotbar()
  }

  renderHotbar(): void {
    this.hotbarEl.replaceChildren()
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      this.hotbarEl.appendChild(this.slotEl(i, String(i + 1)))
    }
  }

  renderInventory(): void {
    if (!this.inventoryOpen) return
    this.invGrid.replaceChildren()
    const size = this.state.inventory?.size ?? 24
    for (let i = 0; i < HOTBAR_SLOTS; i++) this.invGrid.appendChild(this.slotEl(i, String(i + 1)))
    const divider = document.createElement('div')
    divider.className = 'backpack-divider'
    this.invGrid.appendChild(divider)
    for (let i = HOTBAR_SLOTS; i < size; i++) this.invGrid.appendChild(this.slotEl(i, null))
  }

  renderCrafting(): void {
    if (!this.craftOpen) return
    const list = this.byId('craft-list')
    list.replaceChildren()
    for (const recipe of this.content.allRecipes()) {
      const el = document.createElement('div')
      el.className = 'recipe'
      const name = document.createElement('div')
      name.className = 'name'
      name.textContent = recipe.name
      el.appendChild(name)

      let craftable = true
      for (const input of recipe.inputs) {
        const have = this.state.countOf(input.item)
        const req = document.createElement('div')
        req.className = have >= input.count ? 'req' : 'req missing'
        req.textContent = `${this.content.item(input.item)?.name ?? input.item}: ${have}/${input.count}`
        if (have < input.count) craftable = false
        el.appendChild(req)
      }
      if (recipe.workstation) {
        const req = document.createElement('div')
        req.className = 'req'
        req.textContent = `Requires: ${recipe.workstation}`
        el.appendChild(req)
      }
      const active = this.state.craftJobs.filter((j) => j.recipe === recipe.id).length
      const button = document.createElement('button')
      button.textContent = active > 0 ? `Crafting… (${active})` : `Craft (${recipe.craftSeconds}s)`
      button.disabled = !craftable
      button.addEventListener('click', () => {
        this.connection.send({ t: 'craft', recipe: recipe.id })
      })
      el.appendChild(button)
      list.appendChild(el)
    }
  }
}

function humanize(error: string): string {
  return error.replaceAll('_', ' ')
}
