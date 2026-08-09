import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import HavokPhysics from '@babylonjs/havok'

/**
 * Loads the Havok wasm module in Node. Emscripten's default file resolution
 * expects a browser, so the wasm binary is read from the package explicitly.
 */
export async function loadHavok(): Promise<unknown> {
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('@babylonjs/havok/lib/esm/HavokPhysics.wasm')
  const wasmBinary = (await readFile(wasmPath)).buffer as ArrayBuffer
  return HavokPhysics({ wasmBinary })
}
