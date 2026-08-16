/**
 * Editor credential resolution. An explicitly typed admin token always wins
 * (the EDITOR_KEY shared-secret path still works without SSO); otherwise the
 * hobo.tools SSO session from the game (`hq_sso`, same origin as /play) is
 * used, so admins and owners never have to paste anything — the server
 * validates the token against hobo.tools and checks admin/owner rank.
 */

export function ssoToken(): string {
  const stored = localStorage.getItem('hq_sso')
  if (stored) return stored
  const cookie = document.cookie.split('; ').find((c) => c.startsWith('hq_sso='))
  return cookie ? decodeURIComponent(cookie.slice('hq_sso='.length)) : ''
}

export function editorToken(): string {
  const manual =
    (document.getElementById('key') as HTMLInputElement | null)?.value.trim() ?? ''
  return manual || ssoToken()
}
