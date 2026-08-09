import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
/**
 * Flat-shaded tapered box — the single primitive the whole low-poly avatar
 * is assembled from (equal top/bottom sizes = plain box). Origin sits at
 * the anchor face so segments rotate naturally from their joint:
 * `anchor: 'top'` hangs downward (limbs), `'bottom'` grows upward (torso).
 * Optional forward offsets shear the profile for a hand-modeled feel.
 */
export interface TaperedBoxOpts {
  topWidth: number
  topDepth: number
  bottomWidth: number
  bottomDepth: number
  height: number
  anchor: 'top' | 'bottom'
  /** Shift (m) of the top/bottom face along +Z — gives shear/posture. */
  topShiftZ?: number
  bottomShiftZ?: number
}
export declare function createTaperedBox(name: string, opts: TaperedBoxOpts, scene: Scene): Mesh
//# sourceMappingURL=taperedBox.d.ts.map
