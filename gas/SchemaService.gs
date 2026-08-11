/**
 * SchemaService.gs
 * Retrieves schemas. Schemas live as JSON in the Schemas sheet.
 *
 * A schema row is the largest thing in the workbook: one whole form definition
 * per row. Opening an inspection needs exactly one of them, and the same one
 * every time, because a schema only changes when loadInitialSchemas() is run.
 * So the JSON is kept in CacheService and the row is fetched only on a miss.
 *
 * The cache is dropped whenever a schema is written. What it does not see is an
 * edit typed straight into the sheet — that takes up to the window to appear,
 * or immediately if you run clearSchemaCache().
 */

const SchemaService = (function () {

  const CACHE_TTL_SECONDS = 21600;         // six hours, the platform maximum
  const CACHE_MAX_CHARS = 90 * 1024;       // CacheService refuses values over 100 KB

  /**
   * Within one execution, remember the JSON text rather than the parsed object:
   * every caller then gets its own tree and cannot corrupt anyone else's by
   * writing to it. Parsing costs microseconds; fetching the row does not.
   */
  const _memo = {};

  function _cacheKey(schemaId) {
    return `schema:${schemaId}`;
  }

  function _readCached(schemaId) {
    if (_memo[schemaId]) return _memo[schemaId];
    try {
      const hit = CacheService.getScriptCache().get(_cacheKey(schemaId));
      if (hit) {
        _memo[schemaId] = hit;
        return hit;
      }
    } catch (e) {
      // A cache that cannot be read is only slower.
    }
    return null;
  }

  function _writeCached(schemaId, json) {
    _memo[schemaId] = json;
    if (json.length > CACHE_MAX_CHARS) return;
    try {
      CacheService.getScriptCache().put(_cacheKey(schemaId), json, CACHE_TTL_SECONDS);
    } catch (e) {
      Utils.log('WARN', 'Schema cache write failed', { schemaId: schemaId, error: e.message });
    }
  }

  /** Called on every write, and by clearSchemaCache() for a hand edit. */
  function invalidate(schemaIds) {
    const list = Array.isArray(schemaIds) ? schemaIds : [schemaIds];
    list.forEach(id => { delete _memo[id]; });
    try {
      CacheService.getScriptCache().removeAll(list.map(_cacheKey));
    } catch (e) {}
  }

  /**
   * The four fields a picker needs. The projection was always this narrow; it
   * is the read underneath that used to fetch whole definitions to build it.
   */
  function listActiveSchemas() {
    return SheetService.getActiveSchemaSummaries().map(r => ({
      schemaId: r.schemaId,
      inspectionType: r.inspectionType,
      title: r.title,
      version: r.version,
    }));
  }

  function getSchemaJson(schemaId) {
    let json = _readCached(schemaId);

    if (!json) {
      const row = SheetService.getSchema(schemaId);
      if (!row) throw new HandoverError('INVALID_SCHEMA', `Schema ${schemaId} not found.`);
      json = row.schemaJson;
      _writeCached(schemaId, json);
    }

    try {
      return JSON.parse(json);
    } catch (e) {
      // A stored value that will not parse would otherwise be handed back on
      // every request until the window closed.
      invalidate(schemaId);
      throw new HandoverError('INTERNAL_ERROR', `Schema ${schemaId} is not valid JSON: ${e.message}`);
    }
  }

  /**
   * Used by ValidationService to extract the list of items for a section
   * from a schema, with conditional logic resolution.
   */
  function getSectionItems(schemaJson, sectionId) {
    const section = (schemaJson.sections || []).find(s => s.id === sectionId);
    return section ? (section.items || []) : [];
  }

  function getAllSectionIds(schemaJson) {
    return (schemaJson.sections || []).map(s => s.id);
  }

  return {
    listActiveSchemas,
    getSchemaJson,
    getSectionItems,
    getAllSectionIds,
    invalidate,
  };
})();
