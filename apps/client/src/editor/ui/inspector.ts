/**
 * The Inspector: a registry of per-kind property editors.
 *
 * The old inspector was one floating popover with every control for every
 * kind in it, shown and hidden by hand — so a terrain showed cylinder radius
 * fields, a light showed box dimensions, and adding a kind meant another
 * round of `style.display = 'none'`. Here each kind declares the fields it
 * has, and the panel renders exactly those.
 *
 * Multi-selection shows the fields the selection has in COMMON. Where the
 * values disagree the field shows an em dash rather than a zero: an editor
 * that displays 0 for "these differ" invites you to apply 0 to all of them.
 *
 * Every edit goes through the callbacks, which route to CommandHistory.
 * Nothing here writes to the document.
 */
import type { EditorDocument, EditorObject, EditorObjectKind } from '../document/editorDocument.js'
import { KIND_INFO } from '../document/editorObject.js'
import { commonValue, formatNumber } from './numberField.js'

export type FieldType = 'number' | 'text' | 'color' | 'checkbox' | 'select' | 'readonly'

export interface FieldSpec {
  key: string
  label: string
  type: FieldType
  /** Radians in the model, degrees in the box. */
  degrees?: boolean
  step?: number
  min?: number
  max?: number
  options?: { value: string; label: string }[]
  /** Vector components are edited together under one label. */
  vector?: 3
  /** Not editable while another user holds the lock; still readable. */
  section: string
}

export interface InspectorCallbacks {
  /** One edit → one history entry, applied to every selected id. */
  setProperty: (ids: readonly string[], key: string, value: unknown) => void
  /** A scrub gesture: preview without recording. */
  previewProperty?: (ids: readonly string[], key: string, value: unknown) => void
  beginGesture?: (label: string) => void
  endGesture?: () => void
}

const TRANSFORM_SECTION = 'Transform'

/** The transform every transformable kind shares. */
function transformFields(kind: EditorObjectKind): FieldSpec[] {
  const info = KIND_INFO[kind]
  const fields: FieldSpec[] = [
    { key: 'pos', label: 'Position', type: 'number', vector: 3, section: TRANSFORM_SECTION },
  ]
  if (info.rotatable)
    fields.push({
      key: 'rot',
      label: 'Rotation',
      type: 'number',
      vector: 3,
      degrees: true,
      section: TRANSFORM_SECTION,
    })
  if (info.scalable)
    fields.push({
      key: 'scale',
      label: 'Scale',
      type: 'number',
      vector: 3,
      step: 0.1,
      section: TRANSFORM_SECTION,
    })
  return fields
}

/**
 * The fields for a kind. Dimensions and transform scale are DELIBERATELY
 * separate: a 2 m box scaled ×3 and a 6 m box collide identically but mean
 * different things to an author, and conflating them is how a resize ends up
 * changing a shared prefab.
 */
