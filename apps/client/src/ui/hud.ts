import type { ContentRegistry } from '@hobo/content'
import { HOTBAR_SLOTS } from '../constants.js'
import type { Connection } from '../net/connection.js'
import type { ClientState } from '../state/clientState.js'
import type { IconFactory } from './iconFactory.js'

/**
 * HUD: crosshair/prompt/toasts, the always-visible hotbar, and a single
 * Tab menu with Inventory / Crafting / Skills / Players tabs.
 *
 * Inventory is drag-and-drop: drag between backpack and hotbar to move or
 * swap stacks, drag OUT of the UI (onto the world) to drop the stack as a
 * physical prop — Minecraft-style. Icons are rendered from the items' real
 * 3D models. All mutations round-trip through the server.
 */

type MenuTab = 'inventory' | 'crafting' | 'skills' | 'players'

export class Hud {
  private root: HTMLElement
  private hotbarEl!: HTMLElement
  private menuEl!: HTMLElement
  private menuBodyEl!: HTMLElement
  private promptEl!: HTMLElement
  private statusEl!: HTMLElement
  private toastArea!: HTMLElement

  menuOpen = false
  private activeTab: MenuTab = 'inventory'
  private dragFrom: number | null = null
  onUiCaptureChange: ((captured: boolean) => void) | null = null

  constructor(
    root: HTMLElement,
    private readonly state: ClientState,
    private readonly content: ContentRegistry,
    private readonly connection: Connection,
    private readonly icons: IconFactory,
  ) {
    this.root = root
    this.build()
    icons.onReady = () => {
      this.renderHotbar()
      this.renderMenu()
    }
    state.events.on('inventory', () => {
      this.renderHotbar()
      this.renderMenu()
    })
    state.events.on('craftJobs', () => this.renderMenu())
    state.events.on('skills', () => this.renderMenu())
    state.events.on('friendsChanged', () => this.renderMenu())
    state.events.on('entityAdded', () => {
      if (this.activeTab === 'players') this.renderMenu()
    })
    state.events.on('entityRemoved', () => {
      if (this.activeTab === 'players') this.renderMenu()
    })
    state.events.on('actionResult', (r) => {
      if (!r.ok && r.error) this.toast(`${humanize(r.error)}`, true)
    })
    state.events.on('levelUp', ({ skill, level }) => {
      const def = this.content.skill(skill)
      this.toast(`⭐ ${def?.name ?? skill} reached level ${level}!`)
    })
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="crosshair"></div>
      <div class="prompt" id="prompt"></div>
      <div class="toast-area" id="toasts"></div>
      <div class="status" id="status"></div>
      <div class="menu" id="menu">
        <div class="menu-tabs" id="menu-tabs"></div>
        <div class="menu-body" id="menu-body"></div>
      </div>
      <div class="hotbar" id="hotbar"></div>
    `
    this.hotbarEl = this.byId('hotbar')
    this.menuEl = this.byId('menu')
    this.menuBodyEl = this.byId('menu-body')
    this.promptEl = this.byId('prompt')
    this.statusEl = this.byId('status')
    this.toastArea = this.byId('toasts')

    // Dropping a drag anywhere outside the UI drops the stack into the world.
    document.addEventListener('dragover', (e) => e.preventDefault())
    document.addEventListener('drop', (e) => {
      e.preventDefault()
      if (this.dragFrom === null) return
      const target = e.target as HTMLElement
      if (!target.closest('.menu') && !target.closest('.hotbar')) {
        this.dropToWorld(this.dragFrom)
      }
      this.dragFrom = null
    })

    this.renderTabs()
    this.renderHotbar()
  }

  private byId(id: string): HTMLElement {
    const el = this.root.querySelector(`#${id}`)
    if (!el) throw new Error(`missing ui element ${id}`)
    return el as HTMLElement
  }

