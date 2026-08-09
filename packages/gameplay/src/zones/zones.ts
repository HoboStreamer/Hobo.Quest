import type { ZoneDef } from '@hobo/content'
import type { Vec3 } from '@hobo/shared'

/**
 * Zone rules are declarative: systems ask "may X happen at this position?"
 * and never test for specific zones by name. Adding the safe city later is
 * a content change, not a code change.
 */
export interface ZoneRules {
  pvp: boolean
  build: boolean
  physgun: boolean
}

export const DEFAULT_RULES: ZoneRules = { pvp: true, build: true, physgun: true }

export class ZoneIndex {
  constructor(private readonly zones: readonly ZoneDef[]) {}

  /** Zones containing the position (AABB test; spatial index when zone counts grow). */
  zonesAt(pos: Vec3): ZoneDef[] {
    return this.zones.filter(
      (z) =>
        pos.x >= z.min[0] &&
        pos.x <= z.max[0] &&
        pos.y >= z.min[1] &&
        pos.y <= z.max[1] &&
        pos.z >= z.min[2] &&
        pos.z <= z.max[2],
    )
  }

  /** Effective rules at a position: restrictive zone values win over defaults. */
  rulesAt(pos: Vec3): ZoneRules {
    const rules = { ...DEFAULT_RULES }
    for (const zone of this.zonesAt(pos)) {
      rules.pvp &&= zone.rules.pvp
      rules.build &&= zone.rules.build
      rules.physgun &&= zone.rules.physgun
    }
    return rules
  }
}
