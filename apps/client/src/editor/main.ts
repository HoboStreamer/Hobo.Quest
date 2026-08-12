/**
 * Editor entry point.
 *
 * Boot only. Everything the editor does lives in the modules `editorApp.ts`
 * composes — this file exists to load the stylesheet, start the app, and put
 * a readable message on screen if it cannot.
 */
import './editor.css'
import { bootEditor } from './editorApp.js'

void bootEditor().catch((err: unknown) => {
  console.error('[editor] failed to start', err)
  const status = document.getElementById('status')
  if (status) status.textContent = `⛔ editor failed to start: ${String(err)}`
})
