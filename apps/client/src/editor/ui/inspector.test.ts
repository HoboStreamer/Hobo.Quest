// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blankHeights } from '@hobo/content'
import { EditorDocument } from '../document/editorDocument.js'
import { Inspector, commonFields, displayValue, fieldsFor } from './inspector.js'

const box = (id: string, over: Record<string, unknown> = {}): never =>
  ({
    id,
    shape: { type: 'box', size: [2, 2, 2] },
    pos: [0, 0, 0],
    yaw: 0,
    color: '#ffffff',
    ...over,
  }) as never

const keys = (specs: { key: string }[]): string[] => specs.map((f) => f.key)

describe('fieldsFor', () => {
  it('shows dimensions and transform scale SEPARATELY', () => {
    // A 2 m box scaled x3 and a 6 m box collide identically but mean
    // different things to an author.
    const f = keys(fieldsFor('static', box('s') as never))
    expect(f).toContain('shape.size')
    expect(f).toContain('scale')
  })

  it('matches the dimension fields to the shape', () => {
    expect(
      keys(
        fieldsFor(
          'static',
          box('s', { shape: { type: 'cylinder', radius: 1, height: 2 } }) as never,
        ),
      ),
    ).toEqual(expect.arrayContaining(['shape.radius', 'shape.height']))
    expect(
      keys(fieldsFor('static', box('s', { shape: { type: 'sphere', radius: 1 } }) as never)),
    ).not.toContain('shape.height')
  })

  it('shows only the light fields that light type actually has', () => {
    const point = keys(fieldsFor('light', { id: 'l', type: 'point', pos: [0, 0, 0] } as never))
    const spot = keys(fieldsFor('light', { id: 'l', type: 'spot', pos: [0, 0, 0] } as never))
    const hemi = keys(fieldsFor('light', { id: 'l', type: 'hemi', pos: [0, 0, 0] } as never))
    expect(point).not.toContain('angle')
    expect(spot).toContain('angle')
    expect(spot).toContain('exponent')
    expect(hemi).toContain('ground')
    expect(hemi).not.toContain('range')
    // A hemispheric light casts no shadows.
    expect(hemi).not.toContain('shadows')
  })

  it('gives a zone its bounds and its three rules', () => {
    const f = keys(fieldsFor('zone', null))
    expect(f).toEqual(
      expect.arrayContaining(['name', 'min', 'max', 'rules.pvp', 'rules.build', 'rules.physgun']),
    )
  })

  it('omits rotation for a resource node, which has no facing', () => {
    expect(keys(fieldsFor('node', null))).not.toContain('rot')
  })

  it('omits scale where non-uniform scale is meaningless', () => {
    expect(keys(fieldsFor('prop', null))).not.toContain('scale')
    expect(
      keys(fieldsFor('light', { id: 'l', type: 'point', pos: [0, 0, 0] } as never)),
    ).not.toContain('scale')
  })
})

describe('commonFields', () => {
  it('shows the intersection for a mixed selection', () => {
    const doc = new EditorDocument()
    doc.add('static', box('s'))
    doc.add('terrain', {
      id: 't',
      pos: [0, 0, 0],
      halfExtent: 8,
      sub: 4,
      heights: blankHeights(4),
    } as never)
    const { fields } = commonFields(doc, ['s', 't'])
    expect(keys(fields)).toContain('pos')
    // Only the static has a shape.
    expect(keys(fields)).not.toContain('shape.size')
  })

  it('returns nothing for an empty selection', () => {
    expect(commonFields(new EditorDocument(), []).fields).toEqual([])
  })
})

describe('displayValue', () => {
  const doc = (): EditorDocument => {
    const d = new EditorDocument()
    d.add('static', box('a', { pos: [1, 2, 3], color: '#111111' }))
    d.add('static', box('b', { pos: [1, 9, 3], color: '#111111' }))
    return d
  }

  it('shows the shared value', () => {
    const d = doc()
    const field = fieldsFor('static', d.get('a')!).find((f) => f.key === 'pos')!
    expect(displayValue(d, ['a', 'b'], field, 0)).toBe(1)
  })

  it('shows null — an em dash — where values disagree, NOT a zero', () => {
    // Rendering 0 for "these differ" invites applying 0 to all of them.
    const d = doc()
    const field = fieldsFor('static', d.get('a')!).find((f) => f.key === 'pos')!
    expect(displayValue(d, ['a', 'b'], field, 1)).toBeNull()
  })

  it('reports an ABSENT scale as 1, never 0', () => {
    const d = doc()
    const field = fieldsFor('static', d.get('a')!).find((f) => f.key === 'scale')!
    expect(displayValue(d, ['a'], field, 0)).toBe(1)
  })

  it('handles strings and booleans', () => {
    const d = new EditorDocument()
    d.add('zone', {
      id: 'z1',
      name: 'A',
      min: [0, 0, 0],
      max: [1, 1, 1],
      rules: { pvp: false, build: true, physgun: true },
    } as never)
    d.add('zone', {
      id: 'z2',
      name: 'B',
      min: [0, 0, 0],
      max: [1, 1, 1],
      rules: { pvp: true, build: true, physgun: true },
    } as never)
    const fields = fieldsFor('zone', d.get('z1')!)
    expect(
      displayValue(
        d,
        ['z1'],
        fields.find((f) => f.key === 'name')!,
      ),
    ).toBe('A')
    expect(
      displayValue(
        d,
        ['z1', 'z2'],
        fields.find((f) => f.key === 'name')!,
      ),
    ).toBeNull()
    expect(
      displayValue(
        d,
        ['z1', 'z2'],
        fields.find((f) => f.key === 'rules.build')!,
      ),
    ).toBe(true)
    expect(
      displayValue(
        d,
        ['z1', 'z2'],
        fields.find((f) => f.key === 'rules.pvp')!,
      ),
    ).toBeNull()
  })
})

