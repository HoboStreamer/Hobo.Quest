import { type WeaponSettings } from './registry.js'
/**
 * Physgun equipment module: building-related tuning. Values are read by
 * the interaction controller when it sends grid/rotate intents — the
 * server clamps everything, so these are conveniences, not authority.
 */
export declare function physgunGridSize(settings: WeaponSettings): number
export declare function physgunSnapDeg(settings: WeaponSettings): number
export declare function registerPhysgunModule(): void
//# sourceMappingURL=physgunModule.d.ts.map
