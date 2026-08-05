/**
 * drive-folders.test.js
 * The real DriveService, over a fake Drive that counts round trips.
 *
 * Drive turned out to be the other half of every slow write path: creating an
 * inspection made seven calls here against three to the spreadsheet, and every
 * photo upload walked from the root down to rediscover a folder id the
 * inspection row already stored.
 *
 * Cutting round trips on a filing system is the kind of change that either
 * works or quietly puts files somewhere else, so this checks both halves: how
 * many calls are made, and that the folder they end at is still the right one.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/**
 * A Drive of nested folders. Every operation that would be a round trip in the
 * real one bumps the counter, so the counts below mean what they say.
 */
function fakeDrive(initialCounters) {
  let counters = initialCounters;
  let nextId = 1;
  const byId = {};

  function makeFolder(name, parentPath) {
    const id = `fld-${nextId++}`;
    const folder = {
      id: id,
      name: name,
      path: parentPath ? `${parentPath}/${name}` : name,
      children: {},
      getId: () => id,
      getName: () => name,
      getFoldersByName(childName) {
        counters.calls++;
        const hit = folder.children[childName];
        let served = false;
        return {
          hasNext: () => !!hit && !served,
          next: () => { served = true; return hit; },
        };
      },
      createFolder(childName) {
        counters.calls++;
        counters.created.push(`${folder.path}/${childName}`);
        const child = makeFolder(childName, folder.path);
        folder.children[childName] = child;
        return child;
      },
    };
    byId[id] = folder;
    return folder;
  }

  const root = makeFolder('root', '');

  return {
    root: root,
    byId: byId,
    /** Point the tally at a new execution's counters. */
    retarget: (next) => { counters = next; },
    DriveApp: {
      getFolderById(id) {
        counters.calls++;
        counters.byId.push(id);
        if (!byId[id]) throw new Error(`no such folder: ${id}`);
        return byId[id];
      },
    },
  };
}

/**
 * @param inspections  the Inspections rows this execution can see
 * @param shared       a previous run's { drive, properties } to continue from,
 *                     which is how a *second request* against the same
 *                     installation is simulated: same Drive, same remembered
 *                     ids, but the per-execution caches start empty again
 */
function loadDriveService(inspections, shared) {
  const counters = { calls: 0, created: [], byId: [] };
  const drive = shared ? shared.drive : fakeDrive(counters);
  const properties = shared ? shared.properties : {};
  if (shared) drive.retarget(counters);

  const ctx = vm.createContext({
    DriveApp: drive.DriveApp,
    Config: { getInspectionsRootFolderId: () => drive.root.getId() },
    SheetService: {
      getInspection: (id) => inspections.find(i => i.inspectionId === id) || null,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in properties ? properties[k] : null),
        setProperty: (k, v) => { properties[k] = v; },
        deleteProperty: (k) => { delete properties[k]; },
      }),
    },
    Utilities: { newBlob: () => ({}) },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  });

  const code = ['Utils.gs', 'DriveService.gs']
    .map(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n')
    + '\nglobalThis.__exports = { DriveService };';
  vm.runInContext(code, ctx);

  // The root id is handed out before any call is made; don't charge it.
  counters.calls = 0;
  return { DriveService: ctx.__exports.DriveService, counters, drive, properties };
}