  toggleMenu(): void {
    this.menuOpen = !this.menuOpen
    this.menuEl.style.display = this.menuOpen ? 'flex' : 'none'
    this.renderMenu()
    this.onUiCaptureChange?.(this.menuOpen)
  }

  closeAll(): void {
    if (this.menuOpen) this.toggleMenu()
  }

  private setTab(tab: MenuTab): void {
    this.activeTab = tab
    this.renderTabs()
    this.renderMenu()
  }

  private renderTabs(): void {
    const tabs = this.byId('menu-tabs')
    tabs.replaceChildren()
    const defs: [MenuTab, string][] = [
      ['inventory', 'Inventory'],
      ['crafting', 'Crafting'],
      ['skills', 'Skills'],
      ['players', 'Players'],
    ]
    for (const [tab, label] of defs) {
      const b = document.createElement('button')
      b.className = tab === this.activeTab ? 'menu-tab active' : 'menu-tab'
      b.textContent = label
      b.addEventListener('click', () => this.setTab(tab))
      tabs.appendChild(b)
    }
  }

  renderMenu(): void {
    if (!this.menuOpen) return
    this.menuBodyEl.replaceChildren()
    if (this.activeTab === 'inventory') this.renderInventory()
    else if (this.activeTab === 'crafting') this.renderCrafting()
    else if (this.activeTab === 'skills') this.renderSkills()
    else this.renderPlayers()
  }

  // ── Slots (shared by hotbar + backpack) ────────────────────────────

  private slotStack(i: number) {
    return this.state.inventory?.slots.find((s) => s.i === i)?.stack ?? null
  }

  private dropToWorld(slot: number): void {
    const stack = this.slotStack(slot)
    if (!stack) return
    this.connection.send({ t: 'drop', slot, count: stack.count })
  }

