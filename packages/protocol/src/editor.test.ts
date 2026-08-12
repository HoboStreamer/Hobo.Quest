import { describe, expect, it } from 'vitest'
import {
  EDITOR_MAX_IDS,
  EDITOR_MAX_ID_LENGTH,
  EDITOR_MAX_MESSAGE_BYTES,
  decodeEditorClientMessage,
  decodeEditorServerMessage,
  encodeEditorMessage,
  type EditorClientMessage,
  type EditorServerMessage,
} from './editor.js'

const client = (v: unknown): EditorClientMessage | null =>
  decodeEditorClientMessage(JSON.stringify(v))
const server = (v: unknown): EditorServerMessage | null =>
  decodeEditorServerMessage(JSON.stringify(v))

describe('client messages', () => {
  it('round-trips every kind', () => {
    const messages: EditorClientMessage[] = [
      { t: 'hello', key: 'secret', name: 'Ada' },
      { t: 'camera', pos: [1, 2, 3], yaw: 0.5, pitch: -0.2 },
      { t: 'selection', ids: ['a', 'b'] },
      { t: 'lockRequest', ids: ['a'] },
      { t: 'lockRelease', ids: ['a'] },
      { t: 'lockRelease' },
      { t: 'heartbeat' },
    ]
    for (const m of messages)
      expect(decodeEditorClientMessage(encodeEditorMessage(m)), m.t).toEqual(m)
  })

  it('rejects anything it does not recognise', () => {
    expect(client({ t: 'drop-tables' })).toBeNull()
    expect(client({})).toBeNull()
    expect(client(null)).toBeNull()
    expect(client([1, 2, 3])).toBeNull()
    expect(decodeEditorClientMessage('not json')).toBeNull()
  })

  it('requires a key on hello and defaults the name', () => {
    expect(client({ t: 'hello' })).toBeNull()
    expect(client({ t: 'hello', key: '' })).toBeNull()
    expect(client({ t: 'hello', key: 'k' })).toEqual({ t: 'hello', key: 'k', name: 'editor' })
  })

  it('bounds the display name rather than trusting it', () => {
    const long = client({ t: 'hello', key: 'k', name: 'x'.repeat(500) })
    expect(long).toEqual({ t: 'hello', key: 'k', name: 'editor' })
  })

  it('refuses a non-finite camera instead of poisoning presence', () => {
    // A NaN position propagated to every other editor's avatar transform.
    for (const bad of [
      { pos: [1, Number.NaN, 3], yaw: 0, pitch: 0 },
      { pos: [1, 2], yaw: 0, pitch: 0 },
      { pos: 'over there', yaw: 0, pitch: 0 },
      { pos: [1, 2, 3], yaw: Number.POSITIVE_INFINITY, pitch: 0 },
    ])
      expect(client({ t: 'camera', ...bad })).toBeNull()
  })

  it('drops unusable ids instead of failing the whole message', () => {
    // An older peer sending one bad id must not break this one's display.
    const m = client({ t: 'selection', ids: ['ok', 42, '', null, 'also-ok'] })
    expect(m).toEqual({ t: 'selection', ids: ['ok', 'also-ok'] })
  })

  it('caps how many ids one message can carry', () => {
    const m = client({
      t: 'selection',
      ids: Array.from({ length: EDITOR_MAX_IDS + 50 }, (_, i) => `id-${i}`),
    })
    expect(m?.t === 'selection' && m.ids).toHaveLength(EDITOR_MAX_IDS)
  })

  it('caps id length', () => {
    const m = client({ t: 'lockRequest', ids: ['x'.repeat(EDITOR_MAX_ID_LENGTH + 1), 'fine'] })
    expect(m?.t === 'lockRequest' && m.ids).toEqual(['fine'])
  })

  it('refuses an oversized message outright', () => {
    const huge = JSON.stringify({ t: 'selection', ids: ['x'.repeat(EDITOR_MAX_MESSAGE_BYTES)] })
    expect(decodeEditorClientMessage(huge)).toBeNull()
  })

  it('distinguishes "release these" from "release everything"', () => {
    expect(client({ t: 'lockRelease' })).toEqual({ t: 'lockRelease' })
    expect(client({ t: 'lockRelease', ids: [] })).toEqual({ t: 'lockRelease', ids: [] })
  })
})

describe('server messages', () => {
  it('round-trips every kind', () => {
    const messages: EditorServerMessage[] = [
      { t: 'welcome', peerId: 3, color: '#ff9d4d' },
      {
        t: 'presence',
        peerId: 3,
        name: 'Ada',
        color: '#ff9d4d',
        pos: [1, 2, 3],
        yaw: 0,
        pitch: 0,
      },
      { t: 'peerSelection', peerId: 3, name: 'Ada', color: '#ff9d4d', ids: ['a'] },
      { t: 'lockResult', granted: true, ids: ['a'] },
      { t: 'lockState', owners: { a: { peerId: 3, name: 'Ada', color: '#ff9d4d' } } },
      { t: 'mapSaved', revision: 'abc' },
      { t: 'peerGone', peerId: 3 },
    ]
    for (const m of messages)
      expect(decodeEditorServerMessage(encodeEditorMessage(m)), m.t).toEqual(m)
  })

  it('requires a valid colour, so a peer cannot inject arbitrary CSS', () => {
    expect(server({ t: 'welcome', peerId: 1, color: 'red; background:url(x)' })).toBeNull()
    expect(server({ t: 'welcome', peerId: 1, color: '#ff9d4d' })).not.toBeNull()
  })

  it('requires a peer id where one is meaningful', () => {
    expect(server({ t: 'welcome', color: '#ffffff' })).toBeNull()
    expect(server({ t: 'peerGone' })).toBeNull()
  })

  it('drops malformed lock owners rather than rejecting the whole table', () => {
    const m = server({
      t: 'lockState',
      owners: {
        good: { peerId: 1, name: 'Ada', color: '#ff9d4d' },
        noColor: { peerId: 2, name: 'Bob' },
        notAnObject: 5,
      },
    })
    expect(m?.t === 'lockState' && Object.keys(m.owners)).toEqual(['good'])
  })

  it('keeps a denial informative but bounded', () => {
    const m = server({
      t: 'lockResult',
      granted: false,
      ids: ['a'],
      ownerName: 'Ada',
      ownerColor: '#4dc3ff',
    })
    expect(m).toEqual({
      t: 'lockResult',
      granted: false,
      ids: ['a'],
      ownerName: 'Ada',
      ownerColor: '#4dc3ff',
    })
  })

  it('rejects a lockResult without a verdict', () => {
    expect(server({ t: 'lockResult', ids: ['a'] })).toBeNull()
  })
})