module.exports = function run() {

  section('Creating an inspection folder:');

  check('makes the folder and nothing underneath it', () => {
    // photos, signatures, output and _deleted used to be made here — four round
    // trips for folders an inspection with no photos and no PDF never opens.
    const { DriveService, counters } = loadDriveService([]);
    DriveService.createInspectionFolders('INS-2026-000001');

    assert(counters.created.join(' ').indexOf('photos') < 0,
      `subfolders were created up front: ${counters.created.join(', ')}`);
    assert(counters.created.length === 3,
      `created ${counters.created.join(', ')}, expected Inspections, the year, and the inspection`);
  });

  check('returns the id of that folder', () => {
    const { DriveService, drive } = loadDriveService([]);
    const id = DriveService.createInspectionFolders('INS-2026-000001');
    assert(drive.byId[id].path === 'root/Inspections/2026/INS-2026-000001',
      `returned ${drive.byId[id] && drive.byId[id].path}`);
  });

  section('The year folder is remembered:');

  check('a second inspection in the same year does not walk from the root', () => {
    const { DriveService, counters, properties } = loadDriveService([]);
    DriveService.createInspectionFolders('INS-2026-000001');
    assert(Object.keys(properties).some(k => k.indexOf('driveYear:') === 0),
      'nothing was remembered, so every create still walks the tree');

    const after = counters.calls;
    DriveService.createInspectionFolders('INS-2026-000002');
    // Fetch the remembered year folder, look for the new one, make it. Walking
    // from the root and making four subfolders was thirteen.
    assert(counters.calls - after === 3,
      `${counters.calls - after} calls for the second create, expected 3`);
  });

  check('and a remembered folder that has gone is rediscovered, not fatal', () => {
    const { DriveService, properties, drive } = loadDriveService([]);
    DriveService.createInspectionFolders('INS-2026-000001');
    properties['driveYear:2026'] = 'fld-does-not-exist';

    const id = DriveService.createInspectionFolders('INS-2026-000002');
    assert(drive.byId[id].path === 'root/Inspections/2026/INS-2026-000002',
      'a stale remembered id sent the folder somewhere else');
  });

  section('Finding a subfolder:');

  /**
   * An installation where INS-2026-000001 already exists and its row carries
   * the folder id, then a fresh execution against it.
   */
  function secondRequest() {
    const rows = [];
    const first = loadDriveService(rows);
    const folderId = first.DriveService.createInspectionFolders('INS-2026-000001');
    rows.push({ inspectionId: 'INS-2026-000001', driveFolderId: folderId });
    return loadDriveService(rows, { drive: first.drive, properties: first.properties });
  }

  check('uses the id on the inspection row, not a walk from the root', () => {
    const { DriveService, counters } = secondRequest();

    DriveService.getSubfolder('INS-2026-000001', 'photos');
    // One getFolderById for the inspection folder, one getFoldersByName for
    // photos, one createFolder because it is not there yet. The original walked
    // root → Inspections → year → inspection before any of that: six.
    assert(counters.calls === 3, `${counters.calls} Drive calls, expected 3`);
    assert(counters.byId.length === 1, 'the stored id was not used');
  });

  check('and lands in the right place', () => {
    const { DriveService, drive } = secondRequest();

    const folder = DriveService.getSubfolder('INS-2026-000001', 'photos');
    assert(drive.byId[folder.getId()].path
      === 'root/Inspections/2026/INS-2026-000001/photos',
      `landed in ${drive.byId[folder.getId()].path}`);
  });

  check('the same subfolder asked for twice costs one resolution', () => {
    // moveToDeleted asks for _deleted and then photos, and each ask used to
    // re-resolve the inspection folder underneath it.
    const { DriveService, counters } = secondRequest();

    DriveService.getSubfolder('INS-2026-000001', 'photos');
    const after = counters.calls;
    DriveService.getSubfolder('INS-2026-000001', 'photos');
    assert(counters.calls === after, `${counters.calls - after} calls for a repeat ask`);
  });

  check('a second subfolder reuses the inspection folder', () => {
    const { DriveService, counters } = secondRequest();

    DriveService.getSubfolder('INS-2026-000001', '_deleted');
    const after = counters.calls;
    DriveService.getSubfolder('INS-2026-000001', 'photos');
    assert(counters.calls - after === 2,
      `${counters.calls - after} calls; the inspection folder was resolved again`);
  });

  section('Rows from before the column existed:');

  check('a row with no stored id still resolves by walking', () => {
    const { DriveService, drive } = loadDriveService(
      [{ inspectionId: 'INS-2026-000001', driveFolderId: '' }]);
    DriveService.createInspectionFolders('INS-2026-000001');

    const folder = DriveService.getSubfolder('INS-2026-000001', 'photos');
    assert(drive.byId[folder.getId()].path
      === 'root/Inspections/2026/INS-2026-000001/photos',
      `landed in ${drive.byId[folder.getId()].path}`);
  });

  check('an unusable stored id falls back rather than throwing', () => {
    const { DriveService, drive } = loadDriveService(
      [{ inspectionId: 'INS-2026-000001', driveFolderId: 'fld-nonsense' }]);
    DriveService.createInspectionFolders('INS-2026-000001');

    const folder = DriveService.getSubfolder('INS-2026-000001', 'photos');
    assert(drive.byId[folder.getId()].path
      === 'root/Inspections/2026/INS-2026-000001/photos',
      'a bad stored id lost the folder');
  });

  section('The counters the slow-request row reads:');

  check('report the calls that were made', () => {
    const { DriveService } = loadDriveService([]);
    DriveService.createInspectionFolders('INS-2026-000001');
    const stats = DriveService.getStats();
    assert(stats.drive > 0 && typeof stats.driveMs === 'number',
      `getStats returned ${JSON.stringify(stats)}`);
  });
};
