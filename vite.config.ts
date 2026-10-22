import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function gitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const BUILD = `${pkg.version}+${gitSha()}`;
const BUILT_AT = new Date().toISOString();

/**
 * Emits /sw.js (with the full list of build outputs to precache) and /version.json.
 * The service worker is regenerated on every build so its byte content changes
 * whenever any asset changes, which is what triggers an update on iOS.
 */
function pwaPlugin(): Plugin {
  return {
    name: 'stitch-pwa',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const publicFiles = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
      const precache = ['/', ...files.map((f) => '/' + f), ...publicFiles.map((f) => '/' + f)];
      const template = readFileSync(new URL('./src/sw-template.js', import.meta.url), 'utf8');
      const sw = template
        .replace('__BUILD__', JSON.stringify(BUILD))
        .replace('__PRECACHE__', JSON.stringify(Array.from(new Set(precache))));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ build: BUILD, builtAt: BUILT_AT }) + '\n',
      });
    },
  };
}

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(BUILD),
  },
  plugins: [pwaPlugin()],
  build: {
    target: 'safari16',
    sourcemap: false,
  },
  server: { host: true },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
