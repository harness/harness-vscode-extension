const esbuild = require('esbuild');
const { spawnSync } = require('child_process');

const tests = [
  ['src/pipeline/executionModel.test.ts', 'dist/executionModel.test.js'],
  ['src/api/completedLogs.test.ts', 'dist/completedLogs.test.js'],
  ['src/api/approvals.test.ts', 'dist/approvals.test.js'],
  ['src/api/logStream.test.ts', 'dist/logStream.test.js'],
  ['src/logs/logFormat.test.ts', 'dist/logFormat.test.js'],
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