export function fieldsFor(kind: EditorObjectKind, object: EditorObject | null): FieldSpec[] {
  const common = transformFields(kind)
  switch (kind) {
    case 'static': {
      const shape = (object as { shape?: { type: string } } | null)?.shape?.type ?? 'box'
      const dims: FieldSpec[] =
        shape === 'box'
          ? [
              {
                key: 'shape.size',
                label: 'Dimensions',
                type: 'number',
                vector: 3,
                step: 0.1,
                min: 0.01,
                section: 'Shape',
              },
            ]
          : shape === 'cylinder'
            ? [
                {
                  key: 'shape.radius',
                  label: 'Radius',
                  type: 'number',
                  step: 0.1,
                  min: 0.01,
                  section: 'Shape',
                },
                {
                  key: 'shape.height',
                  label: 'Height',
                  type: 'number',
                  step: 0.1,
                  min: 0.01,
                  section: 'Shape',
                },
              ]
            : [
                {
                  key: 'shape.radius',
                  label: 'Radius',
                  type: 'number',
                  step: 0.1,
                  min: 0.01,
                  section: 'Shape',
                },
              ]
      return [
        { key: 'shape.type', label: 'Shape', type: 'readonly', section: 'Shape' },
        ...dims,
        ...common,
        { key: 'color', label: 'Tint', type: 'color', section: 'Surface' },
        { key: 'tex', label: 'Texture', type: 'select', section: 'Surface' },
        { key: 'decor', label: 'Decor', type: 'text', section: 'Surface' },
        { key: 'model', label: 'Model', type: 'readonly', section: 'Surface' },
      ]
    }
    case 'terrain':
      return [
        { key: 'name', label: 'Name', type: 'text', section: 'Terrain' },
        { key: 'halfExtent', label: 'Half extent', type: 'readonly', section: 'Terrain' },
        { key: 'sub', label: 'Resolution', type: 'readonly', section: 'Terrain' },
        ...common,
      ]
    case 'node':
      return [{ key: 'node', label: 'Resource', type: 'readonly', section: 'Node' }, ...common]
    case 'prop':
      return [{ key: 'item', label: 'Item', type: 'readonly', section: 'Prop' }, ...common]
    case 'spawn':
      return common
    case 'light': {
      const type = (object as { type?: string } | null)?.type ?? 'point'
      const fields: FieldSpec[] = [
        {
          key: 'type',
          label: 'Type',
          type: 'select',
          section: 'Light',
          options: ['point', 'spot', 'directional', 'hemi', 'rect'].map((v) => ({
            value: v,
            label: v,
          })),
        },
        ...common,
        { key: 'color', label: 'Diffuse', type: 'color', section: 'Light' },
        { key: 'specular', label: 'Specular', type: 'color', section: 'Light' },
        {
          key: 'intensity',
          label: 'Intensity',
          type: 'number',
          step: 0.1,
          min: 0,
          section: 'Light',
        },
      ]
      // Only what this light type actually has: a hemispheric light has no
      // cone and a point light has no area.
      if (type === 'point' || type === 'spot')
        fields.push({
          key: 'range',
          label: 'Range',
          type: 'number',
          step: 1,
          min: 0,
          section: 'Light',
        })
      if (type === 'spot')
        fields.push(
          {
            key: 'angle',
            label: 'Cone angle',
            type: 'number',
            degrees: true,
            step: 1,
            min: 0,
            section: 'Light',
          },
          {
            key: 'exponent',
            label: 'Exponent',
            type: 'number',
            step: 0.1,
            min: 0,
            section: 'Light',
          },
        )
      if (type === 'hemi')
        fields.push({ key: 'ground', label: 'Ground colour', type: 'color', section: 'Light' })
      if (type === 'rect')
        fields.push({
          key: 'size',
          label: 'Area size',
          type: 'number',
          vector: 3,
          section: 'Light',
        })
      if (type !== 'hemi')
        fields.push({ key: 'shadows', label: 'Cast shadows', type: 'checkbox', section: 'Light' })
      return fields
    }
    case 'zone':
      return [
        { key: 'name', label: 'Name', type: 'text', section: 'Zone' },
        { key: 'min', label: 'Bounds min', type: 'number', vector: 3, section: 'Zone' },
        { key: 'max', label: 'Bounds max', type: 'number', vector: 3, section: 'Zone' },
        { key: 'rules.pvp', label: 'PVP', type: 'checkbox', section: 'Rules' },
        { key: 'rules.build', label: 'Building', type: 'checkbox', section: 'Rules' },
        { key: 'rules.physgun', label: 'Physgun', type: 'checkbox', section: 'Rules' },
      ]
  }
}

