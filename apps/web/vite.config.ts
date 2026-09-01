import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Workspace packages are consumed as TypeScript source, so a change in the diff
  // engine hot-reloads the app without a separate build step.
  optimizeDeps: { exclude: ['@sr/core', '@sr/schema', '@sr/storage'] },
});
