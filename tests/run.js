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
  ['File loading and routing', require('./load-order.test')],
  ['Service worker cache', require('./shell-cache.test')],
  ['Sheet reads and cache', require('./sheet-cache.test')],
  ['Schema cache', require('./schema-cache.test')],
  ['Passwords', require('./password.test')],
  ['Tokens and authorization', require('./auth.test')],
  ['Auth mirror', require('./auth-mirror.test')],
  ['Sign-in flows', require('./account.test')],
  ['Account administration', require('./user-admin.test')],
];

for (const [name, run] of suites) {
  console.log(`\n=== ${name} ===`);
  run();
}

process.exit(summary() ? 1 : 0);