/** Fields shared by every selected object, in the first one's order. */
export function commonFields(
  doc: EditorDocument,
  ids: readonly string[],
): { fields: FieldSpec[]; kinds: EditorObjectKind[] } {
  const kinds = [
    ...new Set(ids.map((id) => doc.typeOf(id)).filter((k): k is EditorObjectKind => k !== null)),
  ]
  if (kinds.length === 0) return { fields: [], kinds }
  const perKind = kinds.map((k) => {
    const first = ids.find((id) => doc.typeOf(id) === k)
    return fieldsFor(k, first ? doc.get(first) : null)
  })
  const [head, ...rest] = perKind
  const shared = (head ?? []).filter((f) => rest.every((set) => set.some((g) => g.key === f.key)))
  return { fields: shared, kinds }
}

export const readPath = (object: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | null)?.[k], object)

/**
 * What a field should show for a selection: the shared value, or null when
 * they disagree. `null` renders as an em dash.
 */
export function displayValue(
  doc: EditorDocument,
  ids: readonly string[],
  field: FieldSpec,
  component?: number,
): string | number | boolean | null {
  const raw = ids.map((id) => {
    const value = readPath(doc.get(id), field.key)
    return component === undefined ? value : (value as number[] | undefined)?.[component]
  })
  if (raw.length === 0) return null
  if (field.type === 'number') {
    const numbers = raw.map((v) => (typeof v === 'number' ? v : defaultNumber(field, component)))
    return commonValue(numbers)
  }
  if (field.type === 'checkbox') {
    const bools = raw.map((v) => v === true)
    return bools.every((b) => b === bools[0]) ? bools[0]! : null
  }
  const strings = raw.map((v) => (v === undefined || v === null ? '' : String(v)))
  return strings.every((s) => s === strings[0]) ? strings[0]! : null
}

/**
 * The value an ABSENT property means. Scale is the one that matters: absent
 * scale is 1, and showing 0 for it was the bug that made every newly
 * selected object look like it had been flattened.
 */
function defaultNumber(field: FieldSpec, component?: number): number {
  if (field.key === 'scale') return 1
  if (field.key === 'intensity') return 1
  void component
  return 0
}

export interface InspectorState {
  ids: readonly string[]
  /** Set while another user holds the lock: readable, not editable. */
  lockedBy: string | null
}

export class Inspector {
  private state: InspectorState = { ids: [], lockedBy: null }

  constructor(
    private readonly root: HTMLElement,
    private readonly doc: EditorDocument,
    private readonly callbacks: InspectorCallbacks,
    /** Texture options for `select` fields; supplied by the asset registry. */
    private readonly textureOptions: () => { value: string; label: string }[] = () => [],
  ) {}

  setState(next: InspectorState): void {
    this.state = next
    this.render()
  }

