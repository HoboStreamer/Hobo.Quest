/**
 * The Issues panel: everything wrong with the map, in one place.
 *
 * These checks already existed — `validateMapFile` and `validateSurface` run
 * on every save — but their output only appeared as a rejection message after
 * the fact. Surfacing them live means an author sees a missing texture or a
 * duplicate id while they can still fix it, and clicking an issue selects the
 * object it belongs to.
 */
export type IssueSeverity = 'error' | 'warning' | 'info'
export interface EditorIssue {
  severity: IssueSeverity
  message: string
  /** Object to select when the row is clicked, when there is one. */
  objectId?: string
}
export interface IssuesPanelDeps {
  /** Recompute the current issue list. */
  collect: () => EditorIssue[]
  /** Select and frame an object the user clicked through to. */
  focus: (objectId: string) => void
}
export declare function createIssuesPanel(deps: IssuesPanelDeps): {
  refresh: () => void
  count: () => number
}
//# sourceMappingURL=issuesPanel.d.ts.map
