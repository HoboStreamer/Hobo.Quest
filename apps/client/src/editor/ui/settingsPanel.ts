/**
 * The keybinding settings panel.
 *
 * Self-contained: it owns the bindings map, persists it, and tells the caller
 * when something changed so tool chips and help text can re-render. Nothing
 * about the viewport, the document or the tools leaks in here.
 */
import {
  ACTIONS,
  bindingFromEvent,
  findConflicts,
  formatBinding,
  loadBindings,
  type Binding,
} from '../bindings.js'

const STORAGE_KEY = 'hobo.editor.bindings'

export interface SettingsPanelDeps {
  /** The live bindings map, mutated in place so holders stay in sync. */
  bindings: Record<string, Binding>
  bindingOf: (action: string) => Binding
  /** Called after any change, so hotkey chips and help text can refresh. */
  onChanged: () => void
}

export function createSettingsPanel(deps: SettingsPanelDeps): { render: () => void } {
  const { bindings, bindingOf, onChanged } = deps
  const settingsEl = document.getElementById('settings') as HTMLElement
  const list = document.getElementById('keys-list') as HTMLElement

  const render = (): void => {
    list.replaceChildren()
    let lastGroup = ''
    for (const a of ACTIONS) {
      if (a.group !== lastGroup) {
        lastGroup = a.group
        const h = document.createElement('div')
        h.textContent = a.group.toUpperCase()
        h.style.cssText = 'color:#e8b54a;font-size:10px;letter-spacing:.1em;margin-top:6px'
        list.appendChild(h)
      }
      const row = document.createElement('div')
      row.className = 'krow'
      const lbl = document.createElement('span')
      lbl.textContent = a.label
      const inp = document.createElement('input')
      inp.readOnly = true
      inp.value = formatBinding(bindingOf(a.id))
      inp.addEventListener('focus', () => (inp.value = 'press key…'))
      inp.addEventListener('blur', () => (inp.value = formatBinding(bindingOf(a.id))))
      inp.addEventListener('keydown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        // Bare modifiers are not bindings; Escape just cancels recording.
        if (['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return
        if (e.code === 'Escape') {
          inp.blur()
          return
        }
        const next = bindingFromEvent(e)
        const conflicts = findConflicts(bindings, next, a.id)
        if (conflicts.length > 0) {
          const names = conflicts
            .map((cid) => ACTIONS.find((x) => x.id === cid)?.label ?? cid)
            .join(', ')
          inp.value = `⚠ used by ${names}`
          inp.style.color = '#ff8f6e'
          setTimeout(() => {
            inp.style.color = ''
            inp.value = formatBinding(bindingOf(a.id))
          }, 1600)
          return
        }
        bindings[a.id] = next
        localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings))
        inp.value = formatBinding(next)
        onChanged()
        inp.blur()
      })
      row.append(lbl, inp)
      list.appendChild(row)
    }
  }

  document.getElementById('settings-btn')?.addEventListener('click', () => {
    settingsEl.style.display = settingsEl.style.display === 'flex' ? 'none' : 'flex'
    render()
  })
  document.getElementById('settings-close')?.addEventListener('click', () => {
    settingsEl.style.display = 'none'
  })
  document.getElementById('keys-reset')?.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY)
    const fresh = loadBindings(null)
    for (const k of Object.keys(bindings)) delete bindings[k]
    Object.assign(bindings, fresh)
    render()
    onChanged()
  })

  return { render }
}
