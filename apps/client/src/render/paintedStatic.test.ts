/**
 * The paint overlay is the one piece of rendering the editor and the game
 * share, so its invariants are tested here rather than inferred from two
 * browser suites agreeing.
 *
 * What must hold, in the words of the requirement:
 *   - painting one placement of a model may not alter the cached template or
 *     any other placement;
 *   - "Do NOT mutate cached template vertex data";
 *   - a model with no usable UVs must still SHOW its paint, not silently
 *     record it and display nothing.
 *
 * A NullEngine scene, so no GPU and no glTF loader is involved: the overlay
 * only cares about geometry, materials and transforms.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
// Side-effect import: Babylon registers `createInstance` from this module.
import '@babylonjs/core/Meshes/instancedMesh.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import type { SurfaceMaterialData } from '@hobo/content'
import { createModelPaintOverlay, hasPaintedSurface } from './paintedStatic.js'

let engine: NullEngine
let scene: Scene

beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

/** A quad standing in the XY plane, with or without UVs. */
function quad(name: string, withUv: boolean): Mesh {
  const mesh = new Mesh(name, scene)
  const data = new VertexData()
  data.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]
  data.indices = [0, 1, 2, 0, 2, 3]
  data.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]
  if (withUv) data.uvs = [0, 1, 1, 1, 1, 0, 0, 0]
  data.applyToMesh(mesh)
  mesh.material = new StandardMaterial(`${name}-mat`, scene)
  return mesh
}

const painted: SurfaceMaterialData = {
  base: { color: '#808080' },
  paint: { layers: [{ id: 'l1', tex: 'wood_planks', channel: 'r' }] },
}

const FALLBACK = { extent: [2, 2, 2] as [number, number, number] }
const overlayOf = (source: Mesh, root: TransformNode, withFallback = true) =>
  createModelPaintOverlay(
    scene,
    source,
    'obj-1',
    'mesh:0/material:0',
    painted,
    () => null,
    withFallback ? { root, ...FALLBACK } : undefined,
  )

describe('createModelPaintOverlay', () => {
  it('makes an overlay with its OWN material, leaving the original alone', () => {
    // Replacing the model's material would mean "painting" turned it grey
    // everywhere the brush had not been.
    const root = new TransformNode('root', scene)
    const source = quad('child', true)
    source.parent = root
    const original = source.material

    const overlay = overlayOf(source, root)
    expect(overlay).not.toBeNull()
    expect(source.material).toBe(original)
    expect(overlay!.mesh.material).not.toBe(original)
  })

  it('sits proud of the surface it decorates, and never absorbs picks', () => {
    const root = new TransformNode('root', scene)
    const source = quad('child', true)
    source.parent = root
    const overlay = overlayOf(source, root)!
    expect(overlay.mesh.scaling.x).toBeGreaterThan(1)
    expect(overlay.mesh.isPickable).toBe(false)
  })

  it('paints one INSTANCE without touching the template or its siblings', () => {
    // ModelCache instantiates models as InstancedMesh, which shares its
    // source's material: assigning one either does nothing or repaints every
    // placement of that model.
    const template = quad('template', true)
    template.setEnabled(false)
    const rootA = new TransformNode('a', scene)
    const rootB = new TransformNode('b', scene)
    const a = template.createInstance('a-child')
    a.parent = rootA
    const b = template.createInstance('b-child')
    b.parent = rootB
    const templateMaterial = template.material

    const overlay = overlayOf(a as unknown as Mesh, rootA)
    expect(overlay).not.toBeNull()
    // A real, independent mesh — not another instance sharing the material.
    expect(overlay!.mesh.material).not.toBe(templateMaterial)
    expect(template.material).toBe(templateMaterial)
    expect(b.material).toBe(templateMaterial)
  })

  it('gives the overlay the INSTANCE pose, not the template pose', () => {
    const template = quad('template', true)
    template.position.set(99, 99, 99)
    const root = new TransformNode('a', scene)
    const inst = template.createInstance('a-child')
    inst.parent = root
    inst.position.set(1, 2, 3)

    const overlay = overlayOf(inst as unknown as Mesh, root)!
    expect([overlay.mesh.position.x, overlay.mesh.position.y, overlay.mesh.position.z]).toEqual([
      1, 2, 3,
    ])
  })

  it('bakes a box projection for a mesh with no UVs — paint is SHOWN, not just recorded', () => {
    const root = new TransformNode('root', scene)
    const source = quad('child', false)
    source.parent = root

    const overlay = overlayOf(source, root)
    expect(overlay).not.toBeNull()
    const uvs = overlay!.mesh.getVerticesData('uv')
    expect(uvs, 'the overlay got UVs').toBeTruthy()
    expect(uvs!.length).toBe(8)
    // A projection, not a constant: every stamp landing on one texel is the
    // failure this replaces.
    expect(new Set(Array.from(uvs!)).size).toBeGreaterThan(1)
  })

  it('does NOT write those UVs into the shared template geometry', () => {
    // The clone shares the cached AssetContainer's geometry; writing through
    // it would alter every other placement of the model.
    const root = new TransformNode('root', scene)
    const source = quad('child', false)
    source.parent = root
    overlayOf(source, root)
    expect(source.isVerticesDataPresent('uv')).toBe(false)
  })

  it('refuses rather than showing paint in the wrong place with no projection', () => {
    const root = new TransformNode('root', scene)
    const source = quad('child', false)
    source.parent = root
    expect(overlayOf(source, root, false)).toBeNull()
  })

  it('treats all-zero UVs as unusable and projects instead', () => {
    // What an exporter writes for a mesh that was never unwrapped.
    const root = new TransformNode('root', scene)
    const source = quad('child', true)
    source.setVerticesData('uv', new Float32Array(8))
    source.parent = root
    const uvs = overlayOf(source, root)!.mesh.getVerticesData('uv')!
    expect(new Set(Array.from(uvs)).size).toBeGreaterThan(1)
  })

  it('disposes both the clone and the material it created', () => {
    const root = new TransformNode('root', scene)
    const source = quad('child', true)
    source.parent = root
    const overlay = overlayOf(source, root)!
    const material = overlay.mesh.material!
    overlay.dispose()
    expect(overlay.mesh.isDisposed()).toBe(true)
    // A leaked material keeps its textures alive; the scene is the record.
    expect(scene.materials.includes(material)).toBe(false)
  })
})

describe('hasPaintedSurface', () => {
  const body = (over: Record<string, unknown>) =>
    ({ id: 's', shape: { type: 'box', size: [1, 1, 1] }, pos: [0, 0, 0], yaw: 0, ...over }) as never

  it('is false for an object nobody has painted', () => {
    expect(hasPaintedSurface(body({}))).toBe(false)
  })

  it('is false for a surface with no layers — a base tint is not paint', () => {
    expect(hasPaintedSurface(body({ surface: { base: { color: '#fff' } } }))).toBe(false)
  })

  it('is true for a whole-object surface with layers', () => {
    expect(hasPaintedSurface(body({ surface: painted }))).toBe(true)
  })

  it('is true for a single painted face', () => {
    expect(hasPaintedSurface(body({ surfaces: { 'face:2': painted } }))).toBe(true)
  })
})
