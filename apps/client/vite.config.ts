import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Dev: game server runs separately on 8000; proxy the game socket.
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        editor: 'editor.html',
      },
    },
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
})
