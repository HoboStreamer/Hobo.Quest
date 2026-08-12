/**
 * Everything that shows what is selected, in one place.
 *
 * The old code decided highlights from mesh identity, scattered across
 * `deselect()`, `select()`, five `selected*` variables and four `multi*`
 * arrays — so an undo, a remote merge or a material change (all of which
 * rebuild meshes) silently dropped the highlight, and a terrain's wireframe
 * flickered off whenever anything rebuilt.
 *
 * Here the visuals are derived from the selection SET and the view registry
 * every time they are recomputed. A mesh being rebuilt cannot lose a
 * highlight, because the highlight was never attached to the mesh.
 *
 * The five states are visually distinct on purpose:
 *   hover           pale blue outline
 *   local secondary warm amber
 *   local primary   strong orange (what the inspector is editing)
 *   remote selected the collaborator's colour
 *   remote locked   the collaborator's colour, plus a lock badge in the UI
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { HighlightLayer } from '@babylonjs/core/Layers/highlightLayer.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { EditorViewRegistry } from '../viewport/editorViewRegistry.js'
import { TerrainView } from '../viewport/views/index.js'

export const C_PRIMARY = Color3.FromHexString('#ff9d2e')
export const C_SECONDARY = Color3.FromHexString('#ffd28f')
export const C_HOVER = Color3.FromHexString('#cfe8ff')

export interface RemoteSelection {
  color: Color3
  ids: string[]
}

export interface SelectionVisualState {
  /** Local selection, primary first. */
  ids: readonly string[]
  primary: string | null
  hover: string | null
  /** peer id → what that collaborator has selected. */
  remote: ReadonlyMap<number, RemoteSelection>
  /** object id → lock owner colour. */
  locks: ReadonlyMap<string, string>
  /** True while the terrain tool wants a hovered terrain's grid shown. */
  terrainHoverWire: string | null
  /** Terrain being sculpted/painted right now — its wire is pinned on. */
  strokeWire: string | null
}

export class SelectionVisuals {
  private readonly layer: HighlightLayer

  constructor(
    scene: Scene,
    private readonly views: EditorViewRegistry,
  ) {
    this.layer = new HighlightLayer('sel', scene, {
      blurHorizontalSize: 0.6,
      blurVerticalSize: 0.6,
    })
  }

  /**
   * Recompute every highlight from the current state. Cheap enough to call
   * on any selection or document change; deliberately NOT called per frame.
   */
  refresh(state: SelectionVisualState): void {
    this.layer.removeAllMeshes()

    // Remote first, so a local selection on the same object wins the colour.
    for (const remote of state.remote.values())
      for (const id of remote.ids) this.add(id, remote.color)
    for (const [id, hex] of state.locks) this.add(id, Color3.FromHexString(hex))

    for (const id of state.ids) this.add(id, id === state.primary ? C_PRIMARY : C_SECONDARY)
    if (state.hover && !state.ids.includes(state.hover)) this.add(state.hover, C_HOVER)

    this.refreshTerrainWires(state)
  }

  /**
   * A selected terrain keeps its grid visible until deselected — it is the
   * only cue that a flat terrain is selected at all, and it must survive
   * hover, transforms, sculpting, undo and UI interaction.
   */
  private refreshTerrainWires(state: SelectionVisualState): void {
    const selected = new Set(state.ids)
    const remote = new Set([...state.remote.values()].flatMap((r) => r.ids))
    for (const id of this.views.ids()) {
      const view = this.views.viewOf(id)
      if (!(view instanceof TerrainView)) continue
      view.setWireVisible(
        selected.has(id) ||
          remote.has(id) ||
          state.locks.has(id) ||
          state.terrainHoverWire === id ||
          state.strokeWire === id,
      )
    }
  }

  private add(id: string, color: Color3): void {
    for (const mesh of this.views.meshesOf(id)) {
      // A mesh with no geometry (a pure transform root) cannot be
      // highlighted; its children carry the look.
      if (this.canHighlight(mesh)) this.layer.addMesh(mesh, color)
      for (const child of mesh.getChildMeshes()) {
        if (this.canHighlight(child)) this.layer.addMesh(child as Mesh, color)
      }
    }
  }

  /**
   * `HighlightLayer` hooks a mesh's own bind observables, which an
   * `InstancedMesh` does not have — imported models instantiate as instances,
   * so selecting one used to throw and abandon the whole refresh, leaving the
   * previous selection's highlight on screen. The model's proxy root carries
   * the geometry that shows selection instead.
   */
  private canHighlight(mesh: AbstractMesh): boolean {
    return (
      mesh.getTotalVertices() > 0 &&
      typeof (mesh as { onBeforeBindObservable?: unknown }).onBeforeBindObservable === 'object'
    )
  }

  dispose(): void {
    this.layer.dispose()
  }
}
