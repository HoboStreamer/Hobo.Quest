import { describe, expect, it, vi } from 'vitest'
import { LockController, type LockControllerEvents, type LockOwner } from './lockController.js'

const me = 1
const them = 2

function setup(events: LockControllerEvents = {}) {
  const request = vi.fn()
  const release = vi.fn()
  const lc = new LockController({ request, release }, events)
  lc.setPeerId(me)
  return { lc, request, release }
}

const owners = (...entries: [string, number][]): Map<string, LockOwner> =>
  new Map(
    entries.map(([id, peerId]) => [
      id,
      { peerId, name: peerId === me ? 'Me' : 'Ada', color: '#ff00ff' },
    ]),
  )

describe('LockController: acquiring', () => {
  it('asks the server and stays pending until granted', () => {
    const { lc, request } = setup()
    expect(lc.acquire(['a'])).toBe(false)
    expect(lc.current).toBe('pending')
    expect(request).toHaveBeenCalledWith(['a'])
    lc.granted(['a'])
    expect(lc.current).toBe('owned')
  })

  it('runs the queued gesture on the grant, not before', () => {
    const then = vi.fn()
    const { lc } = setup()
    lc.acquire(['a'], then)
    expect(then).not.toHaveBeenCalled()
    lc.granted(['a'])
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('proceeds immediately when the locks are already held', () => {
    const { lc, request } = setup()
    lc.acquire(['a'])
    lc.granted(['a'])
    request.mockClear()
    expect(lc.acquire(['a'])).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('acquiring nothing is trivially fine', () => {
    const { lc, request } = setup()
    expect(lc.acquire([])).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('LockController: denial', () => {
  it('refuses locally when someone else already holds one of the ids', () => {
    const onDenied = vi.fn()
    const { lc, request } = setup({ onDenied })
    lc.setOwners(owners(['a', them]))
    expect(lc.acquire(['a'])).toBe(false)
    expect(lc.current).toBe('denied')
    expect(onDenied).toHaveBeenCalledWith('Ada')
    // No point asking the server for something it just told us is taken.
    expect(request).not.toHaveBeenCalled()
  })

  it('is ALL OR NOTHING for a group — a half-moved group is worse than none', () => {
    const { lc, request } = setup()
    lc.setOwners(owners(['b', them]))
    expect(lc.acquire(['a', 'b', 'c'])).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(lc.canEditAll(['a', 'c'])).toBe(true)
    expect(lc.canEditAll(['a', 'b'])).toBe(false)
  })

  it('handles a server denial after the request went out', () => {
    const onDenied = vi.fn()
    const { lc } = setup({ onDenied })
    lc.acquire(['a'])
    lc.denied('Ada')
    expect(lc.current).toBe('denied')
    expect(onDenied).toHaveBeenCalledWith('Ada')
  })

  it('lets you SELECT something someone else is editing', () => {
    // Read-only inspection is always allowed; only mutation is refused.
    const { lc } = setup()
    lc.setOwners(owners(['a', them]))
    expect(lc.canEdit('a')).toBe(false)
    expect(lc.ownerOf('a')?.name).toBe('Ada')
  })

  it('does not treat our OWN lock as someone else holding it', () => {
    const { lc } = setup()
    lc.setOwners(owners(['a', me]))
    expect(lc.canEdit('a')).toBe(true)
    expect(lc.ownerOf('a')).toBeNull()
    expect(lc.remoteLocks().size).toBe(0)
  })
})

describe('LockController: losing a lease', () => {
  it('detects the server no longer attributing our lock to us', () => {
    const onLost = vi.fn()
    const { lc } = setup({ onLost })
    lc.acquire(['a'])
    lc.granted(['a'])
    lc.setOwners(owners(['a', them]))
    expect(lc.current).toBe('lost')
    expect(onLost).toHaveBeenCalledTimes(1)
    expect(lc.heldIds).toEqual([])
  })

  it('treats an expired lock (owned by nobody) as lost too', () => {
    const onLost = vi.fn()
    const { lc } = setup({ onLost })
    lc.acquire(['a'])
    lc.granted(['a'])
    lc.setOwners(new Map())
    expect(lc.current).toBe('lost')
    expect(onLost).toHaveBeenCalled()
  })

  it('does not cry lost while a lock is merely pending', () => {
    const onLost = vi.fn()
    const { lc } = setup({ onLost })
    lc.acquire(['a'])
    lc.setOwners(new Map())
    expect(onLost).not.toHaveBeenCalled()
  })
})

describe('LockController: releasing', () => {
  it('gives held locks back', () => {
    const { lc, release } = setup()
    lc.acquire(['a', 'b'])
    lc.granted(['a', 'b'])
    lc.release()
    expect(release).toHaveBeenCalledWith(['a', 'b'])
    expect(lc.current).toBe('unlocked')
  })

  it('releasing nothing sends nothing', () => {
    const { lc, release } = setup()
    lc.release()
    expect(release).not.toHaveBeenCalled()
  })

  it('a disconnect forgets everything locally without sending', () => {
    const { lc, release } = setup()
    lc.acquire(['a'])
    lc.granted(['a'])
    lc.setOwners(owners(['b', them]))
    lc.disconnected()
    expect(release).not.toHaveBeenCalled()
    expect(lc.current).toBe('unlocked')
    expect(lc.heldIds).toEqual([])
    expect(lc.remoteLocks().size).toBe(0)
  })

  it('can reacquire after the other user releases', () => {
    const { lc } = setup()
    lc.setOwners(owners(['a', them]))
    expect(lc.acquire(['a'])).toBe(false)
    lc.setOwners(new Map())
    expect(lc.canEdit('a')).toBe(true)
    expect(lc.acquire(['a'])).toBe(false) // now pending, not denied
    expect(lc.current).toBe('pending')
  })
})
