import type { ClientMessage } from './messages/client.js'
import { ClientMessageSchema } from './messages/client.js'
import type { ServerMessage } from './messages/server.js'

/**
 * Encoding boundary. JSON today; the API is buffer/string-agnostic so a
 * binary codec (with the same message model) can be swapped in when
 * bandwidth measurements justify it.
 */

export function encodeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg)
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg)
}

/**
 * Strictly validates inbound client data. Returns null on any malformed or
 * out-of-range payload — the server treats that as a protocol violation.
 */
export function decodeClientMessage(raw: string | Uint8Array): ClientMessage | null {
  let parsed: unknown
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const result = ClientMessageSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/** Client-side decode; server messages are trusted, so shape-check only. */
export function decodeServerMessage(raw: string | Uint8Array): ServerMessage | null {
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    const msg = JSON.parse(text) as ServerMessage
    return typeof msg === 'object' && msg !== null && typeof msg.t === 'string' ? msg : null
  } catch {
    return null
  }
}
