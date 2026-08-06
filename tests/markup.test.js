/**
 * markup.test.js
 * No known HTML sink is used in the frontend.
 *
 * Three places did: the router's fallback handler, the one app.js installs
 * over it, and the boot-error screen. Each interpolated a value the app does
 * not control — the URL path twice, and a server-built error message once —
 * straight into innerHTML.
 *
 * None of them could actually be made to execute. Browsers percent-encode
 * `<` and `>` in a hash, and parseHash never decodes the path, so the payload
 * arrives as text. But that is a defence the browser happens to provide, not
 * one the code was making, and it is one commit away from not being there:
 * decode the path, or pass a route param through, and it is live. This origin
 * holds a session token, a device token good for sixty days, and cached
 * personal data.
 *
 * So the rule is the flat one — no markup from strings, anywhere — because it
 * can be checked, while "escaped correctly at each site" cannot.
 *
 * What this can honestly promise is the title: the known sinks are absent. It
 * enumerates them, so it is only ever as good as that list. A reviewer pointed
 * out that the first version claimed "nothing builds HTML out of strings"
 * while checking innerHTML alone — insertAdjacentHTML, outerHTML, DOMParser
 * and createContextualFragment would all have walked past it. They are in the
 * list now, and a sink invented after this was written still would not be.
 */

const fs = require('fs');
const path = require('path');
const { section, check, assert } = require('./appsscript-stubs');

const JS_DIR = path.join(__dirname, '..', 'js');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

module.exports = function run() {
  const files = jsFiles(JS_DIR);

  section('The known sinks are absent:');

  check('no innerHTML is assigned a value built from a variable', () => {
    // Clearing with '' is fine and common; anything with a substitution in it
    // is not.
    const bad = [];
    files.forEach(file => {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!/innerHTML\s*=/.test(line)) return;
        if (/innerHTML\s*=\s*''\s*;?\s*$/.test(line)) return;   // clearing
        if (/innerHTML\s*=\s*""\s*;?\s*$/.test(line)) return;
        bad.push(`${path.relative(JS_DIR, file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
      });
    });
    assert(bad.length === 0, 'markup built from a value:\n        ' + bad.join('\n        '));
  });

  check('the h() helper has no escape hatch back to innerHTML', () => {
    const dom = fs.readFileSync(path.join(JS_DIR, 'utils', 'dom.js'), 'utf8');
    assert(!/key === 'html'/.test(dom),
      "h({ html }) is back — one attribute name away from undoing all of this");
  });

  /**
   * The other ways a string becomes markup. Each parses HTML, so each is the
   * same hazard wearing a different name.
   */
  const SINKS = [
    ['document.write', /document\.write(ln)?\s*\(/],
    ['insertAdjacentHTML', /insertAdjacentHTML\s*\(/],
    ['outerHTML assignment', /outerHTML\s*=/],
    ['DOMParser', /new\s+DOMParser\s*\(/],
    ['createContextualFragment', /createContextualFragment\s*\(/],
    ['srcdoc assignment', /\.srcdoc\s*=/],
  ];

  SINKS.forEach(([name, pattern]) => {
    check(`no ${name}`, () => {
      const bad = files.filter(f => pattern.test(fs.readFileSync(f, 'utf8')));
      assert(bad.length === 0,
        bad.map(f => path.relative(JS_DIR, f)).join(', '));
    });
  });

  section('The pieces that replaced them still exist:');

  check('the router builds its not-found screen from nodes', () => {
    const src = fs.readFileSync(path.join(JS_DIR, 'router.js'), 'utf8');
    assert(/createElement/.test(src) && /textContent/.test(src),
      'the default not-found handler no longer builds nodes');
  });

  check('app.js builds its two screens with h()', () => {
    const src = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
    assert(/setNotFoundHandler[\s\S]{0,400}h\(/.test(src), 'not-found handler');
    assert(/boot\(\)\.catch[\s\S]{0,500}h\(/.test(src), 'boot error screen');
  });
};
