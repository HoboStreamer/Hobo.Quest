import { type WeaponSettings } from './registry.js'
/**
 * Rigging tool equipment module: which constraint the next two clicks
 * create, plus per-type tuning. Pure convenience — the server validates
 * the type, skill gate, materials and every parameter.
 */
export type RiggingKind = 'weld' | 'rope' | 'hinge' | 'axis' | 'slider' | 'spring' | 'motor'
export declare function riggingKind(settings: WeaponSettings): RiggingKind
/** Extra slack added to the measured anchor gap for ropes (fraction). */
export declare function riggingRopeSlack(settings: WeaponSettings): number
/** Hinge swing limit in degrees each way (0 = free). */
export declare function riggingHingeLimitDeg(settings: WeaponSettings): number
/** Slider travel in meters each way (0 = unbounded). */
export declare function riggingSliderTravel(settings: WeaponSettings): number
export declare function riggingSpringStiffness(settings: WeaponSettings): number
export declare function riggingMotorSpeed(settings: WeaponSettings): number
export declare function registerRiggingModule(): void
//# sourceMappingURL=riggingModule.d.ts.map
