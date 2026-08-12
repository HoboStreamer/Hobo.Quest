// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetBrowser, HistoryPanel, StatusBar, canDeleteAsset, statusText } from './panels.js'

let root: HTMLElement
beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

describe('canDeleteAsset', () => {
  it('allows deleting an unused asset', () => {
    expect(canDeleteAsset(undefined).ok).toBe(true)
    expect(canDeleteAsset({ count: 0, ids: [] }).ok).toBe(true)
  })

  it('REFUSES a referenced asset rather than repairing the map behind you', () => {
    // The repair would be silently retexturing objects nobody selected.
    const verdict = canDeleteAsset({ count: 3, ids: ['a', 'b', 'c'] })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('3 objects')
  })

  it('gets the singular right', () => {
    expect(canDeleteAsset({ count: 1, ids: ['a'] }).reason).toContain('1 object —')
  })
})

describe('AssetBrowser', () => {
  const callbacks = {
    onUseTexture: vi.fn(),
    onPlaceModel: vi.fn(),
    onFindUsages: vi.fn(),
    onDeleteTexture: vi.fn(),
    onDeleteModel: vi.fn(),
    onRenameTexture: vi.fn(),
  }
  beforeEach(() => {
    for (const fn of Object.values(callbacks)) fn.mockReset()
  })

  const browser = (): AssetBrowser => {
    const b = new AssetBrowser(root, callbacks)
    b.setState({
      textures: [
        { name: 'brick', url: '/map-assets/sha256-x.png', scale: 2 },
        { name: 'legacy', dataUrl: 'data:image/png;base64,AAA' },
      ],
      models: [{ id: 'm1', name: 'Chair', glb: '/map-assets/sha256-y.glb', bounds: [1, 1, 1] }],
      textureUsage: new Map([['custom:brick', { count: 2, ids: ['s1', 's2'] }]]),
      modelUsage: new Map(),
    })
    return b
  }

  it('lists custom textures with their usage count', () => {
    browser()
    const items = root.querySelectorAll('.asset-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.querySelector('.asset-meta')!.textContent).toContain('2 uses')
  })

  it('distinguishes a hosted asset from a legacy embedded one', () => {
    browser()
    const metas = [...root.querySelectorAll('.asset-meta')].map((m) => m.textContent)
    expect(metas[0]).toContain('hosted')
    expect(metas[1]).toContain('embedded')
  })

  it('selects a texture on click', () => {
    browser()
    root
      .querySelector('[data-asset="brick"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(callbacks.onUseTexture).toHaveBeenCalledWith('custom:brick')
  })

  it('disables Delete for a referenced asset and enables Find', () => {
    browser()
    const actions = root.querySelector('[data-asset="brick"] .asset-actions')!
    const [find, del] = [...actions.querySelectorAll('button')]
    expect((find as HTMLButtonElement).disabled).toBe(false)
    expect((del as HTMLButtonElement).disabled).toBe(true)
  })

  it('allows deleting an unreferenced asset', () => {
    browser()
    const del = root.querySelectorAll('[data-asset="legacy"] .asset-actions button')[1]!
    expect((del as HTMLButtonElement).disabled).toBe(false)
    del.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(callbacks.onDeleteTexture).toHaveBeenCalledWith('legacy')
  })

  it('finds usages without also selecting the asset', () => {
    browser()
    root
      .querySelectorAll('[data-asset="brick"] .asset-actions button')[0]!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(callbacks.onFindUsages).toHaveBeenCalledWith(['s1', 's2'])
    expect(callbacks.onUseTexture).not.toHaveBeenCalled()
  })

  it('switches to models', () => {
    const b = browser()
    b.setState({ tab: 'models' })
    expect(root.querySelector('[data-asset="m1"]')).not.toBeNull()
    expect(root.querySelector('[data-asset="brick"]')).toBeNull()
  })

  it('filters, and says which kind of empty it is', () => {
    const b = browser()
    b.setState({ filter: 'zzz' })
    expect(root.querySelector('.asset-empty')!.textContent).toBe('Nothing matches')
    b.setState({ filter: '', textures: [] })
    expect(root.querySelector('.asset-empty')!.textContent).toContain('No custom textures')
  })
})

describe('HistoryPanel', () => {
  const state = { depth: 2, redo: 1, dirty: true, label: 'move', bytes: 0 }

  it('shows the ONE history, newest first', () => {
    new HistoryPanel(root, vi.fn()).render(
      [
        { label: 'move box', undone: false },
        { label: 'add box', undone: false },
        { label: 'delete box', undone: true },
      ],
      state,
    )
    const rows = [...root.querySelectorAll('.history-row')].map((r) => r.textContent)
    expect(rows).toEqual(['move box', 'add box', 'delete box'])
    expect(root.querySelectorAll('.history-row.undone')).toHaveLength(1)
  })

  it('reports how many steps back a row is', () => {
    const jump = vi.fn()
    new HistoryPanel(root, jump).render(
      [
        { label: 'a', undone: false },
        { label: 'b', undone: false },
      ],
      state,
    )
    root
      .querySelectorAll('.history-row')[1]!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(jump).toHaveBeenCalledWith(-2)
  })

  it('does not offer to jump to an already-undone step by clicking it', () => {
    const jump = vi.fn()
    new HistoryPanel(root, jump).render([{ label: 'a', undone: true }], state)
    root.querySelector('.history-row')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(jump).not.toHaveBeenCalled()
  })

  it('says when there is nothing to undo', () => {
    new HistoryPanel(root, vi.fn()).render([], { ...state, depth: 0, dirty: false })
    expect(root.querySelector('.history-empty')).not.toBeNull()
  })
})

describe('statusText', () => {
  const base = {
    tool: 'mesh',
    selectionCount: 2,
    primary: 's1',
    transformMode: 'move',
    space: 'world',
    snap: '1m',
    dirty: true,
    revision: 'abcdef1234',
    peers: 1,
    lock: null,
    message: '',
  }

  it('reports the whole editor state in one line', () => {
    const text = statusText(base)
    expect(text).toContain('mesh')
    expect(text).toContain('2 selected')
    expect(text).toContain('s1')
    expect(text).toContain('move · world')
    expect(text).toContain('● unsaved')
    expect(text).toContain('rev abcdef12')
    expect(text).toContain('1 co-editor')
  })

  it('says "no tool" rather than pretending one is active', () => {
    expect(statusText({ ...base, tool: null })).toContain('no tool')
  })

  it('says nothing is selected rather than showing 0', () => {
    expect(statusText({ ...base, selectionCount: 0 })).toContain('nothing selected')
  })

  it('shows a lock owner when there is one', () => {
    expect(statusText({ ...base, lock: 'Ada' })).toContain('🔒 Ada')
    expect(statusText(base)).not.toContain('🔒')
  })
})

describe('StatusBar', () => {
  it('writes the line and any message', () => {
    const bar = document.createElement('div')
    const msg = document.createElement('div')
    root.append(bar, msg)
    new StatusBar(bar, msg).render({
      tool: null,
      selectionCount: 0,
      primary: null,
      transformMode: 'move',
      space: 'world',
      snap: 'off',
      dirty: false,
      revision: '',
      peers: 0,
      lock: null,
      message: 'saved',
    })
    expect(bar.textContent).toContain('no tool')
    expect(msg.textContent).toBe('saved')
  })
})
