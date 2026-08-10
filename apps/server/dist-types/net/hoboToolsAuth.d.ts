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
export declare function resolveHoboToolsUser(
  url: string | null,
  auth: string | undefined,
): Promise<HoboToolsUser | null>
export declare function canEditMap(rank: HoboRank): boolean
//# sourceMappingURL=hoboToolsAuth.d.ts.map
