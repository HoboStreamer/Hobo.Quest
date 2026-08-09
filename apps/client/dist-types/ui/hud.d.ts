import type { ContentRegistry } from '@hobo/content'
import type { Connection } from '../net/connection.js'
import type { ClientState } from '../state/clientState.js'
/**
 * Minimal DOM HUD: hotbar, inventory grid, crafting list, prompts, toasts.
 * Reads ClientState via events; sends intents through the Connection. No
 * game logic here — the server decides everything.
 */
export declare class Hud {
  private readonly state
  private readonly content
  private readonly connection
  private root
  private hotbarEl
  private invPanel
  private invGrid
  private craftPanel
  private promptEl
  private statusEl
  private toastArea
  private moveSrc
  inventoryOpen: boolean
  craftOpen: boolean
  skillsOpen: boolean
  playersOpen: boolean
  private skillsPanel
  private playersPanel
  onUiCaptureChange: ((captured: boolean) => void) | null
  constructor(
    root: HTMLElement,
    state: ClientState,
    content: ContentRegistry,
    connection: Connection,
  )
  private build
  private byId
  toggleInventory(): void
  toggleCraft(): void
  toggleSkills(): void
  togglePlayers(): void
  closeAll(): void
  private updateCapture
  /** Online players + persistent trusted list, with trust toggles. */
  renderPlayers(): void
  renderSkills(): void
  setPrompt(text: string | null): void
  setStatus(text: string): void
  toast(text: string, isError?: boolean): void
  private slotStack
  private slotEl
  /** Click-to-move: first click selects source, second sends inv_move. Right-click splits half. */
  private clickSlot
  renderHotbar(): void
  renderInventory(): void
  renderCrafting(): void
}
//# sourceMappingURL=hud.d.ts.map
