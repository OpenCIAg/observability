import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Node: ESM + CJS (apps Nest compilam para CommonJS) + d.ts.
    entry: { 'core/index': 'src/core/index.ts', 'nest/index': 'src/nest/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node20',
    dts: true,
    sourcemap: true,
    clean: true,
    shims: true,
    splitting: false,
    outDir: 'dist',
  },
  {
    // Angular: só ESM (o builder do Angular empacota). Sem decorators -> sem ng-packagr.
    entry: { index: 'src/angular/index.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    dts: true,
    sourcemap: true,
    splitting: true,
    outDir: 'dist/angular',
  },
]);
