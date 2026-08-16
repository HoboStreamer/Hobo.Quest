/**
 * Editor credential resolution. An explicitly typed admin token always wins
 * (the EDITOR_KEY shared-secret path still works without SSO); otherwise the
 * hobo.tools SSO session from the game (`hq_sso`, same origin as /play) is
 * used, so admins and owners never have to paste anything — the server
 * validates the token against hobo.tools and checks admin/owner rank.
 */
export declare function ssoToken(): string;
export declare function editorToken(): string;
//# sourceMappingURL=editorToken.d.ts.map