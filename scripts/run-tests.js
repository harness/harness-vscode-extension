const esbuild = require('esbuild');
const { spawnSync } = require('child_process');

const tests = [
  ['src/pipeline/executionModel.test.ts', 'dist/executionModel.test.js'],
  ['src/api/completedLogs.test.ts', 'dist/completedLogs.test.js'],
];

for (const [entry, outfile] of tests) {
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['node:test', 'node:assert', 'node:assert/strict'],
  });
}

const result = spawnSync(process.execPath, ['--test', ...tests.map(([, outfile]) => outfile)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
