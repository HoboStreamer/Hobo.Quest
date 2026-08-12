/**
 * The workspace DOM, built in code.
 *
 * `editor.html` used to be 800 lines of markup with ~100 ids that `boot()`
 * reached into by hand, so the shape of the UI lived in two places and every
 * new control meant editing both. The HTML is now a shell — canvas, mount
 * point, dialogs — and the structure is built here next to the code that
 * drives it.
 *
 * Panels get their content from the panel classes; this only creates the
 * frame, the toolbar and the controls that belong to no panel (the brush,
 * the placement pickers).
 */
import { ACTIONS } from '../bindings.js'
import { ENTITY_DEFS, PLACEABLES, TEXTURES, type Tool } from '../catalog.js'

export interface ShellElements {
  root: HTMLElement
  toolbar: HTMLElement
  tools: HTMLElement
  outliner: HTMLElement
  outlinerFilter: HTMLInputElement
  inspector: HTMLElement
  viewport: HTMLElement
  dock: HTMLElement
  dockTabs: HTMLElement
  dockPanels: Record<string, HTMLElement>
  status: HTMLElement
  message: HTMLElement
  /** Tool-specific control strips shown above the dock. */
  brush: HTMLElement
  placement: HTMLElement
  face: HTMLElement
  light: HTMLElement
  zone: HTMLElement
  resizers: { outliner: HTMLElement; inspector: HTMLElement; dock: HTMLElement }
  collapse: Record<'outliner' | 'inspector' | 'dock', HTMLButtonElement>
}

export const TOOLS: [Tool, string, string][] = [
  ['select', '⬚', 'Select'],
  ['mesh', '⬛', 'Geometry'],
  ['entity', '🌳', 'Entities'],
  ['terrain', '⛰', 'Terrain'],
  ['paint', '🖌', 'Paint'],
  ['face', '▦', 'Face'],
  ['light', '💡', 'Light'],
  ['zone', '🟦', 'Zone'],
]

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  id?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (id) node.id = id
  return node
}

const labelled = (text: string, control: HTMLElement): HTMLElement => {
  const wrap = el('label', 'ctl')
  const span = el('span')
  span.textContent = text
  wrap.append(span, control)
  return wrap
}

function slider(
  id: string,
  min: number,
  max: number,
  step: number,
  value: number,
): HTMLInputElement {
  const input = el('input', undefined, id)
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)
  return input
}

function select(id: string, options: { value: string; label: string }[]): HTMLSelectElement {
  const s = el('select', undefined, id)
  for (const o of options) {
    const opt = el('option')
    opt.value = o.value
    opt.textContent = o.label
    s.append(opt)
  }
  return s
}

const textureOptions = (): { value: string; label: string }[] => [
  { value: '', label: '— none —' },
  ...TEXTURES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') })),
]

