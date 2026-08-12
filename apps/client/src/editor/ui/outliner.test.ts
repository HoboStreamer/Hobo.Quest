// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blankHeights } from '@hobo/content'
import { EditorDocument } from '../document/editorDocument.js'
import { Outliner, buildRows, groupRows, selectModeFor } from './outliner.js'

const box = (id: string, over: Record<string, unknown> = {}): never =>
  ({
    id,
    shape: { type: 'box', size: [1, 1, 1] },
    pos: [0, 0, 0],
    yaw: 0,
    color: '#ffffff',
    ...over,
  }) as never

function populated(): EditorDocument {
  const d = new EditorDocument()
  d.add('terrain', {
    id: 't1',
    pos: [0, 0, 0],
    halfExtent: 8,
    sub: 4,
    heights: blankHeights(4),
  } as never)
  d.add('static', box('s1'))
  d.add('static', box('m1', { model: 'model-a' }))
  d.add('node', { id: 'n1', node: 'oak_tree', pos: [0, 0, 0] } as never)
  d.add('light', { id: 'l1', type: 'point', pos: [0, 3, 0] } as never)
  d.add('zone', {
    id: 'z1',
    name: 'Safe area',
    min: [0, 0, 0],
    max: [1, 1, 1],
    rules: { pvp: false, build: true, physgun: true },
  } as never)
  d.add('spawn', { id: 'spawn', pos: [0, 0, 0], yaw: 0 })
  return d
}

describe('buildRows', () => {
  it('lists exactly the authored objects, with identity', () => {
    // NOT scene traversal: that contains wireframes, gizmo meshes, light
    // widgets and imported-model hierarchies, and lacks stable ids.
    const rows = buildRows(populated(), '')
    expect(rows.map((r) => r.id).sort()).toEqual(['l1', 'm1', 'n1', 's1', 'spawn', 't1', 'z1'])
  })

  it('gives imported model instances their own category', () => {
    const rows = buildRows(populated(), '')
    expect(rows.find((r) => r.id === 'm1')!.group).toBe('Imported models')
    expect(rows.find((r) => r.id === 's1')!.group).toBe('Geometry')
  })

  it('uses an authored name when there is one', () => {
    expect(buildRows(populated(), '').find((r) => r.id === 'z1')!.label).toBe('Safe area')
  })

  it('filters on label and on id', () => {
    const doc = populated()
    expect(buildRows(doc, 'safe').map((r) => r.id)).toEqual(['z1'])
    expect(buildRows(doc, 's1').map((r) => r.id)).toEqual(['s1'])
    expect(buildRows(doc, 'zzz')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(buildRows(populated(), 'SAFE').map((r) => r.id)).toEqual(['z1'])
  })
})

describe('groupRows', () => {
  it('orders groups by the viewport mental model, not the wire', () => {
    const groups = groupRows(buildRows(populated(), '')).map((g) => g.group)
    expect(groups).toEqual([
      'Terrain',
      'Geometry',
      'Imported models',
      'Gameplay',
      'Lights',
      'Zones',
    ])
  })

  it('omits empty groups', () => {
    const doc = new EditorDocument()
    doc.add('static', box('s1'))
    expect(groupRows(buildRows(doc, '')).map((g) => g.group)).toEqual(['Geometry'])
  })
})

describe('selectModeFor', () => {
  it('matches the viewport: Ctrl adds, Alt subtracts, plain replaces', () => {
    expect(selectModeFor({ ctrlKey: false, metaKey: false, altKey: false })).toBe('replace')
    expect(selectModeFor({ ctrlKey: true, metaKey: false, altKey: false })).toBe('add')
    expect(selectModeFor({ ctrlKey: false, metaKey: true, altKey: false })).toBe('add')
    expect(selectModeFor({ ctrlKey: false, metaKey: false, altKey: true })).toBe('subtract')
  })
})

describe('Outliner DOM', () => {
  let root: HTMLElement
  const callbacks = {
    onSelect: vi.fn(),
    onFocus: vi.fn(),
    onToggleVisible: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    root = document.createElement('div')
    document.body.append(root)
    for (const fn of Object.values(callbacks)) fn.mockReset()
  })

  it('renders a row per object plus group headers', () => {
    new Outliner(root, populated(), callbacks).render()
    expect(root.querySelectorAll('.outliner-row')).toHaveLength(7)
    expect(root.querySelectorAll('.outliner-group').length).toBeGreaterThan(0)
  })

  it('says so when the map is empty', () => {
    new Outliner(root, new EditorDocument(), callbacks).render()
    expect(root.querySelector('.outliner-empty')?.textContent).toContain('empty')
  })

  it('distinguishes "no results" from "nothing there"', () => {
    const o = new Outliner(root, populated(), callbacks)
    o.setFilter('zzz')
    expect(root.querySelector('.outliner-empty')?.textContent).toContain('filter')
  })

  it('reports a click with the right selection mode', () => {
    const o = new Outliner(root, populated(), callbacks)
    o.render()
    const row = root.querySelector('[data-id="s1"]')!
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(callbacks.onSelect).toHaveBeenLastCalledWith('s1', 'replace')
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(callbacks.onSelect).toHaveBeenLastCalledWith('s1', 'add')
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
    expect(callbacks.onSelect).toHaveBeenLastCalledWith('s1', 'subtract')
  })

  it('focuses on double click and on Enter', () => {
    const o = new Outliner(root, populated(), callbacks)
    o.render()
    const row = root.querySelector('[data-id="t1"]')!
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(callbacks.onFocus).toHaveBeenCalledTimes(2)
  })

  it('toggles visibility without also selecting the row', () => {
    const o = new Outliner(root, populated(), callbacks)
    o.render()
    root
      .querySelector('[data-id="s1"] .outliner-eye')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(callbacks.onToggleVisible).toHaveBeenCalledWith('s1')
    expect(callbacks.onSelect).not.toHaveBeenCalled()
  })

  it('marks selection and primary without rebuilding rows', () => {
    const o = new Outliner(root, populated(), callbacks)
    o.render()
    const before = root.querySelector('[data-id="s1"]')
    o.setState({ selected: new Set(['s1', 'n1']), primary: 's1' })
    expect(root.querySelector('[data-id="s1"]')).toBe(before)
    expect(before!.classList.contains('selected')).toBe(true)
    expect(before!.classList.contains('primary')).toBe(true)
    expect(root.querySelector('[data-id="n1"]')!.classList.contains('primary')).toBe(false)
  })

  it('shows a collaborator colour and a lock badge', () => {
    const o = new Outliner(root, populated(), callbacks)
    o.render()
    o.setState({
      remote: new Map([['s1', '#ff00ff']]),
      locks: new Map([['s1', 'Ada']]),
    })
    const row = root.querySelector('[data-id="s1"]') as HTMLElement
    expect(row.style.getPropertyValue('--remote')).toBe('#ff00ff')
    expect(row.querySelector('.outliner-badges')!.textContent).toBe('🔒')
    expect(row.querySelector('.outliner-badges')!.getAttribute('title')).toContain('Ada')
  })
})
