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
    // Owning is not the same question as being free: we hold nothing yet.
    expect(lc.ownsAll(['a', 'c'])).toBe(false)
    expect(lc.isFree('a')).toBe(true)
    expect(lc.isFree('b')).toBe(false)
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
    expect(lc.isFree('a')).toBe(false)
    expect(lc.ownerOf('a')?.name).toBe('Ada')
  })

  it('does not treat our OWN lock as someone else holding it', () => {
    const { lc } = setup()
    lc.setOwners(owners(['a', me]))
    expect(lc.isFree('a')).toBe(true)
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
    lc.releaseAll()
    expect(release).toHaveBeenCalledWith(['a', 'b'])
    expect(lc.current).toBe('unlocked')
  })

  it('releases only what a shrinking selection dropped', () => {
    // Keeping a lock on something you deselected blocks a collaborator for
    // no reason at all.
    const { lc, release } = setup()
    lc.acquire(['a', 'b'])
    lc.granted(['a', 'b'])
    lc.release(['b'])
    expect(release).toHaveBeenCalledWith(['b'])
    expect(lc.owns('a')).toBe(true)
    expect(lc.owns('b')).toBe(false)
    expect(lc.current).toBe('owned')
  })

  it('ignores a release of something we never held', () => {
    const { lc, release } = setup()
    lc.acquire(['a'])
    lc.granted(['a'])
    release.mockClear()
    lc.release(['someone-elses'])
    expect(release).not.toHaveBeenCalled()
    expect(lc.owns('a')).toBe(true)
  })

  it('owns() is false until the server actually grants', () => {
    const { lc } = setup()
    lc.acquire(['a'])
    expect(lc.isFree('a')).toBe(true)
    expect(lc.owns('a')).toBe(false)
    lc.granted(['a'])
    expect(lc.owns('a')).toBe(true)
  })

  it('releasing nothing sends nothing', () => {
    const { lc, release } = setup()
    lc.releaseAll()
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
    expect(lc.isFree('a')).toBe(true)
    expect(lc.acquire(['a'])).toBe(false) // now pending, not denied
    expect(lc.current).toBe('pending')
  })
})