  private slotEl(i: number, keyLabel: string | null): HTMLElement {
    const stack = this.slotStack(i)
    const el = document.createElement('div')
    el.className = 'slot'
    el.dataset.slot = String(i)
    if (i === this.state.activeHotbar && i < HOTBAR_SLOTS) el.classList.add('active')
    if (keyLabel) {
      const key = document.createElement('span')
      key.className = 'key'
      key.textContent = keyLabel
      el.appendChild(key)
    }
    if (stack) {
      const img = document.createElement('img')
      img.className = 'slot-icon'
      img.src = this.icons.iconFor(stack.def)
      img.draggable = false
      el.appendChild(img)
      el.title = this.content.item(stack.def)?.name ?? stack.def
      if (stack.count > 1) {
        const count = document.createElement('span')
        count.className = 'count'
        count.textContent = String(stack.count)
        el.appendChild(count)
      }
      el.draggable = true
      el.addEventListener('dragstart', (e) => {
        this.dragFrom = i
        el.classList.add('dragging')
        e.dataTransfer?.setData('text/plain', String(i))
      })
      el.addEventListener('dragend', () => el.classList.remove('dragging'))
    }
    el.addEventListener('dragover', (e) => {
      e.preventDefault()
      el.classList.add('drop-target')
    })
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'))
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      el.classList.remove('drop-target')
      if (this.dragFrom !== null && this.dragFrom !== i) {
        this.connection.send({ t: 'inv_move', from: this.dragFrom, to: i })
      }
      this.dragFrom = null
    })
    // Click hotbar slots (outside menu) to select; right-click splits half.
    el.addEventListener('click', () => {
      if (!this.menuOpen && i < HOTBAR_SLOTS) this.connection.send({ t: 'hotbar', slot: i })
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const s = this.slotStack(i)
      if (!s || s.count < 2 || !this.menuOpen) return
      const free = this.firstFreeSlot()
      if (free !== null) {
        this.connection.send({ t: 'inv_move', from: i, to: free, count: Math.floor(s.count / 2) })
      }
    })
    return el
  }

  private firstFreeSlot(): number | null {
    const size = this.state.inventory?.size ?? 24
    const used = new Set(this.state.inventory?.slots.map((s) => s.i))
    for (let i = 0; i < size; i++) if (!used.has(i)) return i
    return null
  }

  renderHotbar(): void {
    this.hotbarEl.replaceChildren()
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      this.hotbarEl.appendChild(this.slotEl(i, String(i + 1)))
    }
  }

  // ── Tab contents ───────────────────────────────────────────────────

  private renderInventory(): void {
    const grid = document.createElement('div')
    grid.className = 'inv-grid'
    const size = this.state.inventory?.size ?? 24
    for (let i = HOTBAR_SLOTS; i < size; i++) grid.appendChild(this.slotEl(i, null))
    const hint = document.createElement('div')
    hint.className = 'hint-line'
    hint.textContent =
      'Drag to move · drag outside to drop · right-click to split · G drops held item'
    this.menuBodyEl.append(grid, hint)
  }

  private renderCrafting(): void {
    const list = document.createElement('div')
    list.className = 'craft-list'
    for (const recipe of this.content.allRecipes()) {
      const el = document.createElement('div')
      el.className = 'recipe'
      const iconWrap = document.createElement('div')
      iconWrap.className = 'recipe-icon'
      const img = document.createElement('img')
      img.src = this.icons.iconFor(recipe.outputs[0]?.item ?? '')
      img.draggable = false
      iconWrap.appendChild(img)
      el.appendChild(iconWrap)

      const info = document.createElement('div')
      info.className = 'recipe-info'
      const name = document.createElement('div')
      name.className = 'name'
      name.textContent = recipe.name
      info.appendChild(name)

      let craftable = true
      const reqLine = document.createElement('div')
      reqLine.className = 'req'
      const parts: string[] = []
      for (const input of recipe.inputs) {
        const have = this.state.countOf(input.item)
        if (have < input.count) craftable = false
        parts.push(`${this.content.item(input.item)?.name ?? input.item} ${have}/${input.count}`)
      }
      reqLine.textContent = parts.join(' · ')
      if (!craftable) reqLine.classList.add('missing')
      info.appendChild(reqLine)

      if (recipe.workstation || recipe.requiredSkill) {
        const gates = document.createElement('div')
        gates.className = 'req'
        const bits: string[] = []
        if (recipe.workstation) bits.push(`needs ${recipe.workstation}`)
        if (recipe.requiredSkill) {
          const have = this.state.skillLevel(recipe.requiredSkill.skill)
          const skillName =
            this.content.skill(recipe.requiredSkill.skill)?.name ?? recipe.requiredSkill.skill
          bits.push(`${skillName} lv${recipe.requiredSkill.level} (you: ${have})`)
          if (have < recipe.requiredSkill.level) craftable = false
        }
        gates.textContent = bits.join(' · ')
        info.appendChild(gates)
      }
      el.appendChild(info)

      const active = this.state.craftJobs.filter((j) => j.recipe === recipe.id).length
      const button = document.createElement('button')
      button.className = 'craft-btn'
      button.textContent = active > 0 ? `⏳ ${active}` : `${recipe.craftSeconds}s`
      button.disabled = !craftable
      button.addEventListener('click', () =>
        this.connection.send({ t: 'craft', recipe: recipe.id }),
      )
      el.appendChild(button)
      list.appendChild(el)
    }
    this.menuBodyEl.appendChild(list)
  }

  private renderSkills(): void {
    const list = document.createElement('div')
    list.className = 'skills-list'
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
    this.menuBodyEl.appendChild(list)
  }

  private renderPlayers(): void {
    const wrap = document.createElement('div')
    const hint = document.createElement('div')
    hint.className = 'hint-line'
    hint.textContent = 'Trusted players can move and unfreeze your props.'
    wrap.appendChild(hint)
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
      wrap.appendChild(empty)
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
      wrap.appendChild(row)
    }
    this.menuBodyEl.appendChild(wrap)
  }

  // ── Overlay text ───────────────────────────────────────────────────

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
}

function humanize(error: string): string {
  return error.replaceAll('_', ' ')
}
