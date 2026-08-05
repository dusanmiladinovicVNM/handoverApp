/**
 * shell-cache.test.js
 * The service worker's cache key must change whenever the shell does.
 *
 * The shell is cached cache-first, so a stale key is not a small problem: every
 * browser that has opened the app before keeps being served the previous
 * version indefinitely, while the backend it talks to has moved on. Nothing
 * appears broken — the app is simply, quietly, one release behind, and only on
 * the machines that have used it.
 *
 * A hand-maintained version number does not survive this. It was one, and it
 * was forgotten on the very next release that touched pages.js. So the key is a
 * digest of the shell files, and this check is what notices when the recorded
 * digest and the files have drifted apart.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { section, check, assert } = require('./appsscript-stubs');

const ROOT = path.join(__dirname, '..');
const SW = path.join(ROOT, 'sw.js');

/** The paths listed in APP_SHELL, with './' resolved and duplicates dropped. */
function shellFiles(source) {
  const block = source.match(/const APP_SHELL = \[([\s\S]*?)\]/);
  if (!block) throw new Error('APP_SHELL not found in sw.js');
  const listed = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const resolved = listed.map(p => (p === './' ? './index.html' : p));
  return [...new Set(resolved)].sort();
}

/**
 * sw.js is deliberately not part of the digest: it carries the digest, so
 * including it could not converge.
 */
function shellDigest(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(ROOT, file)));
  }
  return hash.digest('hex').slice(0, 12);
}

module.exports = function run() {
  const source = fs.readFileSync(SW, 'utf8');
  const files = shellFiles(source);

  section('Service worker shell cache:');

  check('every file listed in APP_SHELL exists', () => {
    // The install handler swallows individual cache.add failures so that one
    // bad path cannot stop the worker installing. The cost of that kindness is
    // that a typo or a renamed file goes unnoticed at runtime.
    const missing = files.filter(f => !fs.existsSync(path.join(ROOT, f)));
    assert(missing.length === 0, `listed but not on disk: ${missing.join(', ')}`);
  });

  check('no shell file has been left out of APP_SHELL', () => {
    const onDisk = [
      'index.html',
      ...fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css')).map(f => `css/${f}`),
      ...fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => `js/${f}`),
      ...fs.readdirSync(path.join(ROOT, 'js/utils')).filter(f => f.endsWith('.js')).map(f => `js/utils/${f}`),
    ].map(f => `./${f}`);

    const missing = onDisk.filter(f => files.indexOf(f) < 0);
    assert(missing.length === 0,
      `shipped but never cached, so it will always come from the network: ${missing.join(', ')}`);
  });

  check('the recorded digest matches the shell on disk', () => {
    const recorded = (source.match(/const SHELL_HASH = '([^']+)'/) || [])[1];
    assert(recorded, "SHELL_HASH not found in sw.js");

    const actual = shellDigest(files);
    assert(recorded === actual,
      'the shell changed but the cache key did not, so returning browsers would\n' +
      '        keep serving the previous version. Set SHELL_HASH in sw.js to:\n' +
      `        ${actual}`);
  });
};
