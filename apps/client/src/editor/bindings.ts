/**
 * Centralized editor keybindings: every keyboard action routes through one
 * structured, remappable system (KeyboardEvent.code + modifiers), with
 * conflict detection for the settings UI. Pure module — unit tested.
 */

export interface Binding {
  code: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
}

export interface ActionDef {
  id: string
  label: string
  group: 'camera' | 'tools' | 'transform' | 'edit' | 'terrain' | 'ui'
  default: Binding
  /** Held key (movement) rather than a triggered action. */
  hold?: boolean
  /** Input context: same chord in DIFFERENT contexts is not a conflict. */
  context?: 'global' | 'camera-fly' | 'camera-drag' | 'placement' | 'selection'
}

export const ACTIONS: ActionDef[] = [
  // Camera
  {
    id: 'cam.forward',
    label: 'Camera forward',
    group: 'camera',
    default: { code: 'KeyW' },
    hold: true,
  },
  { id: 'cam.back', label: 'Camera back', group: 'camera', default: { code: 'KeyS' }, hold: true },
  { id: 'cam.left', label: 'Camera left', group: 'camera', default: { code: 'KeyA' }, hold: true },
  {
    id: 'cam.right',
    label: 'Camera right',
    group: 'camera',
    default: { code: 'KeyD' },
    hold: true,
  },
  { id: 'cam.up', label: 'Camera fly up', group: 'camera', default: { code: 'KeyE' }, hold: true },
  {
    id: 'cam.down',
    label: 'Camera fly down',
    group: 'camera',
    default: { code: 'KeyC' },
    hold: true,
  },
  {
    id: 'cam.fast',
    label: 'Camera fast (hold)',
    group: 'camera',
    default: { code: 'ShiftLeft' },
    hold: true,
    context: 'camera-fly',
  },
  {
    id: 'cam.pan',
    label: 'MMB pan modifier (hold)',
    group: 'camera',
    default: { code: 'ShiftLeft' },
    hold: true,
    context: 'camera-drag',
  },
  { id: 'cam.freelook', label: 'Toggle free-look', group: 'camera', default: { code: 'KeyZ' } },
  { id: 'cam.frame', label: 'Frame selection', group: 'camera', default: { code: 'KeyF' } },
  // Tools
  { id: 'tool.terrain', label: 'Terrain tool', group: 'tools', default: { code: 'Digit1' } },
  { id: 'tool.paint', label: 'Paint tool', group: 'tools', default: { code: 'Digit2' } },
  { id: 'tool.entity', label: 'Entity tool', group: 'tools', default: { code: 'Digit3' } },
  { id: 'tool.mesh', label: 'Mesh tool', group: 'tools', default: { code: 'Digit4' } },
  { id: 'tool.select', label: 'Select tool', group: 'tools', default: { code: 'Digit5' } },
  { id: 'tool.face', label: 'Face edit tool', group: 'tools', default: { code: 'Digit6' } },
  { id: 'tool.light', label: 'Light tool', group: 'tools', default: { code: 'Digit7' } },
  // Transform
  { id: 'xf.move', label: 'Gizmo: move (grab)', group: 'transform', default: { code: 'KeyG' } },
  { id: 'xf.rotate', label: 'Gizmo: rotate', group: 'transform', default: { code: 'KeyR' } },
  { id: 'xf.scale', label: 'Gizmo: scale', group: 'transform', default: { code: 'KeyT' } },
  {
    id: 'xf.nosnap',
    label: 'Bypass snapping (hold)',
    group: 'transform',
    default: { code: 'AltLeft' },
    hold: true,
    context: 'selection',
  },
  {
    id: 'place.fine',
    label: 'Fine placement rotation (hold)',
    group: 'transform',
    default: { code: 'AltLeft' },
    hold: true,
    context: 'placement',
  },
  // Editing
  { id: 'edit.undo', label: 'Undo', group: 'edit', default: { code: 'KeyZ', ctrl: true } },
  {
    id: 'edit.redo',
    label: 'Redo',
    group: 'edit',
    default: { code: 'KeyZ', ctrl: true, shift: true },
  },
  {
    id: 'edit.duplicate',
    label: 'Duplicate',
    group: 'edit',
    default: { code: 'KeyD', ctrl: true },
  },
  { id: 'edit.delete', label: 'Delete selection', group: 'edit', default: { code: 'Delete' } },
  {
    id: 'edit.cancel',
    label: 'Clear selection / cancel',
    group: 'edit',
    default: { code: 'Escape' },
  },
  { id: 'edit.save', label: 'Save map', group: 'edit', default: { code: 'KeyS', ctrl: true } },
  // Terrain
  {
    id: 'brush.radiusUp',
    label: 'Brush radius +',
    group: 'terrain',
    default: { code: 'BracketRight' },
  },
  {
    id: 'brush.radiusDown',
    label: 'Brush radius −',
    group: 'terrain',
    default: { code: 'BracketLeft' },
  },
  {
    id: 'brush.strengthUp',
    label: 'Brush strength +',
    group: 'terrain',
    default: { code: 'BracketRight', shift: true },
  },
  {
    id: 'brush.strengthDown',
    label: 'Brush strength −',
    group: 'terrain',
    default: { code: 'BracketLeft', shift: true },
  },
  // UI
  { id: 'ui.sidebar', label: 'Toggle sidebar', group: 'ui', default: { code: 'Backquote' } },
  { id: 'ui.settings', label: 'Settings', group: 'ui', default: { code: 'F2' } },
]

