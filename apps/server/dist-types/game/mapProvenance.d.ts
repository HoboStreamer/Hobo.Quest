/**
 * Which live entity a map-authored object owns.
 *
 * The old rule was spatial: "a resource node of this type within one metre"
 * (props: two metres). Proximity is not identity, and it was wrong in every
 * direction at once —
 *
 *  - two authored objects standing close together collapsed into one, so the
 *    second was silently dropped on every save;
 *  - a player's crate dropped beside an authored one suppressed the authored
 *    one, and could itself be despawned when that map object was deleted;
 *  - moving a seed further than the radius spawned a duplicate and left the
 *    original behind, losing whatever had been mined out of it.
 *
 * Every entity a map object authors carries that object's stable id, so the
 * question "is this mine?" is answered by provenance and nothing else.
 * Entities with no provenance are player-created and are never touched here:
 * player constructions are never deleted because a map seed disappeared.
 *
 * The planner is pure so both callers share one rule and it can be tested
 * without standing up physics.
 */
/** How far an authored object must move before its entity is moved with it. */
export declare const MAP_SEED_MOVE_EPSILON = 0.001
/**
 * Provenance is persisted inside the entity's existing `state` blob, so it
 * needs no schema migration. It has to survive a restart: without it the first
 * save after one would find no entity for any authored seed and duplicate the
 * whole map.
 */
export declare const provenanceState: (mapSourceId: string | undefined) => {
  mapSourceId?: string
}
/** Read provenance back off a persisted row, ignoring anything malformed. */
export declare function readProvenance(state: unknown): string | undefined
/** The identity-bearing part of an authored map object. */
export interface AuthoredSpec {
  /** Stable document id of the map object. */
  id: string
  /** Node type or item id — changing it makes this a different thing. */
  defId: string
  pos: readonly [number, number, number]
}
/** The identity-bearing part of a live entity. */
export interface LiveProvenance {
  /** The map object that authored this entity; undefined = player-created. */
  mapSourceId?: string | undefined
  defId: string
  x: number
  z: number
}
export interface ProvenancePlan<E, S> {
  /** Entities whose map object is gone, or became a different thing. */
  despawn: E[]
  /** Entities to reposition, KEEPING their gameplay state. */
  move: {
    entity: E
    spec: S
  }[]
  /** Entities that are already correct — left completely alone. */
  keep: E[]
  /** Map objects with no entity yet. */
  spawn: S[]
}
export declare function planMapProvenance<E, S>(
  authored: readonly S[],
  live: readonly E[],
  read: {
    spec: (s: S) => AuthoredSpec
    entity: (e: E) => LiveProvenance
  },
): ProvenancePlan<E, S>
//# sourceMappingURL=mapProvenance.d.ts.map
