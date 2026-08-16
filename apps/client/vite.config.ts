import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      // Mirror the production server's pretty-URL aliases so the OAuth
      // callback's redirect to /play works in dev too.
      name: 'page-aliases',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/play') req.url = '/play.html'
          else if (req.url === '/editor') req.url = '/editor.html'
          next()
        })
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      // Dev: game server runs separately on 8000; proxy the game socket
      // plus the HTTP routes the client calls with relative URLs (character
      // list + hobo.tools SSO login/callback).
      '/ws': { target: 'ws://localhost:8000', ws: true },
      '/api': { target: 'http://localhost:8000' },
      '/auth': { target: 'http://localhost:8000' },
      // Map + its uploaded assets are server-owned state, not client files.
      // Without these the editor boots from Vite's index.html fallback and
      // adopts Vite's ETag as its map revision — every save then 409s.
      '/map.json': { target: 'http://localhost:8000' },
      '/map-assets': { target: 'http://localhost:8000' },
    },
  },
  build: {
    rollupOptions: {
      input: {
        home: 'index.html',
        main: 'play.html',
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
