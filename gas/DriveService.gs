/**
 * DriveService.gs
 * Drive folder and file operations.
 */

const DriveService = (function () {

  function _root() {
    return DriveApp.getFolderById(Config.getInspectionsRootFolderId());
  }

  function _getOrCreateChildFolder(parent, name) {
    const it = parent.getFoldersByName(name);
    if (it.hasNext()) return it.next();
    return parent.createFolder(name);
  }

  /**
   * Creates the per-inspection folder structure and returns its ID.
   *   /Inspections/YYYY/INS-YYYY-NNNNNN/photos
   *                                   /signatures
   *                                   /output
   *                                   /_deleted
   */
  function createInspectionFolders(inspectionId) {
    const root = _root();
    const inspectionsFolder = _getOrCreateChildFolder(root, 'Inspections');
    const year = inspectionId.split('-')[1];
    const yearFolder = _getOrCreateChildFolder(inspectionsFolder, year);
    const inspectionFolder = _getOrCreateChildFolder(yearFolder, inspectionId);
    _getOrCreateChildFolder(inspectionFolder, 'photos');
    _getOrCreateChildFolder(inspectionFolder, 'signatures');
    _getOrCreateChildFolder(inspectionFolder, 'output');
    _getOrCreateChildFolder(inspectionFolder, '_deleted');
    return inspectionFolder.getId();
  }

  function getInspectionFolder(inspectionId) {
    const root = _root();
    const inspectionsFolder = _getOrCreateChildFolder(root, 'Inspections');
    const year = inspectionId.split('-')[1];
    const yearFolder = _getOrCreateChildFolder(inspectionsFolder, year);
    return _getOrCreateChildFolder(yearFolder, inspectionId);
  }

  function getSubfolder(inspectionId, subfolderName) {
    const folder = getInspectionFolder(inspectionId);
    return _getOrCreateChildFolder(folder, subfolderName);
  }

  /**
   * Save a base64 image into the inspection's photos folder.
   * Returns { fileId, fileName }.
   */
  function savePhoto(inspectionId, sectionId, itemId, base64Data, mimeType, originalName) {
    const photosFolder = getSubfolder(inspectionId, 'photos');
    // Determine sequential index for this item
    const existing = photosFolder.getFiles();
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
    const file = photosFolder.createFile(blob);
    return { fileId: file.getId(), fileName };
  }

  function saveSignaturePng(inspectionId, signerRole, base64Png) {
    const folder = getSubfolder(inspectionId, 'signatures');
    const fileName = `${signerRole}-signature.png`;
    // Remove any prior signature for this role (we keep only latest valid)
    const existing = folder.getFilesByName(fileName);
    while (existing.hasNext()) {
      existing.next().setTrashed(true);
    }
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Png), 'image/png', fileName);
    const file = folder.createFile(blob);
    return { fileId: file.getId(), fileName };
  }

  /**
   * Move a file (by ID) to the _deleted subfolder of its inspection.
   * Used for soft-deleted attachments.
   */
  function moveToDeleted(inspectionId, fileId) {
    const file = DriveApp.getFileById(fileId);
    const deletedFolder = getSubfolder(inspectionId, '_deleted');
    const photosFolder = getSubfolder(inspectionId, 'photos');
    deletedFolder.addFile(file);
    photosFolder.removeFile(file);
  }

  function saveOutputFile(inspectionId, fileBlob, fileName) {
    const folder = getSubfolder(inspectionId, 'output');
    // Remove existing file with same name (allow re-finalize)
    const existing = folder.getFilesByName(fileName);
    while (existing.hasNext()) {
      existing.next().setTrashed(true);
    }
    const file = folder.createFile(fileBlob.setName(fileName));
    return { fileId: file.getId(), url: `https://drive.google.com/file/d/${file.getId()}/view` };
  }

  function saveJsonFile(inspectionId, jsonString, fileName) {
    const folder = getSubfolder(inspectionId, 'output');
    const existing = folder.getFilesByName(fileName);
    while (existing.hasNext()) {
      existing.next().setTrashed(true);
    }
    const blob = Utilities.newBlob(jsonString, 'application/json', fileName);
    const file = folder.createFile(blob);
    return { fileId: file.getId() };
  }

  function getFileBlob(fileId) {
    return DriveApp.getFileById(fileId).getBlob();
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
  };
})();
