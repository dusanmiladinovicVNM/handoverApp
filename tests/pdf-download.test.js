/**
 * pdf-download.test.js
 * Who may read a finished report, and how.
 *
 * The report used to leave the app as a link: every screen that offered it
 * rendered https://drive.google.com/file/d/<id>/view and the browser went to
 * Drive. Drive then answered a question this app had never asked it — it knows
 * the Google account in the browser, not `assignedTo`, and certainly not which
 * inspection a tenant's link token was issued for. Making the link work for a
 * tenant at all means sharing the output folder outside the organisation, and
 * at that point the file id is the whole of the protection.
 *
 * downloadPdf answers it here instead. The checks below are about that being
 * true in both directions: the right people get the bytes, the wrong ones get
 * the same NOT_FOUND every other inspection handler gives them, and no screen
 * has quietly kept a Drive link around beside it.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createEnvironment, section, check, assert, expectError } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/**
 * PdfService is not in the environment's own load list — it is the one service
 * that reaches for DocumentApp — so it is loaded on top of a ready environment
 * with its two collaborators stubbed.
 *
 * Loaded into the same context, which is what lets it see AuthService, Utils
 * and the rest: top-level `const` is shared between scripts in one realm, the
 * same reason Apps Script's own file order matters.
 */
function loadPdfService(env, drive) {
  env.sandbox.DriveService = {
    getFileBlob: (fileId) => {
      const bytes = drive[fileId];
      if (!bytes) throw new Error(`No item with the given ID could be found: ${fileId}`);
      return { getBytes: () => Array.from(bytes) };
    },
  };
  env.sandbox.Config.getMaxPdfDownloadMb = () => drive.__maxMb || 20;
  env.sandbox.DocumentApp = {};
  env.sandbox.DriveApp = {};
  env.sandbox.ValidationService = {};
  env.sandbox.SchemaService = {};

  const source = fs.readFileSync(path.join(GAS_DIR, 'PdfService.gs'), 'utf8');
  vm.runInContext(source + '\nglobalThis.__pdf = PdfService;', env.sandbox);
  return env.sandbox.__pdf;
}

