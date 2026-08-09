import type { ContentRegistry } from '@hobo/content'
import type { Connection } from '../net/connection.js'
import type { ClientState } from '../state/clientState.js'
import type { IconFactory } from './iconFactory.js'
export declare class Hud {
  private readonly state
  private readonly content
  private readonly connection
  private readonly icons
  private root
  private hotbarEl
  private menuEl
  private menuBodyEl
  private promptEl
  private statusEl
  private toastArea
  menuOpen: boolean
  private activeTab
  private dragFrom
  onUiCaptureChange: ((captured: boolean) => void) | null
  constructor(
    root: HTMLElement,
    state: ClientState,
    content: ContentRegistry,
    connection: Connection,
    icons: IconFactory,
  )
  private build
  private byId
  toggleMenu(): void
  closeAll(): void
  private setTab
  private renderTabs
  renderMenu(): void
  private slotStack
  private dropToWorld
  private slotEl
  private firstFreeSlot
  renderHotbar(): void
  private renderInventory
  private renderCrafting
  private renderSkills
  private renderPlayers
  setPrompt(text: string | null): void
  setStatus(text: string): void
  toast(text: string, isError?: boolean): void
}
//# sourceMappingURL=hud.d.ts.map
