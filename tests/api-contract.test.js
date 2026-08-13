/**
 * api-contract.test.js
 * The document and the router say the same thing.
 *
 * docs/api-contract.md is the only description of this backend that anyone
 * reads before calling it, and nothing was keeping it true. Actions were added
 * to the router over four pull requests and none of them reached the document:
 * `getSectionThumbs`, `getAttachmentFile` and `getNewInspectionOptions` existed
 * and worked and were not written down anywhere.
 *
 * That is the sort of gap that only ever widens, because the cost of noticing
 * it is a manual comparison nobody has a reason to run. So it runs here.
 *
 * Two directions matter, and they fail differently. An action in the router
 * with no section in the document is undiscoverable — a client author cannot
 * call what they cannot find. An action in the document with no route is worse:
 * someone builds against it and gets `INVALID_REQUEST` from a backend whose own
 * documentation promised otherwise.
 *
 * The permissions matrix is checked separately because it is the part people
 * actually act on. A row that quietly stops covering an action is how a client
 * ends up assuming a tenant may do something a tenant may not.
 */

const fs = require('fs');
const path = require('path');
const { section, check, assert, withoutComments } = require('./appsscript-stubs');

const ROOT = path.join(__dirname, '..');

/**
 * The router's action names, read out of the ROUTES literal.
 *
 * Deliberately a source scan rather than executing Router.gs: loading it would
 * mean stubbing every service it names, and this question is about what the
 * file says, not about what any of it does.
 */
function routedActions() {
  const source = withoutComments(
    fs.readFileSync(path.join(ROOT, 'gas', 'Router.gs'), 'utf8'));
  const routes = source.slice(source.indexOf('const ROUTES'));
  const body = routes.slice(0, routes.indexOf('\n  };'));
  const found = body.match(/^\s{4}'([a-zA-Z][a-zA-Z0-9]*)':/gm) || [];
  return found.map(line => line.trim().replace(/^'/, '').replace(/':$/, ''));
}

/** The text under a `## <title>` heading, up to the next `## `. */
function chapter(doc, titleStartsWith) {
  const lines = doc.split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inside = line.slice(3).indexOf(titleStartsWith) === 0;
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

/** Backticked names in the first cell of every table row in `text`. */
function firstCellNames(text) {
  const names = new Set();
  text.split('\n')
    .filter(line => line.trim().startsWith('|'))
    .forEach(line => {
      const firstCell = line.split('|')[1] || '';
      (firstCell.match(/`([a-zA-Z][a-zA-Z0-9]*)`/g) || [])
        .forEach(m => names.add(m.replace(/`/g, '')));
    });
  return Array.from(names);
}

/**
 * Actions the contract describes.
 *
 * Two forms count, because the document uses two on purpose. Most actions get a
 * `### \`name\`` heading with request and response bodies. The eleven
 * account-administration ones are a table of action/data/returns instead —
 * eleven headings for eleven near-identical CRUD calls would bury the rest, and
 * a row that names the fields both ways is not less of a description.
 *
 * The permissions matrix is not one of these forms. It says who may call an
 * action, which is no use to someone who does not know what it does.
 */
function documentedActions(doc) {
  const headings = (doc.match(/^### `([a-zA-Z][a-zA-Z0-9]*)`\s*$/gm) || [])
    .map(line => line.replace(/^### `/, '').replace(/`\s*$/, ''));
  return headings.concat(firstCellNames(chapter(doc, 'Endpoints —')));
}

/** Every `\`name\`` appearing in the permissions matrix rows. */
function matrixActions(doc) {
  const table = chapter(doc, 'Permissions Matrix');
  assert(table.trim().length > 0, 'the contract has no Permissions Matrix section');
  return firstCellNames(table);
}

module.exports = function run() {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'api-contract.md'), 'utf8');
  const routed = routedActions();
  const documented = documentedActions(doc);
  const matrix = matrixActions(doc);

  section('The router and the contract:');

  // If this trips, the scan broke rather than the router — the app has had
  // more than thirty actions since account administration landed.
  check('the router scan actually found the routes', () => {
    assert(routed.length >= 30,
      `found only ${routed.length} routes, so the scan is not reading ROUTES`);
    assert(routed.indexOf('getInspection') >= 0, 'getInspection was not found');
  });

  check('every routed action has a section in the contract', () => {
    const missing = routed.filter(a => documented.indexOf(a) < 0);
    assert(missing.length === 0,
      `undocumented: ${missing.join(', ')}`);
  });

  check('every documented action is actually routed', () => {
    const phantom = documented.filter(a => routed.indexOf(a) < 0);
    assert(phantom.length === 0,
      `documented but unreachable: ${phantom.join(', ')}`);
  });

  section('The permissions matrix:');

  check('covers every routed action', () => {
    const missing = routed.filter(a => matrix.indexOf(a) < 0);
    assert(missing.length === 0,
      `absent from the matrix: ${missing.join(', ')}`);
  });

  check('names no action that does not exist', () => {
    const phantom = matrix.filter(a => routed.indexOf(a) < 0);
    assert(phantom.length === 0,
      `in the matrix but not routed: ${phantom.join(', ')}`);
  });

  section('Things the contract must not still claim:');

  // Removed in the photo-access work. A client author who finds this and builds
  // against it produces exactly the bug that work existed to fix: a broken
  // image for anyone without their own Drive rights.
  check('no thumbnailUrl is offered anywhere', () => {
    assert(doc.indexOf('thumbnailUrl') < 0 || /no `?thumbnailUrl/i.test(doc),
      'the contract still documents a thumbnailUrl field');
  });

  check('no drive.google.com link is offered as an image source', () => {
    const asSource = /"[a-zA-Z]*[Uu]rl":\s*"https:\/\/drive\.google\.com/.test(doc);
    assert(!asSource, 'the contract still hands out a Drive URL in a response');
  });
};