/** Both Shift keys count as the fast/nosnap modifier; normalize codes. */
function normCode(code: string): string {
  if (code === 'ShiftRight') return 'ShiftLeft'
  if (code === 'AltRight') return 'AltLeft'
  if (code === 'ControlRight') return 'ControlLeft'
  return code
}

export function bindingMatches(b: Binding, e: KeyboardEvent): boolean {
  if (normCode(e.code) !== normCode(b.code)) return false
  const isMod = ['ShiftLeft', 'AltLeft', 'ControlLeft', 'MetaLeft'].includes(normCode(b.code))
  if (isMod) return true // hold-modifiers match regardless of other modifiers
  if (b.meta !== undefined) {
    // Explicit meta binding: meta must match exactly, ctrl separately.
    if (Boolean(b.meta) !== e.metaKey) return false
    if (Boolean(b.ctrl) !== e.ctrlKey) return false
  } else {
    // Convention: ctrl bindings accept Cmd on macOS.
    if (Boolean(b.ctrl) !== (e.ctrlKey || e.metaKey)) return false
  }
  if (Boolean(b.shift) !== e.shiftKey) return false
  if (Boolean(b.alt) !== e.altKey) return false
  return true
}

export function formatBinding(b: Binding): string {
  const mods = [b.ctrl && 'Ctrl', b.shift && 'Shift', b.alt && 'Alt', b.meta && 'Meta'].filter(
    Boolean,
  )
  const key = b.code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace('BracketLeft', '[')
    .replace('BracketRight', ']')
    .replace('Backquote', '`')
    .replace('ShiftLeft', 'Shift')
    .replace('AltLeft', 'Alt')
    .replace('ControlLeft', 'Ctrl')
  return [...mods, key].join('+')
}

export function bindingFromEvent(e: KeyboardEvent): Binding {
  const code = normCode(e.code)
  const isMod = ['ShiftLeft', 'AltLeft', 'ControlLeft', 'MetaLeft'].includes(code)
  if (isMod) return { code }
  return {
    code,
    ...(e.ctrlKey ? { ctrl: true } : {}),
    ...(e.shiftKey ? { shift: true } : {}),
    ...(e.altKey ? { alt: true } : {}),
    ...(e.metaKey ? { meta: true } : {}),
  }
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return (
    normCode(a.code) === normCode(b.code) &&
    Boolean(a.ctrl) === Boolean(b.ctrl) &&
    Boolean(a.shift) === Boolean(b.shift) &&
    Boolean(a.alt) === Boolean(b.alt) &&
    Boolean(a.meta) === Boolean(b.meta)
  )
}

/** Action ids whose current binding collides with `b` (excluding `except`). */
export function findConflicts(
  bindings: Record<string, Binding>,
  b: Binding,
  except?: string,
): string[] {
  const ctxOf = (id: string): string => ACTIONS.find((a) => a.id === id)?.context ?? 'global'
  const myCtx = except ? ctxOf(except) : 'global'
  return Object.entries(bindings)
    .filter(([id, cur]) => {
      if (id === except || !sameBinding(cur, b)) return false
      const otherCtx = ctxOf(id)
      // Distinct non-global contexts can intentionally share a chord.
      if (myCtx !== 'global' && otherCtx !== 'global' && myCtx !== otherCtx) return false
      return true
    })
    .map(([id]) => id)
}

export function defaultBindings(): Record<string, Binding> {
  const out: Record<string, Binding> = {}
  for (const a of ACTIONS) out[a.id] = { ...a.default }
  return out
}

export function loadBindings(stored: string | null): Record<string, Binding> {
  const base = defaultBindings()
  if (!stored) return base
  try {
    const saved = JSON.parse(stored) as Record<string, Binding>
    for (const [id, b] of Object.entries(saved)) {
      if (base[id] && typeof b.code === 'string') base[id] = b
    }
  } catch {
    /* corrupted -> defaults */
  }
  return base
}
