/**
 * DriveService.gs
 * Drive folder and file operations.
 */

const DriveService = (function () {

  /**
   * What this execution spent talking to Drive.
   *
   * Drive is the other remote service on the request path, and until this was
   * counted a handler's unexplained seconds could have been either. Creating an
   * inspection turned out to be seven round trips here against three to Sheets.
   */
  const _stats = { calls: 0, ms: 0, files: 0 };

  function getStats() {
    return { drive: _stats.calls, driveMs: _stats.ms, driveFileOps: _stats.files };
  }

  /**
   * A file operation, as opposed to a folder lookup.
   *
   * The first version of these counters wrapped only the folder walk, so a
   * request could report driveMs: 300 while spending seconds creating files or
   * iterating a folder — and the unmeasured remainder looked like platform
   * startup. Counted separately from folder work because the two are fixed by
   * different changes.
   */
  function _file(fn) {
    const startedAt = Date.now();
    try {
      return fn();
    } finally {
      _stats.files += 1;
      _stats.ms += Date.now() - startedAt;
    }
  }

  function _drive(fn) {
    const startedAt = Date.now();
    try {
      return fn();
    } finally {
      _stats.calls += 1;
      _stats.ms += Date.now() - startedAt;
    }
  }

  function _root() {
    return _drive(() => DriveApp.getFolderById(Config.getInspectionsRootFolderId()));
  }

  function _folderById(id) {
    return _drive(() => DriveApp.getFolderById(id));
  }

  function _getOrCreateChildFolder(parent, name) {
    return _drive(() => {
      const it = parent.getFoldersByName(name);
      if (it.hasNext()) return it.next();
      return parent.createFolder(name);
    });
  }

  /**
   * The two folders every inspection hangs under: /Inspections and the year
   * inside it. They are the same for every request and change never, so their
   * ids are remembered rather than rediscovered — three Drive round trips
   * (root, Inspections, year) that used to run on every upload, every
   * finalisation and every create.
   *
   * Remembered in Script Properties rather than CacheService because losing it
   * costs those three round trips again, and because there is one entry per
   * year for the life of the installation.
   */
  function _yearFolder(year) {
    const key = `driveYear:${year}`;
    const props = PropertiesService.getScriptProperties();

    const stored = props.getProperty(key);
    if (stored) {
      try {
        return _folderById(stored);
      } catch (e) {
        // Folder moved to the bin or the id is from another installation. Fall
        // through and find it again rather than failing the upload.
        Utils.log('WARN', 'Remembered year folder is gone, rediscovering', {
          year: year, error: e.message,
        });
      }
    }

    const folder = _getOrCreateChildFolder(
      _getOrCreateChildFolder(_root(), 'Inspections'), year);
    try {
      props.setProperty(key, folder.getId());
    } catch (e) {}
    return folder;
  }

  /**
   * Creates the per-inspection folder and returns its ID.
   *   /Inspections/YYYY/INS-YYYY-NNNNNN
   *
   * The photos, signatures, output and _deleted subfolders are *not* made here.
   * getSubfolder creates whichever one is asked for, so making all four up
   * front was four Drive round trips on every create for folders that an
   * inspection with no photos and no PDF never uses.
   */
  function createInspectionFolders(inspectionId) {
    const year = inspectionId.split('-')[1];
    return _getOrCreateChildFolder(_yearFolder(year), inspectionId).getId();
  }

  /**
   * The inspection's own folder.
   *
   * The id is on the inspection row, so this is one lookup. Walking down from
   * the root to rediscover it was four Drive round trips to learn something the
   * sheet already knew — and getSubfolder does it on every photo upload.
   */
  function getInspectionFolder(inspectionId) {
    const inspection = SheetService.getInspection(inspectionId);
    if (inspection && inspection.driveFolderId) {
      try {
        return _folderById(inspection.driveFolderId);
      } catch (e) {
        Utils.log('WARN', 'Stored driveFolderId is unusable, walking the tree', {
          inspectionId: inspectionId, error: e.message,
        });
      }
    }
    // No stored id, or it no longer resolves. Rows created before the column
    // existed land here.
    const year = inspectionId.split('-')[1];
    return _getOrCreateChildFolder(_yearFolder(year), inspectionId);
  }

  /**
   * Within one execution the same subfolder is often asked for twice —
   * moveToDeleted wants _deleted and photos, and each ask used to re-resolve
   * the inspection folder underneath it.
   */
  const _subfolderCache = {};

  function getSubfolder(inspectionId, subfolderName) {
    const key = `${inspectionId}/${subfolderName}`;
    if (_subfolderCache[key]) return _subfolderCache[key];

    const folder = _getOrCreateChildFolder(
      _inspectionFolderOnce(inspectionId), subfolderName);
    _subfolderCache[key] = folder;
    return folder;
  }

  const _inspectionFolders = {};

  function _inspectionFolderOnce(inspectionId) {
    if (!_inspectionFolders[inspectionId]) {
      _inspectionFolders[inspectionId] = getInspectionFolder(inspectionId);
    }
    return _inspectionFolders[inspectionId];
  }

  /**
   * Save a base64 image into the inspection's photos folder.
   * Returns { fileId, fileName }.
   */
  function savePhoto(inspectionId, sectionId, itemId, base64Data, mimeType, originalName) {
    const photosFolder = getSubfolder(inspectionId, 'photos');
    // Determine sequential index for this item
    const existing = _file(() => photosFolder.getFiles());
    let index = 1;
    const prefix = `${inspectionId}__${sectionId}__${itemId}__`;
    while (existing.hasNext()) {
      const f = existing.next();
      if (f.getName().indexOf(prefix) === 0) index++;
    }
    const ext = (mimeType === 'image/png') ? 'png' : 'jpg';
    const paddedIndex = String(index).padStart(3, '0');
    const fileName = `${prefix}${paddedIndex}.${ext}`;

    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
    const file = _file(() => photosFolder.createFile(blob));
    return { fileId: file.getId(), fileName };
  }

  function saveSignaturePng(inspectionId, signerRole, base64Png) {
    const folder = getSubfolder(inspectionId, 'signatures');
    const fileName = `${signerRole}-signature.png`;
    // Remove any prior signature for this role (we keep only latest valid)
    const existing = _file(() => folder.getFilesByName(fileName));
    while (existing.hasNext()) {
      _file(() => existing.next().setTrashed(true));
    }
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Png), 'image/png', fileName);
    const file = _file(() => folder.createFile(blob));
    return { fileId: file.getId(), fileName };
  }

  /**
   * Move a file (by ID) to the _deleted subfolder of its inspection.
   * Used for soft-deleted attachments.
   */
  function moveToDeleted(inspectionId, fileId) {
    const file = _file(() => DriveApp.getFileById(fileId));
    const deletedFolder = getSubfolder(inspectionId, '_deleted');
    const photosFolder = getSubfolder(inspectionId, 'photos');
    _file(() => deletedFolder.addFile(file));
    _file(() => photosFolder.removeFile(file));
  }

  function saveOutputFile(inspectionId, fileBlob, fileName) {
    const folder = getSubfolder(inspectionId, 'output');
    // Remove existing file with same name (allow re-finalize)
    const existing = _file(() => folder.getFilesByName(fileName));
    while (existing.hasNext()) {
      _file(() => existing.next().setTrashed(true));
    }
    const file = _file(() => folder.createFile(fileBlob.setName(fileName)));
    // The id, and not a Drive URL beside it. That URL was only readable if the
    // output folder was shared with whoever followed it, and the app now serves
    // the report itself — see PdfService.downloadPdf. Nobody read it here; a
    // link sitting in a return value is read eventually.
    return { fileId: file.getId() };
  }

  function saveJsonFile(inspectionId, jsonString, fileName) {
    const folder = getSubfolder(inspectionId, 'output');
    const existing = _file(() => folder.getFilesByName(fileName));
    while (existing.hasNext()) {
      _file(() => existing.next().setTrashed(true));
    }
    const blob = Utilities.newBlob(jsonString, 'application/json', fileName);
    const file = _file(() => folder.createFile(blob));
    return { fileId: file.getId() };
  }

  function getFileBlob(fileId) {
    return _file(() => DriveApp.getFileById(fileId).getBlob());
  }

  function getThumbnailUrl(fileId) {
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;
  }

  return {
    createInspectionFolders,
    getInspectionFolder,
    getSubfolder,
    savePhoto,
    saveSignaturePng,
    moveToDeleted,
    saveOutputFile,
    saveJsonFile,
    getFileBlob,
    getThumbnailUrl,
    getStats,
  };
})();
