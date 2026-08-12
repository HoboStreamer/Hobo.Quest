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

/**
 * Two sources of zones, deliberately kept apart.
 *
 * `base` is the world def's content — immutable for the process lifetime.
 * `map` is whatever the current map artifact authors, and the map editor
 * replaces it wholesale on every save. Merging the two into one array at boot
 * (as the statics path once did) meant each save appended another copy, so the
 * lists are held separately and only the union is queried.
 *
 * Map zones AUGMENT base zones. Because `rulesAt` combines most-restrictive
 * wins, a map can add a restriction but can never lift one the world declared.
 */
export class ZoneIndex {
  private readonly base: readonly ZoneDef[]
  private mapZones: readonly ZoneDef[] = []

  constructor(base: readonly ZoneDef[]) {
    this.base = base
  }

  /** Replace the map-authored layer. Idempotent: saving twice changes nothing. */
  setMapZones(zones: readonly ZoneDef[]): void {
    this.mapZones = [...zones]
  }

  /** Every zone in effect, base first. */
  all(): readonly ZoneDef[] {
    return this.mapZones.length === 0 ? this.base : [...this.base, ...this.mapZones]
  }

  /** Zones containing the position (AABB test; spatial index when zone counts grow). */
  zonesAt(pos: Vec3): ZoneDef[] {
    return this.all().filter(
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
