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

export function characterSelect(
  uiRoot: HTMLElement,
  characters: CharacterInfo[],
  authed: boolean,
): Promise<{ slot: number; existing: CharacterInfo | null }> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'customize-overlay'
    const panel = document.createElement('div')
    panel.className = 'customize-panel'
    panel.innerHTML = '<h1>CHOOSE YOUR DRIFTER</h1>'
    const maxSlots = authed ? 3 : 1
    for (let slot = 0; slot < 3; slot++) {
      const existing = characters.find((c) => c.slot === slot) ?? null
      const row = document.createElement('button')
      row.className = 'cust-btn char-slot'
      if (slot >= maxSlots && !existing) {
        row.classList.add('char-locked')
        row.innerHTML = `<b>🔒 Locked</b><span>slot ${slot + 1}</span>`
        row.disabled = true
      } else {
        row.innerHTML = existing
          ? `<b>${escapeHtml(existing.name)}</b><span>slot ${slot + 1}</span>`
          : `<b>＋ New character</b><span>slot ${slot + 1}</span>`
        row.addEventListener('click', () => {
          overlay.remove()
          resolve({ slot, existing })
        })
      }
      panel.appendChild(row)
    }
    if (!authed) {
      const upsell = document.createElement('div')
      upsell.className = 'char-upsell'
      upsell.innerHTML =
        'Guests get <b>one</b> drifter, tied to this connection. ' +
        '<a href="https://hobo.tools" target="_blank" rel="noopener">Sign in with hobo.tools</a> ' +
        'to unlock <b>3 character slots</b> and keep your progress safe across devices and IP changes.'
      panel.appendChild(upsell)
    }
    overlay.appendChild(panel)
    uiRoot.appendChild(overlay)
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
