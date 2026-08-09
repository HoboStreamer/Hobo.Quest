import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  type Appearance,
  type ClientMessage,
  type ServerMessage,
} from '@hobo/protocol'

/**
 * WebSocket connection to the dedicated server. Message handling is a
 * callback so the network layer stays independent of game/state code.
 */
export class Connection {
  private ws: WebSocket | null = null
  onMessage: ((msg: ServerMessage) => void) | null = null
  onClose: (() => void) | null = null

  async connect(url: string, token: string, name: string, appearance: Appearance): Promise<void> {
    const ws = new WebSocket(url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('connection failed'))
    })
    ws.onmessage = (event) => {
      const msg = decodeServerMessage(String(event.data))
      if (msg) this.onMessage?.(msg)
    }
    ws.onclose = () => this.onClose?.()
    this.send({ t: 'hello', v: PROTOCOL_VERSION, token, name, appearance })
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeClientMessage(msg))
    }
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

/** Persistent anonymous identity (interim auth — see ADR-0004). */
export function getIdentity(): { token: string; name: string | null } {
  let token = localStorage.getItem('hobo.token')
  if (!token) {
    token = crypto.randomUUID().replaceAll('-', '').slice(0, 32)
    localStorage.setItem('hobo.token', token)
  }
  return { token, name: localStorage.getItem('hobo.name') }
}

export function saveName(name: string): void {
  localStorage.setItem('hobo.name', name)
}

export function gameSocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}
