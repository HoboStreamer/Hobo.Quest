import { describe, expect, it } from 'vitest'
import { decodeClientMessage, encodeClientMessage } from './codec.js'
import type { ClientMessage } from './messages/client.js'

describe('protocol codec', () => {
  it('roundtrips every client message kind', () => {
    const messages: ClientMessage[] = [
      { t: 'hello', v: 1, token: 'abcdefgh12345678', name: 'Tester' },
      { t: 'input', seq: 42, moveX: 1, moveZ: -0.5, yaw: 1.2, pitch: -0.3, buttons: 5 },
      { t: 'use', target: 'abc123' },
      { t: 'craft', recipe: 'craft_wooden_crate' },
      { t: 'place', slot: 3, pos: [1, 2, 3], yaw: 0.5 },
      { t: 'inv_move', from: 0, to: 5, count: 3 },
      { t: 'hotbar', slot: 2 },
      { t: 'physgun', a: 'grab' },
      { t: 'physgun', a: 'rotate', dyaw: 0.1, dpitch: -0.1, snap: true },
    ]
    for (const msg of messages) {
      expect(decodeClientMessage(encodeClientMessage(msg))).toEqual(msg)
    }
  })

  it('rejects malformed payloads', () => {
    expect(decodeClientMessage('not json')).toBeNull()
    expect(decodeClientMessage('{"t":"nope"}')).toBeNull()
    expect(decodeClientMessage('{"t":"input","seq":-1}')).toBeNull()
    // NaN/Infinity smuggling
    expect(
      decodeClientMessage(
        '{"t":"input","seq":1,"moveX":1e999,"moveZ":0,"yaw":0,"pitch":0,"buttons":0}',
      ),
    ).toBeNull()
    // out-of-range movement axes (speedhack attempt)
    expect(
      decodeClientMessage(
        '{"t":"input","seq":1,"moveX":5,"moveZ":0,"yaw":0,"pitch":0,"buttons":0}',
      ),
    ).toBeNull()
  })

  it('rejects oversized strings', () => {
    expect(decodeClientMessage(JSON.stringify({ t: 'use', target: 'x'.repeat(100) }))).toBeNull()
  })
})
