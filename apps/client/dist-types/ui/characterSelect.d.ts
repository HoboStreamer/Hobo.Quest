import type { Appearance } from '@hobo/protocol'
/**
 * MMO-style character select: an account token owns up to three characters.
 * Pick one to play, or claim an empty slot (which runs the customization
 * screen). Pure DOM overlay — resolves with the chosen slot and, for
 * existing characters, their saved identity.
 */
export interface CharacterInfo {
  slot: number
  name: string
  appearance: Appearance | null
}
export declare function characterSelect(
  uiRoot: HTMLElement,
  characters: CharacterInfo[],
): Promise<{
  slot: number
  existing: CharacterInfo | null
}>
//# sourceMappingURL=characterSelect.d.ts.map
