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
  ['Sheet timing counters', require('./sheet-stats.test')],
  ['Cell values', require('./cell-values.test')],
  ['Batch reads', require('./batch-read.test')],
  ['Section answers', require('./section-answers.test')],
  ['Config cache', require('./config-cache.test')],
  ['Schema cache', require('./schema-cache.test')],
  ['Drive folders', require('./drive-folders.test')],
  ['Passwords', require('./password.test')],
  ['Tokens and authorization', require('./auth.test')],
  ['Auth mirror', require('./auth-mirror.test')],
  ['Sign-in flows', require('./account.test')],
  ['What a sign-in returns', require('./login-payload.test')],
  ['Who sees request timing', require('./timing-visibility.test')],
  ['Inspection visibility', require('./visibility.test')],
  ['State returned by mutations', require('./mutation-state.test')],
  ['Account administration', require('./user-admin.test')],
  ['Local drafts', require('./drafts.test')],
  ['Pending saves', require('./pending-saves.test')],
  ['API timeouts', require('./api-timeouts.test')],
  ['Inspection lifecycle', require('./lifecycle.test')],
  ['Validator parity', require('./validator-parity.test')],
  ['Reading the final PDF', require('./pdf-download.test')],
  ['Markup safety', require('./markup.test')],
];

// Awaited, because the frontend suites import ES modules and so are async.
// The backend ones return undefined and await straight through.
(async () => {
  for (const [name, run] of suites) {
    console.log(`\n=== ${name} ===`);
    await run();
  }

  process.exit(summary() ? 1 : 0);
})();
