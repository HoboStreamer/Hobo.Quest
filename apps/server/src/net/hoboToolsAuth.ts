/**
 * hobo.tools SSO adapter. Access tokens are JWTs issued by the hobo.tools
 * OAuth server; we validate by calling its /api/auth/me endpoint (which
 * verifies signature + ban state) rather than trusting the JWT locally.
 * The response nests the account under `user`; rank maps the network RBAC:
 * the configured owner account, then role admin / moderator (global_mod).
 */
export type HoboRank = 'owner' | 'admin' | 'moderator' | null

export interface HoboToolsUser {
  id: string
  name: string
  rank: HoboRank
}

const OWNER_USERNAME = (process.env.OWNER_USERNAME ?? 'goosely').toLowerCase()

export async function resolveHoboToolsUser(
  url: string | null,
  auth: string | undefined,
): Promise<HoboToolsUser | null> {
  if (!url || !auth) return null
  try {
    const resp = await fetch(url, { headers: { authorization: `Bearer ${auth}` } })
    if (!resp.ok) return null
    const body = (await resp.json()) as {
      user?: { id?: string | number; username?: string; role?: string; is_banned?: number }
      id?: string | number
      username?: string
      role?: string
    }
    const u = body.user ?? body
    const id = u.id ?? u.username
    if (id === undefined || id === null || String(id).length === 0) return null
    const username = String(u.username ?? id)
    let rank: HoboRank = null
    if (username.toLowerCase() === OWNER_USERNAME) rank = 'owner'
    else if (u.role === 'admin') rank = 'admin'
    else if (u.role === 'moderator' || u.role === 'global_mod') rank = 'moderator'
    return { id: String(id), name: username, rank }
  } catch {
    return null
  }
}

export function canEditMap(rank: HoboRank): boolean {
  return rank === 'owner' || rank === 'admin'
}
