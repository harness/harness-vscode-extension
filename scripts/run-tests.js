const esbuild = require('esbuild');
const { spawnSync } = require('child_process');

esbuild.buildSync({
  entryPoints: ['src/pipeline/executionModel.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/executionModel.test.js',
  external: ['node:test', 'node:assert', 'node:assert/strict'],
});

const result = spawnSync(process.execPath, ['--test', 'dist/executionModel.test.js'], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
