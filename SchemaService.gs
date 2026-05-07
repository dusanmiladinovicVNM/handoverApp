/**
 * SchemaService.gs
 * Retrieves schemas. Schemas live as JSON in the Schemas sheet.
 */

const SchemaService = (function () {

  function listActiveSchemas() {
    const rows = SheetService.getActiveSchemas();
    return rows.map(r => ({
      schemaId: r.schemaId,
      inspectionType: r.inspectionType,
      title: r.title,
      version: r.version,
    }));
  }

  function getSchemaJson(schemaId) {
    const row = SheetService.getSchema(schemaId);
    if (!row) throw new HandoverError('INVALID_SCHEMA', `Schema ${schemaId} not found.`);
    let parsed;
    try {
      parsed = JSON.parse(row.schemaJson);
    } catch (e) {
      throw new HandoverError('INTERNAL_ERROR', `Schema ${schemaId} is not valid JSON: ${e.message}`);
    }
    return parsed;
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
  };
})();
