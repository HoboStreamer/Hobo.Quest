import type { Scene } from '@babylonjs/core/scene.js'
import type { ClientState } from '../state/clientState.js'
import type { EntityView } from './entityView.js'
export declare class ConstraintLineRenderer {
  private readonly scene
  private readonly state
  private readonly view
  private readonly lines
  private readonly ropeMat
  private readonly springMat
  constructor(scene: Scene, state: ClientState, view: EntityView)
  update(): void
  private hide
  dispose(): void
}
//# sourceMappingURL=constraintLines.d.ts.map
