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
export declare function resolveHoboToolsUser(
  url: string | null,
  auth: string | undefined,
): Promise<HoboToolsUser | null>
//# sourceMappingURL=hoboToolsAuth.d.ts.map
