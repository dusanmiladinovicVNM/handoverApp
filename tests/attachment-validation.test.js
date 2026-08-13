/**
 * attachment-validation.test.js
 * What the server checks before it writes a photograph to Drive.
 *
 * Until now it checked almost nothing. `uploadAttachment` took the sectionId,
 * the itemId and the mimeType from the request and believed all three: it
 * confirmed the mime string was one of jpeg/png/webp and nothing else — not
 * that the section existed, not that the item existed, not that the item was
 * one that takes photographs, and not that the bytes were an image at all.
 *
 * The order made it worse than a missing check. The file went to Drive first
 * and the sheet row second, so an upload naming a section that is not in the
 * form still created the file, still wrote the row, and only then had nowhere
 * to count it. The photograph existed in Drive, was invisible in the app and
 * absent from the report, and left no error behind — the failure looked like a
 * count that had not moved.
 *
 * So the load-bearing assertion in nearly every case below is not "it was
 * refused". It is `drive.saved === 0`: refused *before* anything was written
 * that a refusal cannot take back.
 *
 * Size and format are the other half. The size recorded in the sheet was
 * `base64.length * 0.75`, which is an over-estimate by up to two bytes and, far
 * more to the point, was computed after the file was already stored — there was
 * no maximum anywhere, so a request could hand the execution as many megabytes
 * as it liked. And a mimeType is a string the caller chose; the bytes are what
 * arrived. Those are only the same thing when nobody is trying.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/** Apps Script hands back Java bytes, so anything over 0x7F arrives negative. */
function toSigned(buf) {
  return Array.from(buf).map(b => (b > 127 ? b - 256 : b));
}

/**
 * The form these tests upload against.
 *
 * `walls` takes photographs and the schema caps it at two — lower than the
 * config maximum of five, so the two limits can be told apart. `notes` takes
 * none at all.
 */
const SCHEMA = {
  sections: [{
    id: 'kitchen',
    items: [
      { id: 'walls', type: 'select', attachments: { enabled: true, max: 2 } },
      { id: 'notes', type: 'text' },
      { id: 'meter', type: 'number', attachments: { enabled: false } },
    ],
  }],
};

function loadService(opts) {
  opts = opts || {};
  const drive = { saved: 0 };
  const sheet = { rows: [] };

  const ctx = vm.createContext({
    console: { log: () => {}, warn: () => {}, error: () => {} },
    AuthService: { requireStaff() {}, requireInspectionAccess() {} },
    SchemaService: {
      getSchemaJson: () => SCHEMA,
      getSectionItems: (schema, sectionId) => {
        const sec = (schema.sections || []).filter(s => s.id === sectionId)[0];
        return sec ? sec.items : [];
      },
    },
    SheetService: {
      getInspection: () => ({ inspectionId: 'INS-1', schemaId: 'SCH-1', status: 'draft' }),
      countAttachmentsForItem: () => (opts.itemCount || 0),
      countAttachmentsForInspection: () => 0,
      createAttachment: (row) => { sheet.rows.push(row); },
      recomputeAttachmentCount: () => ({ count: 1, revision: 2 }),
      updateInspection: () => {},
    },
    DriveService: {
      savePhoto: () => { drive.saved++; return { fileId: 'f-1', fileName: 'n.jpg' }; },
    },
    AuditService: { log: () => {} },
    Config: {
      getMaxAttachmentsPerItem: () => 5,
      getMaxAttachmentsPerInspection: () => 80,
      getMaxAttachmentMb: () => (opts.maxMb !== undefined ? opts.maxMb : 8),
    },
    Utilities: {
      base64Decode: (str) => toSigned(Buffer.from(str, 'base64')),
    },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  });

  const code = ['Utils.gs', 'ValidationService.gs', 'AttachmentService.gs']
    .map(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n')
    + '\nglobalThis.__exports = { AttachmentService, HandoverError };';
  vm.runInContext(code, ctx);

  return { upload: ctx.__exports.AttachmentService.uploadAttachment, drive, sheet };
}

// --- Fixtures, built as bytes so the headers are the real ones ---

const JPEG_HEAD = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01];
const PNG_HEAD = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D];
const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
                   0x57, 0x45, 0x42, 0x50];
/** RIFF, but a WAVE rather than a WEBP — the trap a four-byte check falls into. */
const WAVE_HEAD = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
                   0x57, 0x41, 0x56, 0x45];