module.exports = function run() {

  /**
   * One finished inspection assigned to Mina, one belonging to Petar, and one
   * of Mina's that was never finalised.
   */
  function fixture(options) {
    const env = createEnvironment();
    const drive = Object.assign({
      'PDF-MINA': Buffer.from('%PDF-1.7 mina', 'utf8'),
      'PDF-PETAR': Buffer.from('%PDF-1.7 petar', 'utf8'),
    }, options || {});

    [
      { inspectionId: 'INS-MINA', assignedTo: 'mina@firma.rs', finalPdfFileId: 'PDF-MINA' },
      { inspectionId: 'INS-PETAR', assignedTo: 'petar@firma.rs', finalPdfFileId: 'PDF-PETAR' },
      { inspectionId: 'INS-DRAFT', assignedTo: 'mina@firma.rs', finalPdfFileId: '' },
    ].forEach(i => env.db.inspections.push(Object.assign({ status: 'signed' }, i)));

    return {
      env,
      pdf: loadPdfService(env, drive),
      admin: { role: 'admin', isAdmin: true, email: 'ana@firma.rs', actorString: 'user:ana@firma.rs' },
      mina: { role: 'inspector', isAdmin: false, email: 'mina@firma.rs', actorString: 'user:mina@firma.rs' },
      petar: { role: 'inspector', isAdmin: false, email: 'petar@firma.rs', actorString: 'user:petar@firma.rs' },
      tenant: { role: 'tenant', isAdmin: false, inspectionId: 'INS-MINA', actorString: 'tenant_token:abcd1234' },
    };
  }

  const decode = (res) => Buffer.from(res.base64Data, 'base64').toString('utf8');

  section('Who gets the report:');

  check('the inspector it is assigned to', () => {
    const { pdf, mina } = fixture();
    const res = pdf.downloadPdf(mina, { inspectionId: 'INS-MINA' });
    assert(decode(res) === '%PDF-1.7 mina', `got ${JSON.stringify(decode(res))}`);
    assert(res.fileName === 'INS-MINA_final.pdf', `named it ${res.fileName}`);
    assert(res.mimeType === 'application/pdf', `sent it as ${res.mimeType}`);
    assert(res.sizeBytes === 13, `reported ${res.sizeBytes} bytes`);
  });

  check('an admin, for any of them', () => {
    const { pdf, admin } = fixture();
    assert(decode(pdf.downloadPdf(admin, { inspectionId: 'INS-PETAR' })) === '%PDF-1.7 petar');
  });

  // The whole reason the bytes come through the app: a tenant has no Google
  // account here, so a Drive link can only work for them if the folder is open
  // to everyone. Their token is bound to one inspection, and that is checkable.
  check('the tenant whose link it was issued for', () => {
    const { pdf, tenant } = fixture();
    assert(decode(pdf.downloadPdf(tenant, { inspectionId: 'INS-MINA' })) === '%PDF-1.7 mina');
  });

  section('And who does not:');

  const refused = (env, fn, note) => {
    const e = expectError(env.HandoverError, fn, note);
    assert(e.code === 'NOT_FOUND',
      `answered ${e.code}; the report must not tell an inspector that someone ` +
      "else's inspection exists");
    return e;
  };

  check("an inspector it is not assigned to", () => {
    const { env, pdf, petar } = fixture();
    refused(env, () => pdf.downloadPdf(petar, { inspectionId: 'INS-MINA' }));
  });

  check('a tenant link for a different inspection', () => {
    const { env, pdf, tenant } = fixture();
    expectError(env.HandoverError,
      () => pdf.downloadPdf(tenant, { inspectionId: 'INS-PETAR' }),
      'a tenant token reached another inspection\'s report');
  });

  check('nobody, for an inspection that was never finalised', () => {
    const { env, pdf, mina } = fixture();
    const e = refused(env, () => pdf.downloadPdf(mina, { inspectionId: 'INS-DRAFT' }));
    assert(/no final PDF/i.test(e.message), `said: ${e.message}`);
  });

  check('and the refusal comes before Drive is touched', () => {
    const { env, pdf, petar } = fixture();
    let asked = false;
    const real = env.sandbox.DriveService.getFileBlob;
    env.sandbox.DriveService.getFileBlob = (id) => { asked = true; return real(id); };
    try {
      refused(env, () => pdf.downloadPdf(petar, { inspectionId: 'INS-MINA' }));
    } finally {
      env.sandbox.DriveService.getFileBlob = real;
    }
    assert(!asked, 'read the file from Drive before deciding whether the caller may have it');
  });

  section('When the file itself is a problem:');

  check('a row naming a file Drive does not have answers NOT_FOUND', () => {
    const { env, pdf, admin } = fixture();
    env.db.inspections.find(i => i.inspectionId === 'INS-MINA').finalPdfFileId = 'PDF-GONE';
    const e = refused(env, () => pdf.downloadPdf(admin, { inspectionId: 'INS-MINA' }));
    assert(/Drive/.test(e.message), `said: ${e.message}`);
  });

  check('one too large for a response is refused with its size', () => {
    // A whole response is built in memory here, base64 and all, so the useful
    // failure is a number rather than an execution that dies mid-serialisation.
    const { env, pdf, admin } = fixture({
      'PDF-MINA': Buffer.alloc(3 * 1024 * 1024, 0x41),
      __maxMb: 2,
    });
    const e = expectError(env.HandoverError,
      () => pdf.downloadPdf(admin, { inspectionId: 'INS-MINA' }));
    assert(e.code === 'PDF_TOO_LARGE', `answered ${e.code}`);
    assert(/3 MB/.test(e.message), `did not say how big it was: ${e.message}`);
  });

  section('The audit log:');

  check('records who took a copy', () => {
    const { env, pdf, tenant } = fixture();
    pdf.downloadPdf(tenant, { inspectionId: 'INS-MINA' });
    const event = env.audit.events.find(e => e.eventType === 'pdf_downloaded');
    assert(event, 'a signed report was handed out and nothing was written down');
    assert(event.inspectionId === 'INS-MINA', `logged against ${event.inspectionId}`);
    assert(event.actor === 'tenant_token:abcd1234', `logged as ${event.actor}`);
  });

  check('and not the downloads that never happened', () => {
    const { env, pdf, petar } = fixture();
    try { pdf.downloadPdf(petar, { inspectionId: 'INS-MINA' }); } catch (e) {}
    assert(!env.audit.events.some(e => e.eventType === 'pdf_downloaded'),
      'a refused request was logged as a download');
  });

  section('No link to the file survives anywhere:');

  /**
   * The guard that matters most, because the leak was never in one place: the
   * same URL was assembled independently in two page renderers and in the
   * finalize reply, from a file id sitting in the inspection row. Anything that
   * builds it again puts the report back outside the app's control, so the
   * check is against the sources rather than against behaviour.
   *
   * sw.js is exempt for the hostname only — it caches Drive *thumbnails*, which
   * are a separate and still-open question, noted in the README.
   */
  check('nothing builds a drive.google.com/file link', () => {
    const roots = [path.join(__dirname, '..', 'js'), GAS_DIR];
    const offenders = [];

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|gs)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, 'utf8');
        source.split('\n').forEach((line, n) => {
          // Comments explain why the link is gone; only code puts it back.
          if (/^\s*(\*|\/\/)/.test(line)) return;
          if (line.includes('drive.google.com/file')) {
            offenders.push(`${entry.name}:${n + 1}`);
          }
        });
      }
    };
    roots.forEach(walk);

    assert(offenders.length === 0,
      `these build a Drive link to the report, which is readable only if the ` +
      `output folder is shared: ${offenders.join(', ')}`);
  });
};