describe('Inspector DOM', () => {
  let root: HTMLElement
  const callbacks = { setProperty: vi.fn() }

  beforeEach(() => {
    document.body.innerHTML = ''
    root = document.createElement('div')
    document.body.append(root)
    callbacks.setProperty.mockReset()
  })

  const withStatic = (): { doc: EditorDocument; inspector: Inspector } => {
    const doc = new EditorDocument()
    doc.add('static', box('s1', { pos: [1, 2, 3] }))
    const inspector = new Inspector(root, doc, callbacks)
    inspector.setState({ ids: ['s1'], lockedBy: null })
    return { doc, inspector }
  }

  it('says so when nothing is selected', () => {
    new Inspector(root, new EditorDocument(), callbacks).setState({ ids: [], lockedBy: null })
    expect(root.querySelector('.inspector-empty')?.textContent).toBe('Nothing selected')
  })

  it('renders the fields for the selected kind', () => {
    withStatic()
    expect(root.querySelector('[data-field="pos"][data-component="0"]')).not.toBeNull()
    expect(root.querySelector('[data-field="color"]')).not.toBeNull()
  })

  it('fills the values from the document', () => {
    withStatic()
    const y = root.querySelector('[data-field="pos"][data-component="1"]') as HTMLInputElement
    expect(y.value).toBe('2')
  })

  it('shows an em dash where a multi-selection disagrees', () => {
    const doc = new EditorDocument()
    doc.add('static', box('a', { pos: [0, 1, 0] }))
    doc.add('static', box('b', { pos: [0, 5, 0] }))
    const inspector = new Inspector(root, doc, callbacks)
    inspector.setState({ ids: ['a', 'b'], lockedBy: null })
    const y = root.querySelector('[data-field="pos"][data-component="1"]') as HTMLInputElement
    expect(y.value).toBe('—')
  })

  it('routes an edit through the callback, never straight to the document', () => {
    const { doc } = withStatic()
    const x = root.querySelector('[data-field="pos"][data-component="0"]') as HTMLInputElement
    x.value = '12'
    x.dispatchEvent(new Event('change'))
    expect(callbacks.setProperty).toHaveBeenCalledWith(['s1'], 'pos[0]', 12)
    // The inspector itself does not mutate.
    expect(doc.get('s1', 'static')!.pos[0]).toBe(1)
  })

  it('ignores unparseable numeric input and restores the true value', () => {
    withStatic()
    const x = root.querySelector('[data-field="pos"][data-component="0"]') as HTMLInputElement
    x.value = 'banana'
    x.dispatchEvent(new Event('change'))
    expect(callbacks.setProperty).not.toHaveBeenCalled()
    expect(x.value).toBe('1')
  })

  it('is readable but not editable while another user holds the lock', () => {
    const doc = new EditorDocument()
    doc.add('static', box('s1'))
    const inspector = new Inspector(root, doc, callbacks)
    inspector.setState({ ids: ['s1'], lockedBy: 'Ada' })
    expect(root.querySelector('.inspector-lock')?.textContent).toContain('Ada')
    const x = root.querySelector('[data-field="pos"][data-component="0"]') as HTMLInputElement
    expect(x.hasAttribute('disabled')).toBe(true)
    x.value = '99'
    x.dispatchEvent(new Event('change'))
    expect(callbacks.setProperty).not.toHaveBeenCalled()
  })

  it('refreshes values in place — a gizmo drag must not rebuild the panel', () => {
    const { doc, inspector } = withStatic()
    const before = root.querySelector('[data-field="pos"][data-component="0"]')
    doc.update('s1', { pos: [7, 2, 3] })
    inspector.refreshValues()
    expect(root.querySelector('[data-field="pos"][data-component="0"]')).toBe(before)
    expect((before as HTMLInputElement).value).toBe('7')
  })

  it('converts a rotation to degrees for the author', () => {
    const doc = new EditorDocument()
    doc.add('static', box('s1', { rot: [0, Math.PI / 2, 0] }))
    new Inspector(root, doc, callbacks).setState({ ids: ['s1'], lockedBy: null })
    const y = root.querySelector('[data-field="rot"][data-component="1"]') as HTMLInputElement
    expect(y.value).toBe('90')
  })
})
