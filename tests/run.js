#!/usr/bin/env node
/**
 * Runs the backend test suites. No dependencies, no test framework:
 *
 *   node tests/run.js
 *
 * Exits non-zero if anything failed, so it can be wired into a hook or CI.
 */

const { summary } = require('./appsscript-stubs');

const suites = [
  ['Passwords', require('./password.test')],
  ['Tokens and authorization', require('./auth.test')],
  ['Sign-in flows', require('./account.test')],
];

for (const [name, run] of suites) {
  console.log(`\n=== ${name} ===`);
  run();
}

process.exit(summary() ? 1 : 0);
