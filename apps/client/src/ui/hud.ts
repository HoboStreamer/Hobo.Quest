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
  skillsOpen = false
  playersOpen = false
  private skillsPanel!: HTMLElement
  private playersPanel!: HTMLElement
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
    state.events.on('skills', () => {
      this.renderSkills()
      this.renderCrafting()
    })
    state.events.on('levelUp', ({ skill, level }) => {
      const def = this.content.skill(skill)
      this.toast(`⭐ ${def?.name ?? skill} reached level ${level}!`)
    })
    state.events.on('friendsChanged', () => this.renderPlayers())
    state.events.on('entityAdded', () => this.renderPlayers())
    state.events.on('entityRemoved', () => this.renderPlayers())
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
      <div class="panel" id="skills-panel"><h2>Skills</h2><div id="skills-list"></div></div>
      <div class="panel" id="players-panel"><h2>Players</h2><div class="hint-line">Trusted players can move and unfreeze your props.</div><div id="players-list"></div></div>
      <div class="help">WASD move · Space jump · Shift sprint · LMB use tool · wheel push/pull · R+mouse rotate · F freeze · Q unfreeze · E gather · X place · Tab inventory · C craft · K skills · P players</div>
    `
    this.hotbarEl = this.byId('hotbar')
    this.invPanel = this.byId('inventory-panel')
    this.invGrid = this.byId('inv-grid')
    this.craftPanel = this.byId('craft-panel')
    this.skillsPanel = this.byId('skills-panel')
    this.playersPanel = this.byId('players-panel')
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

  toggleSkills(): void {
    this.skillsOpen = !this.skillsOpen
    this.skillsPanel.style.display = this.skillsOpen ? 'block' : 'none'
    this.renderSkills()
    this.updateCapture()
  }

  togglePlayers(): void {
    this.playersOpen = !this.playersOpen
    this.playersPanel.style.display = this.playersOpen ? 'block' : 'none'
    this.renderPlayers()
    this.updateCapture()
  }

  closeAll(): void {
    this.inventoryOpen = false
    this.craftOpen = false
    this.skillsOpen = false
    this.playersOpen = false
    this.invPanel.style.display = 'none'
    this.craftPanel.style.display = 'none'
    this.skillsPanel.style.display = 'none'
    this.playersPanel.style.display = 'none'
    this.updateCapture()
  }

  private updateCapture(): void {
    this.onUiCaptureChange?.(
      this.inventoryOpen || this.craftOpen || this.skillsOpen || this.playersOpen,
    )
  }

  /** Online players + persistent trusted list, with trust toggles. */
  renderPlayers(): void {
    if (!this.playersOpen) return
    const list = this.byId('players-list')
    list.replaceChildren()
    const online = this.state.onlinePlayers()
    const rows = new Map<string, { name: string; online: boolean }>()
    for (const p of online) rows.set(p.playerId, { name: p.name, online: true })
    for (const f of this.state.friends) {
      if (!rows.has(f.id)) rows.set(f.id, { name: f.name, online: false })
    }
    if (rows.size === 0) {
      const empty = document.createElement('div')
      empty.className = 'hint-line'
      empty.textContent = 'Nobody else around.'
      list.appendChild(empty)
      return
    }
    for (const [id, info] of rows) {
      const row = document.createElement('div')
      row.className = 'player-row'
      const label = document.createElement('span')
      label.textContent = `${info.name}${info.online ? '' : ' (offline)'}`
      row.appendChild(label)
      const trusted = this.state.isFriend(id)
      const button = document.createElement('button')
      button.className = trusted ? 'trust-btn trusted' : 'trust-btn'
      button.textContent = trusted ? 'Trusted ✓' : 'Trust'
      button.addEventListener('click', () => {
        this.connection.send({ t: 'trust', player: id, trusted: !trusted })
      })
      row.appendChild(button)
      list.appendChild(row)
    }
  }

  renderSkills(): void {
    if (!this.skillsOpen) return
    const list = this.byId('skills-list')
    list.replaceChildren()
    for (const skill of this.state.skills) {
      const def = this.content.skill(skill.id)
      const el = document.createElement('div')
      el.className = 'skill-row'
      const pct = skill.nextXp > 0 ? Math.min(100, (skill.xp / skill.nextXp) * 100) : 100
      el.innerHTML = `
        <div class="skill-head"><span>${def?.name ?? skill.id}</span><span class="skill-level">Lv ${skill.level}</span></div>
        <div class="skill-bar"><div class="skill-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="skill-xp">${skill.xp} / ${skill.nextXp > 0 ? skill.nextXp : 'max'} xp</div>
      `
      list.appendChild(el)
    }
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
      if (recipe.requiredSkill) {
        const have = this.state.skillLevel(recipe.requiredSkill.skill)
        const req = document.createElement('div')
        req.className = have >= recipe.requiredSkill.level ? 'req' : 'req missing'
        const skillName =
          this.content.skill(recipe.requiredSkill.skill)?.name ?? recipe.requiredSkill.skill
        req.textContent = `${skillName} level ${recipe.requiredSkill.level} (you: ${have})`
        if (have < recipe.requiredSkill.level) craftable = false
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