/** Build the workspace into `mount` and return every element the app drives. */
export function buildShell(mount: HTMLElement, canvas: HTMLCanvasElement): ShellElements {
  const root = el('div', 'workspace', 'workspace')

  // ── Toolbar ─────────────────────────────────────────────────────────
  const toolbar = el('div', 'toolbar')
  const tools = el('div', 'tools', 'tools')
  for (const [id, icon, title] of TOOLS) {
    const b = el('button', 'tool', `tool-${id}`)
    b.type = 'button'
    b.dataset['tool'] = id
    b.textContent = icon
    b.title = `${title} — click again to put the tool away`
    tools.append(b)
  }
  const gizmoModes = el('div', 'gizmo-modes')
  for (const [id, icon, title] of [
    ['move', '✥', 'Move'],
    ['rotate', '⟳', 'Rotate'],
    ['scale', '⤢', 'Scale'],
  ] as const) {
    const b = el('button', 'gm', `gm-${id}`)
    b.type = 'button'
    b.textContent = icon
    b.title = title
    gizmoModes.append(b)
  }
  const spaceBtn = el('button', 'mini', 'xf-space')
  spaceBtn.type = 'button'
  spaceBtn.textContent = 'World'
  spaceBtn.title = 'Transform space (World / Local)'

  const right = el('div', 'toolbar-right')
  const key = el('input', undefined, 'key')
  key.type = 'password'
  key.placeholder = 'admin token'
  key.size = 14
  const save = el('button', 'primary', 'save')
  save.type = 'button'
  save.textContent = '💾 Save map (applies live)'
  const exportBtn = el('button', 'mini', 'map-export')
  exportBtn.type = 'button'
  exportBtn.textContent = '⬇ Export'
  const importLabel = el('label', 'mini')
  importLabel.textContent = '⬆ Import'
  const importInput = el('input', undefined, 'map-import')
  importInput.type = 'file'
  importInput.accept = 'application/json,.json'
  importInput.hidden = true
  importLabel.append(importInput)
  const settings = el('button', 'mini', 'settings-btn')
  settings.type = 'button'
  settings.textContent = '⚙'
  settings.title = 'Keyboard shortcuts'
  right.append(key, save, exportBtn, importLabel, settings)
  toolbar.append(tools, gizmoModes, spaceBtn, right)

  // ── Columns ─────────────────────────────────────────────────────────
  const outliner = el('section', 'panel outliner-panel')
  const outlinerHead = el('div', 'panel-head')
  const outlinerTitle = el('span')
  outlinerTitle.textContent = 'Outliner'
  const outlinerCollapse = el('button', 'panel-collapse', 'collapse-outliner')
  outlinerCollapse.type = 'button'
  outlinerCollapse.textContent = '⟨'
  outlinerCollapse.title = 'Collapse'
  const outlinerFilter = el('input', 'panel-filter')
  outlinerFilter.type = 'search'
  outlinerFilter.placeholder = 'Filter…'
  outlinerHead.append(outlinerTitle, outlinerCollapse)
  const outlinerBody = el('div', 'panel-body', 'outliner-body')
  outliner.append(outlinerHead, outlinerFilter, outlinerBody)

  const inspector = el('section', 'panel inspector-panel')
  const inspectorHead = el('div', 'panel-head')
  const inspectorTitle = el('span')
  inspectorTitle.textContent = 'Inspector'
  const inspectorCollapse = el('button', 'panel-collapse', 'collapse-inspector')
  inspectorCollapse.type = 'button'
  inspectorCollapse.textContent = '⟩'
  inspectorCollapse.title = 'Collapse'
  inspectorHead.append(inspectorTitle, inspectorCollapse)
  const inspectorBody = el('div', 'panel-body', 'inspector-body')
  inspector.append(inspectorHead, inspectorBody)

  const viewport = el('div', 'viewport')
  // Tool control strips float over the viewport's bottom edge: they belong
  // to the active tool, not to a dock tab, and they must not push it around.
  const brush = el('div', 'strip', 'brush-strip')
  brush.append(
    labelled('Radius', slider('radius', 1, 40, 0.5, 6)),
    labelled('Strength', slider('strength', 0.05, 2, 0.05, 0.6)),
    labelled('Feather', slider('feather', 0.2, 6, 0.1, 1)),
    labelled(
      'Mode',
      select('terrain-mode', [
        { value: 'sculpt', label: 'Sculpt' },
        { value: 'smooth', label: 'Smooth' },
        { value: 'flatten', label: 'Flatten' },
      ]),
    ),
    labelled('Paint', select('paint-tex', textureOptions())),
    labelled('Tint', colorInput('paint-color', '#ffffff')),
    labelled('Erase', checkbox('paint-erase')),
  )
  const placement = el('div', 'strip', 'placement-strip')
  placement.append(
    labelled(
      'Geometry',
      select(
        'mesh-sel',
        PLACEABLES.map((p, i) => ({ value: String(i), label: p.name })),
      ),
    ),
    labelled(
      'Entity',
      select(
        'entity-sel',
        ENTITY_DEFS.map((p, i) => ({ value: String(i), label: p.name })),
      ),
    ),
    labelled('Snap', slider('snap', 0, 8, 0.25, 1)),
  )
  // Light and Zone creation controls.
  const light = el('div', 'strip', 'light-strip')
  light.append(
    labelled(
      'Type',
      select('light-type', [
        { value: 'point', label: 'Point' },
        { value: 'spot', label: 'Spot' },
        { value: 'directional', label: 'Directional' },
        { value: 'hemi', label: 'Hemispheric' },
        { value: 'rect', label: 'Rect area' },
      ]),
    ),
    labelled('Colour', colorInput('light-color', '#ffeecc')),
    labelled('Intensity', slider('light-intensity', 0.1, 12, 0.1, 3)),
  )
  const zone = el('div', 'strip', 'zone-strip')
  zone.append(
    labelled('Size', slider('zone-size', 2, 80, 1, 16)),
    labelled('Height', slider('zone-height', 2, 60, 1, 12)),
  )

  const face = el('div', 'strip', 'face-strip')
  const faceInfo = el('span', 'face-info', 'face-info')
  const faceApply = el('button', 'mini', 'f-apply')
  faceApply.type = 'button'
  faceApply.textContent = 'Apply'
  const faceAuto = checkbox('f-auto')
  face.append(
    labelled('Texture', select('f-tex', textureOptions())),
    labelled('Tint', colorInput('f-color', '#ffffff')),
    labelled('Auto', faceAuto),
    faceApply,
    faceInfo,
  )
  viewport.append(canvas, brush, placement, face, light, zone)

  // ── Dock ────────────────────────────────────────────────────────────
  const dock = el('section', 'panel dock-panel')
  const dockHead = el('div', 'panel-head')
  const dockTabs = el('div', 'dock-tabs')
  const dockPanels: Record<string, HTMLElement> = {}
  for (const [id, title] of [
    ['assets', 'Assets'],
    ['issues', 'Issues'],
    ['history', 'History'],
    ['scene', 'Scene'],
  ] as const) {
    const tab = el('button', 'dock-tab', `dock-tab-${id}`)
    tab.type = 'button'
    tab.dataset['tab'] = id
    tab.textContent = title
    dockTabs.append(tab)
    const body = el('div', 'dock-body', `dock-${id}`)
    dockPanels[id] = body
  }
  const dockCollapse = el('button', 'panel-collapse', 'collapse-dock')
  dockCollapse.type = 'button'
  dockCollapse.textContent = '⌄'
  dockCollapse.title = 'Collapse'
  dockHead.append(dockTabs, dockCollapse)
  const dockBody = el('div', 'panel-body')
  dockBody.append(...Object.values(dockPanels))
  dock.append(dockHead, dockBody)

  // ── Status ──────────────────────────────────────────────────────────
  const statusBar = el('div', 'statusbar')
  const status = el('span', 'status-line', 'status-line')
  const message = el('span', 'status-message', 'status')
  statusBar.append(status, message)

  // ── Resizers ────────────────────────────────────────────────────────
  const mkResizer = (cls: string, label: string): HTMLElement => {
    const r = el('div', `resizer ${cls}`)
    r.tabIndex = 0
    r.setAttribute('role', 'separator')
    r.setAttribute('aria-label', label)
    return r
  }
  const resizers = {
    outliner: mkResizer('resizer-x', 'Resize outliner'),
    inspector: mkResizer('resizer-x', 'Resize inspector'),
    dock: mkResizer('resizer-y', 'Resize dock'),
  }

  root.append(
    toolbar,
    outliner,
    resizers.outliner,
    viewport,
    resizers.inspector,
    inspector,
    resizers.dock,
    dock,
    statusBar,
  )
  mount.append(root)

  return {
    root,
    toolbar,
    tools,
    outliner,
    outlinerFilter,
    inspector: inspectorBody,
    viewport,
    dock,
    dockTabs,
    dockPanels,
    status,
    message,
    brush,
    placement,
    face,
    light,
    zone,
    resizers,
    collapse: {
      outliner: outlinerCollapse,
      inspector: inspectorCollapse,
      dock: dockCollapse,
    },
  }
}

function colorInput(id: string, value: string): HTMLInputElement {
  const c = el('input', undefined, id)
  c.type = 'color'
  c.value = value
  return c
}

function checkbox(id: string): HTMLInputElement {
  const c = el('input', undefined, id)
  c.type = 'checkbox'
  return c
}

/** Every keyboard action, for the settings panel's completeness check. */
export const ALL_ACTIONS = ACTIONS
