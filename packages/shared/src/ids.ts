/**
 * Stable string identifiers. Branded types prevent mixing id kinds at compile time.
 *
 * EntityId is the persistent identity of a world entity — it survives server
 * restarts and is what persistence and the wire protocol reference. Runtime
 * representations (Babylon meshes, Havok bodies) are transient and map to it.
 */
declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type EntityId = Brand<string, 'EntityId'>
export type PlayerId = Brand<string, 'PlayerId'>
export type ItemDefId = Brand<string, 'ItemDefId'>
export type RecipeId = Brand<string, 'RecipeId'>
export type ZoneId = Brand<string, 'ZoneId'>
export type SkillId = Brand<string, 'SkillId'>

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/**
 * Compact, time-sortable unique id (ULID-like: 48-bit ms timestamp + 80 bits
 * of randomness, Crockford base32). Requires only crypto.getRandomValues,
 * available in both Node and browsers.
 */
export function newUid(now: number = Date.now()): string {
  let ts = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32] + ts
    t = Math.floor(t / 32)
  }
  const rand = new Uint8Array(10)
  globalThis.crypto.getRandomValues(rand)
  let rs = ''
  for (let i = 0; i < 10; i++) {
    rs += ALPHABET[(rand[i] as number) % 32]
  }
  return ts + rs
}

export function newEntityId(): EntityId {
  return newUid() as EntityId
}

export function newPlayerId(): PlayerId {
  return newUid() as PlayerId
}

export function asEntityId(s: string): EntityId {
  return s as EntityId
}

export function asPlayerId(s: string): PlayerId {
  return s as PlayerId
}

export function asItemDefId(s: string): ItemDefId {
  return s as ItemDefId
}

export function asRecipeId(s: string): RecipeId {
  return s as RecipeId
}
