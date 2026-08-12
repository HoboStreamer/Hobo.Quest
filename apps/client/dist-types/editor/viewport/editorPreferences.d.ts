/**
 * Viewport preferences that outlive a session: gizmo coordinate space, snap
 * increments, grid, and editor-only environment preview settings.
 *
 * These are EDITOR state, not map data. Persisting them in localStorage
 * rather than the document means two people editing the same map can have
 * different snap settings without fighting over a save.
 */
export type TransformSpace = 'world' | 'local'
export interface SnapSettings {
  translate: {
    on: boolean
    step: number
  }
  rotate: {
    on: boolean
    step: number
  }
  scale: {
    on: boolean
    step: number
  }
}
export interface EditorPreferences {
  space: TransformSpace
  snap: SnapSettings
  grid: {
    on: boolean
    size: number
  }
}
export declare const DEFAULT_PREFERENCES: EditorPreferences
/** Tolerant of anything in storage: a corrupt value must not break boot. */
export declare function loadPreferences(raw: string | null): EditorPreferences
export declare function savePreferences(prefs: EditorPreferences, storage?: Storage): void
export declare function readPreferences(storage?: Storage): EditorPreferences
/**
 * Snap a value to a step. `bypass` is the held modifier — snapping you
 * cannot temporarily switch off is worse than no snapping, because the one
 * time you need an exact offset you have to go and change the setting.
 */
export declare function snapTo(value: number, step: number, on: boolean, bypass?: boolean): number
export declare const snapTranslation: (
  v: readonly [number, number, number],
  snap: SnapSettings,
  bypass: boolean,
) => [number, number, number]
/** Rotation snap is authored in degrees and applied in radians. */
export declare const snapRotationRadians: (
  radians: number,
  snap: SnapSettings,
  bypass: boolean,
) => number
export declare const snapScale: (
  v: readonly [number, number, number],
  snap: SnapSettings,
  bypass: boolean,
) => [number, number, number]
//# sourceMappingURL=editorPreferences.d.ts.map
