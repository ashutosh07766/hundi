import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  clean: true,
  // Publishing this as a single self-contained binary means npx/npm install
  // never has to resolve a second-order dependency tree — everything the
  // scanner, generators, and registration client need is inlined here.
  noExternal: [/.*/],
})
