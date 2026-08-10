/**
 * hobo.tools SSO adapter. A session token is exchanged against the
 * configured HOBO_TOOLS_AUTH_URL for a stable user identity; the game then
 * keys the account on that identity instead of the browser's guest token,
 * unlocking multiple character slots that survive device and IP changes.
 */
export interface HoboToolsUser {
  id: string
  admin: boolean
}

export async function resolveHoboToolsUser(
  url: string | null,
  auth: string | undefined,
): Promise<HoboToolsUser | null> {
  if (!url || !auth) return null
  try {
    const resp = await fetch(url, { headers: { authorization: `Bearer ${auth}` } })
    if (!resp.ok) return null
    const body = (await resp.json()) as {
      id?: string | number
      userId?: string | number
      username?: string
      user?: { id?: string | number; username?: string }
      rank?: string
      role?: string
      admin?: boolean
    }
    const id = body.id ?? body.userId ?? body.user?.id ?? body.username ?? body.user?.username
    if (id === undefined || id === null || String(id).length === 0) return null
    return {
      id: String(id),
      admin: body.admin === true || body.rank === 'admin' || body.role === 'admin',
    }
  } catch {
    return null
  }
}
