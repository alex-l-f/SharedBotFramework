import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SBF server the dev proxy talks to (SBF_BACKEND overrides, e.g. http://127.0.0.1:5601).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const backend = env.SBF_BACKEND || 'http://127.0.0.1:5600';

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    // The dev server answers /c/<token> with the chat page, as the SBF server does.
    {
      name: 'sbf-chat-link-page',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const r = req as { url?: string }; // (no Node types here)
          if (r.url && /^\/c\/[^/?#]+\/?(\?.*)?$/.test(r.url)) r.url = '/chat.html';
          next();
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/scorm': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // The management app, and the standalone chat page of chat links (its own small bundle).
      input: { main: 'index.html', chat: 'chat.html' },
      // What both load (React, Markdown, small helpers) is one plainly named chunk.
      output: { chunkFileNames: 'assets/shared-[hash].js' },
    },
  },
});
