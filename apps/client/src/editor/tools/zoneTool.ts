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
export function nextZoneId(taken: (id: string) => boolean): string {
  for (let n = 1; n < 10_000; n++) {
    const id = `zone-${n}`
    if (!taken(id)) return id
  }
  return `zone-${Date.now().toString(36)}`
}

export function zoneForPlacement(p: ZonePlacement): MapZoneV2 {
  const id = nextZoneId(p.taken)
  const half = Math.max(0.5, p.size / 2)
  const height = Math.max(0.5, p.height)
  return {
    id,
    name: `Zone ${id.replace('zone-', '')}`,
    // Sitting ON the clicked surface rather than centred through it: a zone
    // half buried in the ground is almost never what was meant.
    min: [p.point[0] - half, p.point[1], p.point[2] - half],
    max: [p.point[0] + half, p.point[1] + height, p.point[2] + half],
    // Permissive by default. A zone that silently forbids PvP the moment it
    // is created would be a surprising thing for a placement click to do.
    rules: { pvp: true, build: true, physgun: true },
  }
}
