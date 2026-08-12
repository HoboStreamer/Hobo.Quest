/**
 * Creating zones.
 *
 * Zones already had a schema, runtime rule application, a view (translucent
 * volume + wireframe), an Outliner entry and Inspector fields — everything
 * except a way to make one. So there was no path from an empty map to a zone
 * at all.
 *
 * A click makes a sensible axis-aligned volume centred on where you clicked,
 * selects it, and lets the ordinary move/scale gizmo do the rest: a zone's
 * scale IS its half-extent (see `editorObject.ts`), so resizing it with the
 * gizmo resizes the volume the rules apply in, not a mesh that then lies
 * about where they are.
 */
import type { MapZoneV2 } from '@hobo/content'
export interface ZonePlacement {
  point: [number, number, number]
  /** Footprint width/depth in metres. */
  size: number
  height: number
  /** Existing zone ids, so the new one is unique and readable. */
  taken: (id: string) => boolean
}
/**
 * Zone ids are lower-case alphanumeric with `_`/`-` (see `MapZoneSchemaV2`),
 * so they cannot use the generic `newId` timestamp format directly.
 */
export declare function nextZoneId(taken: (id: string) => boolean): string
export declare function zoneForPlacement(p: ZonePlacement): MapZoneV2
//# sourceMappingURL=zoneTool.d.ts.map
