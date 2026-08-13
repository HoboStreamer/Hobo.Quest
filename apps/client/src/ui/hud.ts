import { TRADES } from '@hobo/content'
import type { ContentRegistry } from '@hobo/content'
import { HOTBAR_SLOTS } from '../constants.js'
import type { Connection } from '../net/connection.js'
import type { ClientState } from '../state/clientState.js'
import type { IconFactory } from './iconFactory.js'
import { weaponModuleFor, type WeaponSettings } from '../weapons/registry.js'

/**
 * HUD: crosshair/prompt/toasts, the always-visible hotbar, and a single
 * Tab menu with Inventory / Crafting / Skills / Players tabs.
 *
 * Inventory is drag-and-drop: drag between backpack and hotbar to move or
 * swap stacks, drag OUT of the UI (onto the world) to drop the stack as a
 * physical prop — Minecraft-style. Icons are rendered from the items' real
 * 3D models. All mutations round-trip through the server.
 */

type MenuTab = 'inventory' | 'crafting' | 'equipment' | 'skills' | 'players'

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
    private readonly weaponSettings: WeaponSettings,
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
    state.events.on('stats', (s) => {
      // Red flash when health drops; persistent vignette when critical.
      if (s.hp < this.lastHp) this.flashDamage()
      this.lastHp = s.hp
      this.byId('vignette').style.opacity = s.hp < 40 ? String((40 - s.hp) / 55) : '0'
      this.renderVitals()
      if (s.died) this.showDeathScreen()
    })
    state.events.on('container', ({ id, size, slots }) => {
      // Refresh only if it's the container we're looking at (or a fresh open).
      if (this.openContainerId === null || this.openContainerId === id) {
        this.showContainer(id, size, slots)
      }
    })
    state.events.on('entityRemoved', (id) => {
      if (this.openContainerId === id) this.closeContainer()
    })
    state.events.on('announce', (text) => this.showAnnounce(text))
    state.events.on('actionResult', (r) => {
      if (r.action === 'trade' && r.ok) this.toast('🤝 Deal!')
    })
    state.events.on('inventory', () => {
      if (this.shopOpen) this.renderShop()
    })
    state.events.on('inventory', () => {
      if (this.openContainerId) this.renderContainer()
    })
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="crosshair"></div>
      <div class="hitmarker" id="hitmarker"></div>
      <div class="vignette" id="vignette"></div>
      <div class="prompt" id="prompt"></div>
      <div class="toast-area" id="toasts"></div>
      <div class="status" id="status"></div>
      <div class="edit-indicator" id="edit-indicator">🛠 EDIT MODE — noclip · Space up · Ctrl down · Shift fast</div>
      <div class="menu" id="menu">
        <div class="menu-tabs" id="menu-tabs"></div>
        <div class="menu-body" id="menu-body"></div>
      </div>
      <div class="hotbar" id="hotbar"></div>
      <div class="vitals" id="vitals">
        <div class="vital"><span>HP</span><div class="vital-bar"><div id="bar-hp" class="vital-fill hp"></div></div></div>
        <div class="vital"><span>FOOD</span><div class="vital-bar"><div id="bar-hunger" class="vital-fill hunger"></div></div></div>
        <div class="vital"><span>H2O</span><div class="vital-bar"><div id="bar-thirst" class="vital-fill thirst"></div></div></div>
        <div class="vital"><span>STAM</span><div class="vital-bar"><div id="bar-stamina" class="vital-fill stamina"></div></div></div>
        <div class="vital-extras" id="vital-extras"></div>
      </div>
      <div class="announce" id="announce"></div>
      <div class="death-screen" id="death-screen">
        <div class="death-title">YOU DIED</div>
        <div class="death-sub">Waking up back in Hoboville…</div>
      </div>
      <div class="container-panel" id="shop-panel" style="display:none">
        <div class="container-title">Goose's Trading Post</div>
        <div class="shop-list" id="shop-list"></div>
        <div class="cust-actions"><button id="shop-close" class="cust-btn">Close</button></div>
      </div>
      <div class="container-panel" id="container-panel" style="display:none">
        <div class="container-title">Storage</div>
        <div class="container-grid" id="container-grid"></div>
        <div class="hint-line">Click an item to move it · your inventory below</div>
        <div class="container-grid" id="container-player"></div>
        <div class="cust-actions">
          <button id="container-sort" class="cust-btn">Sort</button>
          <button id="container-pickup" class="cust-btn">Pick up (empty box)</button>
          <button id="container-close" class="cust-btn">Close</button>
        </div>
      </div>
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

    this.byId('container-close').addEventListener('click', () => this.closeContainer())
    this.byId('shop-close').addEventListener('click', () => this.closeShop())
    this.byId('container-pickup').addEventListener('click', () => {
      if (this.openContainerId) {
        this.connection.send({ t: 'use', target: this.openContainerId })
        this.closeContainer()
      }
    })
    this.byId('container-sort').addEventListener('click', () => {
      if (this.openContainerId) {
        this.connection.send({ t: 'container_sort', target: this.openContainerId })
      }
    })
  }

  // ── Survival vitals + container storage ────────────────────────────

  private openContainerId: string | null = null
  private containerData: { size: number; slots: { i: number; def: string; count: number }[] } = {
    size: 0,
    slots: [],
  }

  private lastHp = 100
  private hitmarkerTimer: ReturnType<typeof setTimeout> | null = null

  /** Brief crosshair X when a melee hit lands on another player. */
  flashHitmarker(): void {
    const el = this.byId('hitmarker')
    el.classList.add('show')
    if (this.hitmarkerTimer) clearTimeout(this.hitmarkerTimer)
    this.hitmarkerTimer = setTimeout(() => el.classList.remove('show'), 160)
  }

  private flashDamage(): void {
    const el = this.byId('vignette')
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 220)
  }

  private shopOpen = false

  private showDeathScreen(): void {
    const el = this.byId('death-screen')
    el.classList.add('show')
    setTimeout(() => el.classList.remove('show'), 3800)
  }

  /** Merchant trade sheet (content-driven; server validates every trade). */
  openShop(): void {
    this.shopOpen = true
    this.byId('shop-panel').style.display = 'flex'
    this.renderShop()
    this.onUiCaptureChange?.(true)
  }

  closeShop(): void {
    if (!this.shopOpen) return
    this.shopOpen = false
    this.byId('shop-panel').style.display = 'none'
    if (!this.menuOpen) this.onUiCaptureChange?.(false)
  }

  private renderShop(): void {
    const list = this.byId('shop-list')
    list.replaceChildren()
    for (const trade of TRADES) {
      const giveName = this.content.item(trade.give.item)?.name ?? trade.give.item
      const getName = this.content.item(trade.get.item)?.name ?? trade.get.item
      const row = document.createElement('button')
      row.className = 'shop-row'
      const have = this.state.countOf(trade.give.item)
      const afford = have >= trade.give.count
      row.disabled = !afford
      row.innerHTML = `
        <img src="${this.icons.iconFor(trade.get.item)}" draggable="false" />
        <span class="shop-get">${trade.get.count}× ${getName}</span>
        <span class="shop-cost ${afford ? '' : 'missing'}">${trade.give.count}× ${giveName} (${have})</span>
      `
      row.addEventListener('click', () => this.connection.send({ t: 'trade', trade: trade.id }))
      list.appendChild(row)
    }
  }

  private announceTimer: ReturnType<typeof setTimeout> | null = null

  private showAnnounce(text: string): void {
    const el = this.byId('announce')
    el.textContent = text
    el.classList.add('show')
    if (this.announceTimer) clearTimeout(this.announceTimer)
    this.announceTimer = setTimeout(() => el.classList.remove('show'), 8000)
  }

  private renderVitals(): void {
    const s = this.state.stats
    ;(this.byId('bar-hp').style as CSSStyleDeclaration).width = `${s.hp}%`
    ;(this.byId('bar-hunger').style as CSSStyleDeclaration).width = `${s.hunger}%`
    ;(this.byId('bar-thirst').style as CSSStyleDeclaration).width = `${s.thirst}%`
    ;(this.byId('bar-stamina').style as CSSStyleDeclaration).width = `${s.stamina}%`
    // Body temperature + active statuses (only shown when noteworthy).
    const extras = this.byId('vital-extras')
    const chips: string[] = []
    if (s.temp <= 35.5) chips.push(`🌡 ${s.temp.toFixed(1)}°C`)
    else if (s.temp >= 38.5) chips.push(`🌡 ${s.temp.toFixed(1)}°C`)
    const ICONS: Record<string, string> = {
      wet: '💧 wet',
      cold: '🥶 cold',
      freezing: '🧊 FREEZING',
      overheated: '🥵 overheated',
      well_fed: '🍲 well fed',
      bleeding: '🩸 bleeding',
    }
    for (const id of s.statuses) chips.push(ICONS[id] ?? id)
    extras.replaceChildren(
      ...chips.map((text) => {
        const chip = document.createElement('span')
        chip.className = 'status-chip'
        chip.textContent = text
        return chip
      }),
    )
  }

  /** Opens (or refreshes) the storage panel for a container entity. */
  showContainer(
    id: string,
    size: number,
    slots: { i: number; def: string; count: number }[],
  ): void {
    this.openContainerId = id
    this.containerData = { size, slots }
    const def = this.state.entities.get(id)?.def
    this.byId('container-panel').querySelector('.container-title')!.textContent =
      (def && this.content.item(def)?.name) || 'Storage'
    this.byId('container-panel').style.display = 'flex'
    this.renderContainer()
    this.onUiCaptureChange?.(true)
  }

  closeContainer(): void {
    if (!this.openContainerId) return
    this.openContainerId = null
    this.byId('container-panel').style.display = 'none'
    if (!this.menuOpen) this.onUiCaptureChange?.(false)
  }

  get containerOpen(): boolean {
    return this.openContainerId !== null
  }

  private renderContainer(): void {
    const grid = this.byId('container-grid')
    grid.replaceChildren()
    const bySlot = new Map(this.containerData.slots.map((s) => [s.i, s]))
    for (let i = 0; i < this.containerData.size; i++) {
      const cell = document.createElement('button')
      cell.className = 'slot'
      const stack = bySlot.get(i)
      if (stack) {
        const img = document.createElement('img')
        img.src = this.icons.iconFor(stack.def)
        img.draggable = false
        cell.appendChild(img)
        const count = document.createElement('span')
        count.className = 'slot-count'
        count.textContent = stack.count > 1 ? String(stack.count) : ''
        cell.appendChild(count)
        cell.title = this.content.item(stack.def)?.name ?? stack.def
        cell.addEventListener('click', () => {
          if (this.openContainerId) {
            this.connection.send({
              t: 'container_move',
              target: this.openContainerId,
              dir: 'out',
              slot: i,
            })
          }
        })
        // Right-click: take half the stack.
        cell.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          if (this.openContainerId && stack.count > 1) {
            this.connection.send({
              t: 'container_move',
              target: this.openContainerId,
              dir: 'out',
              slot: i,
              count: Math.ceil(stack.count / 2),
            })
          }
        })
      }
      grid.appendChild(cell)
    }
    const mine = this.byId('container-player')
    mine.replaceChildren()
    for (const slot of this.state.inventory?.slots ?? []) {
      const cell = document.createElement('button')
      cell.className = 'slot'
      const img = document.createElement('img')
      img.src = this.icons.iconFor(slot.stack.def)
      img.draggable = false
      cell.appendChild(img)
      const count = document.createElement('span')
      count.className = 'slot-count'
      count.textContent = slot.stack.count > 1 ? String(slot.stack.count) : ''
      cell.appendChild(count)
      cell.title = this.content.item(slot.stack.def)?.name ?? slot.stack.def
      cell.addEventListener('click', () => {
        if (this.openContainerId) {
          this.connection.send({
            t: 'container_move',
            target: this.openContainerId,
            dir: 'in',
            slot: slot.i,
          })
        }
      })
      // Right-click: stash half the stack.
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        if (this.openContainerId && slot.stack.count > 1) {
          this.connection.send({
            t: 'container_move',
            target: this.openContainerId,
            dir: 'in',
            slot: slot.i,
            count: Math.ceil(slot.stack.count / 2),
          })
        }
      })
      mine.appendChild(cell)
    }
  }

  private byId(id: string): HTMLElement {
    const el = this.root.querySelector(`#${id}`)
    if (!el) throw new Error(`missing ui element ${id}`)
    return el as HTMLElement
  }

  toggleMenu(): void {
    this.menuOpen = !this.menuOpen
    this.menuEl.style.display = this.menuOpen ? 'flex' : 'none'
    this.renderTabs()
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

  private editMode = false

  private renderTabs(): void {
    const tabs = this.byId('menu-tabs')
    tabs.replaceChildren()
    const defs: [MenuTab, string][] = [
      ['inventory', 'Inventory'],
      ['crafting', 'Crafting'],
      ['equipment', 'Equipment'],
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
    // Staff-only build tools, MMO-GM style: noclip fly toggle + the full
    // terrain/map editor in a new tab.
    if (this.state.myRank === 'owner' || this.state.myRank === 'admin') {
      const edit = document.createElement('button')
      edit.className = this.editMode ? 'menu-tab edit-toggle active' : 'menu-tab edit-toggle'
      edit.textContent = this.editMode ? '🛠 Exit Edit Mode' : '🛠 Edit Mode'
      edit.addEventListener('click', () => {
        this.editMode = !this.editMode
        this.connection.send({ t: 'editmode', on: this.editMode })
        this.renderTabs()
        const ind = this.byId('edit-indicator')
        ind.style.display = this.editMode ? 'block' : 'none'
      })
      tabs.appendChild(edit)
      const mapEd = document.createElement('button')
      mapEd.className = 'menu-tab edit-toggle'
      mapEd.textContent = '🗺 Map Editor'
      mapEd.addEventListener('click', () => window.open('/editor', '_blank'))
      tabs.appendChild(mapEd)
    }
  }

  renderMenu(): void {
    if (!this.menuOpen) return
    this.menuBodyEl.replaceChildren()
    if (this.activeTab === 'inventory') this.renderInventory()
    else if (this.activeTab === 'crafting') this.renderCrafting()
    else if (this.activeTab === 'equipment') this.renderEquipment()
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
    if (i === this.state.activeHotbar && i < HOTBAR_SLOTS) {
      el.classList.add(this.state.holstered ? 'holstered' : 'active')
    }
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
      if (!this.menuOpen && i < HOTBAR_SLOTS) {
        this.connection.send({ t: 'hotbar', slot: i })
        if (i === this.state.activeHotbar) {
          this.state.holstered = !this.state.holstered
        } else {
          this.state.activeHotbar = i
          this.state.holstered = false
        }
        this.renderHotbar()
      }
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
      // Machine recipes run inside their machine, not from this menu.
      if (recipe.machine) continue
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
      // Batch craft: queue five at once (server validates each).
      const batch = document.createElement('button')
      batch.className = 'craft-btn'
      batch.textContent = '×5'
      batch.disabled = !craftable
      batch.addEventListener('click', () => {
        for (let i = 0; i < 5; i++) this.connection.send({ t: 'craft', recipe: recipe.id })
      })
      el.appendChild(batch)
      list.appendChild(el)
    }
    this.menuBodyEl.appendChild(list)
  }

  /** Modular per-weapon settings/info — modules register per tool kind. */
  private renderEquipment(): void {
    const defId = this.state.activeItemDef()
    const def = defId ? this.content.item(defId) : undefined
    const module = weaponModuleFor(def?.tool?.kind ?? null)
    const wrap = document.createElement('div')
    if (!module) {
      const empty = document.createElement('div')
      empty.className = 'hint-line'
      empty.textContent = defId
        ? `${def?.name ?? defId} has no settings.`
        : 'Nothing equipped — select a tool on the hotbar.'
      wrap.appendChild(empty)
    } else {
      const title = document.createElement('div')
      title.className = 'weapon-title'
      title.textContent = module.title
      wrap.appendChild(title)
      const panel = document.createElement('div')
      module.buildPanel(panel, this.weaponSettings)
      wrap.appendChild(panel)
    }
    this.menuBodyEl.appendChild(wrap)
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