/** `head` followed by `padTo - head.length` zero bytes, base64-encoded. */
function payload(head, padTo) {
  const total = padTo === undefined ? 300 : padTo;
  const buf = Buffer.alloc(total);
  Buffer.from(head).copy(buf);
  return buf.toString('base64');
}

const AUTH = { actorString: 'inspector@example.com', isAdmin: false };

function request(over) {
  return Object.assign({
    inspectionId: 'INS-1',
    sectionId: 'kitchen',
    itemId: 'walls',
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    base64Data: payload(JPEG_HEAD),
  }, over || {});
}

module.exports = function run() {

  /** Runs an upload and reports what happened, refusal included. */
  function attempt(over, opts) {
    const svc = loadService(opts);
    let error = null;
    let result = null;
    try {
      result = svc.upload(AUTH, request(over));
    } catch (e) {
      error = e;
    }
    return { error, result, saved: svc.drive.saved, rows: svc.sheet.rows };
  }

  section('An upload naming something the form does not have:');

  [
    ['a section that is not in the schema', { sectionId: 'bathroom' }],
    ['an item that is not in that section', { itemId: 'ceiling' }],
    ['an item from a different section', { sectionId: 'kitchen', itemId: 'porch_light' }],
  ].forEach(([label, over]) => {
    check(`${label} is refused`, () => {
      const out = attempt(over);
      assert(out.error, 'the upload was accepted');
      assert(out.error.code === 'INVALID_REQUEST',
        `expected INVALID_REQUEST, got ${out.error.code}`);
    });
    check(`${label} writes nothing to Drive`, () => {
      const out = attempt(over);
      assert(out.saved === 0, `${out.saved} file(s) written to Drive`);
      assert(out.rows.length === 0, `${out.rows.length} sheet row(s) written`);
    });
  });

  check('an item that takes no photographs is refused, and writes nothing', () => {
    const out = attempt({ itemId: 'notes' });
    assert(out.error, 'the upload was accepted');
    assert(out.error.code === 'VALIDATION_FAILED',
      `expected VALIDATION_FAILED, got ${out.error.code}`);
    assert(out.saved === 0, 'a file was written to Drive');
  });

  check('attachments declared but switched off is refused', () => {
    const out = attempt({ itemId: 'meter' });
    assert(out.error, 'the upload was accepted');
    assert(out.saved === 0, 'a file was written to Drive');
  });

  section('An upload whose bytes are not what it says they are:');

  [
    ['a PNG declared as a JPEG', { mimeType: 'image/jpeg', base64Data: payload(PNG_HEAD) }],
    ['a JPEG declared as a PNG', { mimeType: 'image/png', base64Data: payload(JPEG_HEAD) }],
    ['a JPEG declared as a WEBP', { mimeType: 'image/webp', base64Data: payload(JPEG_HEAD) }],
    ['a WAVE declared as a WEBP', { mimeType: 'image/webp', base64Data: payload(WAVE_HEAD) }],
    ['a text file declared as a JPEG',
      { base64Data: Buffer.from('this is not a photograph at all!').toString('base64') }],
  ].forEach(([label, over]) => {
    check(`${label} is refused before Drive`, () => {
      const out = attempt(over);
      assert(out.error, 'the upload was accepted');
      assert(out.error.code === 'VALIDATION_FAILED',
        `expected VALIDATION_FAILED, got ${out.error.code}`);
      assert(out.saved === 0, `${out.saved} file(s) written to Drive`);
    });
  });

  // The WAVE case above is the reason this one is worth stating separately: a
  // check that stopped at 'RIFF' would accept it, and accept it as an image.
  check('a real WEBP is accepted', () => {
    const out = attempt({ mimeType: 'image/webp', base64Data: payload(WEBP_HEAD) });
    assert(!out.error, `refused: ${out.error && out.error.message}`);
    assert(out.saved === 1, 'the file was not written to Drive');
  });

  check('a real PNG is accepted', () => {
    const out = attempt({ mimeType: 'image/png', base64Data: payload(PNG_HEAD) });
    assert(!out.error, `refused: ${out.error && out.error.message}`);
  });

  check('a real JPEG is accepted', () => {
    const out = attempt({});
    assert(!out.error, `refused: ${out.error && out.error.message}`);
    assert(out.saved === 1, 'the file was not written to Drive');
    assert(out.rows.length === 1, 'no sheet row was written');
  });

  check('a mime type outside the three we store is refused', () => {
    const out = attempt({ mimeType: 'image/heic' });
    assert(out.error, 'the upload was accepted');
    assert(out.saved === 0, 'a file was written to Drive');
  });

  // The client sends raw base64 with no `data:image/jpeg;base64,` on the front.
  // One that arrives with the prefix still attached decodes to the characters
  // of the prefix, which are not a JPEG header — so it is refused rather than
  // stored as a corrupt file.
  check('a data-URL prefix left on the front is refused', () => {
    const out = attempt({ base64Data: 'data:image/jpeg;base64,' + payload(JPEG_HEAD) });
    assert(out.error, 'the upload was accepted');
    assert(out.saved === 0, 'a file was written to Drive');
  });

  section('An upload that is too large, or not base64 at all:');

  check('a photograph over the limit is refused', () => {
    // 2 MB of payload against a 1 MB ceiling.
    const out = attempt({ base64Data: payload(JPEG_HEAD, 2 * 1024 * 1024) }, { maxMb: 1 });
    assert(out.error, 'the upload was accepted');
    assert(out.error.code === 'VALIDATION_FAILED',
      `expected VALIDATION_FAILED, got ${out.error.code}`);
  });

  check('it is refused before the bytes reach Drive', () => {
    const out = attempt({ base64Data: payload(JPEG_HEAD, 2 * 1024 * 1024) }, { maxMb: 1 });
    assert(out.saved === 0, 'the oversized file was written to Drive anyway');
    assert(out.rows.length === 0, 'a sheet row was written for it');
  });

  check('one just under the limit is accepted', () => {
    const out = attempt({ base64Data: payload(JPEG_HEAD, 900 * 1024) }, { maxMb: 1 });
    assert(!out.error, `refused: ${out.error && out.error.message}`);
  });

  [
    ['an empty body', ''],
    ['a length that is not a multiple of four', payload(JPEG_HEAD).slice(0, -1)],
    ['base64 with a line break in it',
      payload(JPEG_HEAD).slice(0, 40) + '\n' + payload(JPEG_HEAD).slice(40)],
  ].forEach(([label, base64Data]) => {
    check(`${label} is refused`, () => {
      const out = attempt({ base64Data });
      assert(out.error, 'the upload was accepted');
      assert(out.saved === 0, 'a file was written to Drive');
    });
  });

  section('The size written into the sheet:');

  check('is the decoded length, not the base64 length', () => {
    const out = attempt({ base64Data: payload(JPEG_HEAD, 300) });
    assert(!out.error, `refused: ${out.error && out.error.message}`);
    assert(out.rows[0].sizeBytes === 300,
      `recorded ${out.rows[0].sizeBytes} bytes for a 300-byte photograph`);
  });

  check('is exact where the old approximation was not', () => {
    // 301 bytes encodes with two '=' of padding; length * 0.75 gives 303.
    const out = attempt({ base64Data: payload(JPEG_HEAD, 301) });
    assert(out.rows[0].sizeBytes === 301,
      `recorded ${out.rows[0].sizeBytes} bytes for a 301-byte photograph`);
  });

  section('How many photographs an item may hold:');

  // The schema caps `walls` at two and the config allows five. Only the browser
  // was applying the schema's number, which meant it applied to this app's own
  // uploader and to nothing else that could reach the endpoint.
  check("the schema's limit is enforced, not just the config's", () => {
    const out = attempt({}, { itemCount: 2 });
    assert(out.error, 'a third photograph was accepted for a max-2 item');
    assert(/Maximum 2 photos/.test(out.error.message),
      `expected the schema's limit in the message, got: ${out.error.message}`);
    assert(out.saved === 0, 'a file was written to Drive');
  });

  check('below the limit still goes through', () => {
    const out = attempt({}, { itemCount: 1 });
    assert(!out.error, `refused: ${out.error && out.error.message}`);
  });

  // Otherwise a schema that raises its own limit past the deployment's would
  // quietly win, and the config setting would stop being a ceiling.
  check('the config limit still caps a schema that asks for more', () => {
    const out = attempt({}, { itemCount: 5 });
    assert(out.error, 'a sixth photograph was accepted');
  });
};
