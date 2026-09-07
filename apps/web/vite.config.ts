import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build stamp for the version badge.
 *
 * The commit is read from CI's GITHUB_SHA when present and from git otherwise, so a
 * deployed build identifies the exact commit serving it — which is the whole point of
 * putting it on screen. A build from a tarball with no git and no CI still succeeds; it
 * just reports "unknown" rather than failing.
 */
function commit(): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi) return fromCi.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(commit()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // Workspace packages are consumed as TypeScript source, so a change in the diff
  // engine hot-reloads the app without a separate build step.
  optimizeDeps: { exclude: ['@sr/core', '@sr/schema', '@sr/storage'] },
});
