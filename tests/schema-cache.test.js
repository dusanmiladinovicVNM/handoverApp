/**
 * schema-cache.test.js
 * The remembered form definition behind SchemaService.getSchemaJson.
 *
 * A schema row is the largest thing in the workbook and the least likely to
 * change: one whole form definition, rewritten only when loadInitialSchemas()
 * runs. Opening an inspection needs one of them every time, so it is kept out
 * of the request path.
 *
 * Two properties matter. A second read must not reach the store, or the cache
 * is doing nothing. And each caller must get its own tree, or one handler
 * writing to a schema would quietly rewrite it for every request after it —
 * the failure mode that makes sharing a parsed object worse than not caching
 * at all.
 */

const { createEnvironment, section, check, assert, expectError } = require('./appsscript-stubs');

const SCHEMA = {
  schemaId: 'SCH-1',
  active: true,
  schemaJson: JSON.stringify({
    sections: [{ id: 'general', items: [{ id: 'a' }, { id: 'b' }] }],
  }),
};

module.exports = function run() {

  function withSchema(row) {
    const env = createEnvironment({}, { cache: true });
    env.db.schemas.push(row || Object.assign({}, SCHEMA));
    env.db.schemaReads = 0;
    return env;
  }

  section('The row is fetched once:');

  check('a second read does not reach the store', () => {
    const env = withSchema();
    env.SchemaService.getSchemaJson('SCH-1');
    env.SchemaService.getSchemaJson('SCH-1');
    assert(env.db.schemaReads === 1, `store was read ${env.db.schemaReads} times, expected 1`);
  });

  check('and the second read returns the same content', () => {
    const env = withSchema();
    const first = env.SchemaService.getSchemaJson('SCH-1');
    const second = env.SchemaService.getSchemaJson('SCH-1');
    assert(JSON.stringify(first) === JSON.stringify(second), 'the two reads disagreed');
  });

  check('a missing schema is still a rejection, not a remembered null', () => {
    const env = withSchema();
    expectError(env.HandoverError,
      () => env.SchemaService.getSchemaJson('SCH-NOPE'),
      'an unknown schema came back as a value');
  });

  section('Callers cannot corrupt each other:');

  check('each call gets its own tree', () => {
    const env = withSchema();
    const first = env.SchemaService.getSchemaJson('SCH-1');
    first.sections[0].items.length = 0;

    const second = env.SchemaService.getSchemaJson('SCH-1');
    assert(second.sections[0].items.length === 2,
      'a caller mutating its schema changed what everyone else would be given');
  });

  section('A write is seen:');

  check('invalidate sends the next read back to the store', () => {
    const env = withSchema();
    env.SchemaService.getSchemaJson('SCH-1');
    env.SchemaService.invalidate('SCH-1');
    env.SchemaService.getSchemaJson('SCH-1');
    assert(env.db.schemaReads === 2, 'the copy outlived the invalidation');
  });

  check('and it picks up the new definition, not the old one', () => {
    const env = withSchema();
    env.SchemaService.getSchemaJson('SCH-1');

    env.db.schemas[0].schemaJson = JSON.stringify({ sections: [{ id: 'replaced', items: [] }] });
    env.SchemaService.invalidate(['SCH-1']);

    assert(env.SchemaService.getSchemaJson('SCH-1').sections[0].id === 'replaced',
      'the superseded definition was served');
  });

  section('Unparseable JSON:');

  check('is refused, and is not left to be refused again', () => {
    const env = withSchema({ schemaId: 'SCH-BAD', active: true, schemaJson: '{not json' });
    expectError(env.HandoverError, () => env.SchemaService.getSchemaJson('SCH-BAD'));

    // Repaired in the sheet. Without the invalidate on the parse failure this
    // would keep failing until the window closed.
    env.db.schemas[0].schemaJson = JSON.stringify({ sections: [] });
    const parsed = env.SchemaService.getSchemaJson('SCH-BAD');
    assert(parsed && Array.isArray(parsed.sections), 'the broken value was still being served');
  });
};