  /** Values only — what a gizmo drag or an undo needs. */
  refreshValues(): void {
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-field]')) {
      const key = el.dataset['field']!
      const component = el.dataset['component']
      const spec = this.specFor(key)
      if (!spec) continue
      const value = displayValue(
        this.doc,
        this.state.ids,
        spec,
        component === undefined ? undefined : Number(component),
      )
      writeValue(el, spec, value)
    }
  }

  private specs: FieldSpec[] = []

  private specFor(key: string): FieldSpec | undefined {
    return this.specs.find((f) => f.key === key)
  }

  private render(): void {
    this.root.textContent = ''
    const { ids, lockedBy } = this.state
    if (ids.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'inspector-empty'
      empty.textContent = 'Nothing selected'
      this.root.append(empty)
      this.specs = []
      return
    }

    const { fields, kinds } = commonFields(this.doc, ids)
    this.specs = fields

    const title = document.createElement('div')
    title.className = 'inspector-title'
    title.textContent =
      ids.length === 1
        ? `${KIND_INFO[kinds[0]!].label} · ${ids[0]}`
        : `${ids.length} objects (${kinds.map((k) => KIND_INFO[k].label).join(', ')})`
    this.root.append(title)

    if (lockedBy) {
      const lock = document.createElement('div')
      lock.className = 'inspector-lock'
      lock.textContent = `🔒 Editing by ${lockedBy}`
      this.root.append(lock)
    }

    for (const section of [...new Set(fields.map((f) => f.section))]) {
      const header = document.createElement('div')
      header.className = 'inspector-section'
      header.textContent = section
      this.root.append(header)
      for (const field of fields.filter((f) => f.section === section))
        this.root.append(this.renderField(field))
    }
    this.refreshValues()
  }

  private renderField(field: FieldSpec): HTMLElement {
    const row = document.createElement('label')
    row.className = 'inspector-row'
    const label = document.createElement('span')
    label.className = 'inspector-label'
    label.textContent = field.label
    row.append(label)

    const inputs = document.createElement('span')
    inputs.className = 'inspector-inputs'
    const count = field.vector ?? 1
    for (let i = 0; i < count; i++)
      inputs.append(this.renderInput(field, count > 1 ? i : undefined))
    row.append(inputs)
    return row
  }

  private renderInput(field: FieldSpec, component?: number): HTMLElement {
    const disabled = this.state.lockedBy !== null || field.type === 'readonly'
    let el: HTMLElement
    if (field.type === 'select') {
      const select = document.createElement('select')
      const options = field.options ?? this.textureOptions()
      for (const opt of options) {
        const o = document.createElement('option')
        o.value = opt.value
        o.textContent = opt.label
        select.append(o)
      }
      select.addEventListener('change', () => this.commit(field, select.value))
      el = select
    } else if (field.type === 'checkbox') {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.addEventListener('change', () => this.commit(field, input.checked))
      el = input
    } else {
      const input = document.createElement('input')
      input.type = field.type === 'color' ? 'color' : 'text'
      if (field.type === 'number') input.classList.add('scrub')
      input.addEventListener('change', () => this.commitInput(field, input, component))
      el = input
    }
    el.dataset['field'] = field.key
    if (component !== undefined) el.dataset['component'] = String(component)
    // Stable ids for the transform vectors: they are the fields people (and
    // the harness) reach for by name.
    const prefix = { pos: 'p', rot: 'r', scale: 's' }[field.key]
    if (prefix && component !== undefined) el.id = `${prefix}-${'xyz'[component]}`
    if (disabled) el.setAttribute('disabled', '')
    return el
  }

  private commitInput(field: FieldSpec, input: HTMLInputElement, component?: number): void {
    // The disabled attribute is an affordance, not a guarantee: check the
    // lock here too, so no path can mutate an object another user holds.
    if (this.state.lockedBy !== null) {
      this.refreshValues()
      return
    }
    if (field.type !== 'number') {
      this.commit(field, input.value)
      return
    }
    const raw = Number.parseFloat(input.value)
    if (!Number.isFinite(raw)) {
      this.refreshValues()
      return
    }
    const model = field.degrees ? (raw * Math.PI) / 180 : raw
    if (component === undefined) {
      this.commit(field, model)
      return
    }
    // A vector component edit writes the WHOLE vector, because that is what
    // the document stores — and because the other components may differ
    // across the selection and must be preserved per object.
    this.callbacks.setProperty(this.state.ids, `${field.key}[${component}]`, model)
  }

  private commit(field: FieldSpec, value: unknown): void {
    if (this.state.lockedBy !== null) return
    this.callbacks.setProperty(this.state.ids, field.key, value)
  }
}

function writeValue(
  el: HTMLElement,
  field: FieldSpec,
  value: string | number | boolean | null,
): void {
  if (el instanceof HTMLSelectElement) {
    el.value = value === null ? '' : String(value)
    return
  }
  if (!(el instanceof HTMLInputElement)) {
    el.textContent = value === null ? '—' : String(value)
    return
  }
  if (el.type === 'checkbox') {
    el.indeterminate = value === null
    el.checked = value === true
    return
  }
  if (value === null) {
    el.value = '—'
    return
  }
  if (field.type === 'number') {
    const shown = field.degrees ? ((value as number) * 180) / Math.PI : (value as number)
    el.value = formatNumber(shown)
    return
  }
  el.value = String(value)
}
