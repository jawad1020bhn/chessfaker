#!/usr/bin/env node
// Cross-platform test runner: executes every self-contained suite in
// tests/*.test.js on bare Node (no test framework required) and fails
// with a non-zero exit code if any suite fails.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testsDir = path.join(root, 'tests');
const suites = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (suites.length === 0) {
  console.error('No test suites found in tests/');
  process.exit(1);
}

let failed = 0;
for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join(testsDir, suite)], {
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    failed++;
    console.error(`\n✗ ${suite} FAILED (exit ${result.status})\n`);
  }
}

const total = suites.length;
if (failed > 0) {
  console.error(`\n${failed}/${total} suite(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${total} test suites passed.`);
