/**
 * thumbnails.test.js
 * Who can see the photographs, and how many requests it costs.
 *
 * They were `<img src="drive.google.com/thumbnail?id=…">`, fetched by the
 * browser with whatever Google account it was signed into. That asks Drive a
 * question Drive cannot answer for this app: a tenant has no Google account at
 * all, and an administrator is given rights here rather than in Drive.
 *
 * It was not a theoretical gap. The first admin added that way opened an
 * inspection on a phone and found the browser's broken-image icon where the
 * electricity meter reading should have been — a photograph that is there, on a
 * document meant to be evidence, shown as missing.
 *
 * Three things have to hold now.
 *
 * The link must be gone, from the server's replies and from the screens, or the
 * one that remains is the one someone hits.
 *
 * A section must cost one request. A request to this backend is about three
 * seconds whatever it carries, so five photographs fetched separately would be
 * worse than the bug.
 *
 * And "no preview" must not read as "no photograph". Drive returns nothing for
 * a format it cannot preview or a file uploaded moments ago, and the file is
 * fine in both cases.
 */

const fs = require('fs');
const path = require('path');
const { section, check, assert, withoutComments } = require('./appsscript-stubs');

const ROOT = path.join(__dirname, '..');

/** Every shipped source file, so a leftover link cannot hide in one of them. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|gs)$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, 'js'));
  walk(path.join(ROOT, 'gas'));
  return out;
}

module.exports = async function run() {
  const thumbs = await import('../js/utils/thumbs.js');

  section('Nothing builds a Drive thumbnail link any more:');

  check('not in js/ or gas/', () => {
    // A source scan, which is weak in general — but what is being looked for is
    // a literal string, and a literal string is exactly what a scan can find.
    //
    // Comments are removed first. The rule is that no *code* builds one, not
    // that nobody may mention one: the first version failed on the very
    // comments explaining why the URL was removed, which would have left a
    // choice between deleting the explanation and deleting the check.
    const offenders = sourceFiles()
      .filter(f => path.basename(f) !== 'thumbnails.test.js')
      .filter(f => /drive\.google\.com\/thumbnail/
        .test(withoutComments(fs.readFileSync(f, 'utf8'))))
      .map(f => path.relative(ROOT, f));

    assert(offenders.length === 0,
      `still building one: ${offenders.join(', ')}`);
  });

  check('and the check would notice if something did', () => {
    // Proof the stripper still leaves the thing it is looking for, because it
    // has been narrowed once and narrowing is how a check quietly stops
    // working. The second case is the one that nearly went wrong: a naive
    // stripper eats everything after the // in https://.
    const built = 'return `https://drive.google.com/thumbnail?id=${id}&sz=w400`;';
    assert(/drive\.google\.com\/thumbnail/.test(withoutComments(built)),
      'a URL being built no longer survives the stripper');
    assert(/thumbnail\?id=/.test(withoutComments(built)),
      'the stripper ate the URL at its own //');
    assert(!/drive\.google\.com\/thumbnail/.test(
      withoutComments('  // was a drive.google.com/thumbnail URL\nconst a = 1;')),
      'prose in a line comment is still counted');
    assert(!/drive\.google\.com\/thumbnail/.test(
      withoutComments('/**\n * a `drive.google.com/thumbnail` URL\n */\nconst a = 1;')),
      'prose in a block comment is still counted');
  });

  check('and getInspection no longer sends a thumbnailUrl', () => {
    // The reply is where it started. A URL in a payload gets rendered
    // eventually, which is how two separate screens came to render this one.
    const source = fs.readFileSync(path.join(ROOT, 'gas', 'InspectionService.gs'), 'utf8');
    const attachmentBlock = source.slice(
      source.indexOf('const attachments = attachmentRows.map'),
      source.indexOf('const signatures = signatureRows.map'));
    assert(!/thumbnailUrl\s*:/.test(attachmentBlock),
      'the attachment projection still carries a thumbnailUrl');
  });

  section('A section costs one request, however many photographs:');

  check('five photos, one call', () => {
    thumbs.clear();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve({ thumbs: [] });
    };
    thumbs.loadSection('INS-1', 'kitchen', fetcher);
    thumbs.loadSection('INS-1', 'kitchen', fetcher);
    thumbs.loadSection('INS-1', 'kitchen', fetcher);
    assert(calls === 1, `${calls} requests for one section`);
  });

  await check('and a second look asks for nothing', async () => {
    thumbs.clear();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve({
        thumbs: [{ attachmentId: 'ATT-1', mimeType: 'image/jpeg', base64Data: 'AAA' }],
      });
    };
    await thumbs.loadSection('INS-1', 'kitchen', fetcher);
    assert(!thumbs.needsLoading(['ATT-1']),
      'a fetched preview still counts as missing, so it would be fetched again');
    assert(calls === 1, `${calls} requests`);
  });

  await check('a photograph taken here is never fetched back', async () => {
    // The camera already gave us the picture. Asking the server for a copy
    // would be three seconds spent replacing an image with itself — and Drive
    // has usually not finished making a preview of a file uploaded this second.
    thumbs.clear();
    thumbs.remember('ATT-1', 'data:image/jpeg;base64,LOCAL');
    assert(!thumbs.needsLoading(['ATT-1']), 'the local picture was not counted');
    assert(thumbs.peek('ATT-1') === 'data:image/jpeg;base64,LOCAL',
      'the local picture was replaced');
  });

  await check('but one photograph missing is enough to ask', async () => {
    thumbs.clear();
    thumbs.remember('ATT-1', 'data:image/jpeg;base64,LOCAL');
    assert(thumbs.needsLoading(['ATT-1', 'ATT-2']),
      'a section with an unfetched photo asked for nothing');
  });

  section('A preview arrives as something the screen can show:');

  await check('base64 becomes a data URL with its own type', async () => {
    thumbs.clear();
    await thumbs.loadSection('INS-1', 'kitchen', () => Promise.resolve({
      thumbs: [{ attachmentId: 'ATT-1', mimeType: 'image/png', base64Data: 'QUJD' }],
    }));
    assert(thumbs.peek('ATT-1') === 'data:image/png;base64,QUJD',
      `got ${thumbs.peek('ATT-1')}`);
  });

  await check('a missing type falls back rather than producing a broken URL', async () => {
    thumbs.clear();
    await thumbs.loadSection('INS-1', 'kitchen', () => Promise.resolve({
      thumbs: [{ attachmentId: 'ATT-1', mimeType: '', base64Data: 'QUJD' }],
    }));
    assert(thumbs.peek('ATT-1') === 'data:image/jpeg;base64,QUJD',
      `got ${thumbs.peek('ATT-1')}`);
  });

  section('No preview is not a missing photograph:');

  await check('Drive returning nothing is recorded as such', async () => {
    // null, not undefined: the difference is whether the screen says "loading"
    // forever or says the photograph has no preview.
    thumbs.clear();
    await thumbs.loadSection('INS-1', 'kitchen', () => Promise.resolve({
      thumbs: [{ attachmentId: 'ATT-1', mimeType: '', base64Data: null }],
    }));
    assert(thumbs.peek('ATT-1') === null,
      `got ${JSON.stringify(thumbs.peek('ATT-1'))}`);
    assert(!thumbs.needsLoading(['ATT-1']),
      'a photo Drive cannot preview would be asked for on every visit');
  });

  await check('a failed request is not recorded as absence', async () => {
    // The distinction that decides whether reopening the section tries again.
    // Marking it null on a network failure would make one bad moment permanent.
    thumbs.clear();
    let threw = null;
    try {
      await thumbs.loadSection('INS-1', 'kitchen',
        () => Promise.reject(new Error('offline')));
    } catch (e) { threw = e; }

    assert(threw, 'the failure was swallowed');
    assert(thumbs.peek('ATT-1') === undefined, 'a failure was recorded as no preview');
    assert(thumbs.needsLoading(['ATT-1']), 'the section would never try again');
  });

  await check('and the next attempt actually goes out', async () => {
    thumbs.clear();
    let calls = 0;
    const failing = () => { calls++; return Promise.reject(new Error('offline')); };
    try { await thumbs.loadSection('INS-1', 'kitchen', failing); } catch (_) {}
    try { await thumbs.loadSection('INS-1', 'kitchen', failing); } catch (_) {}
    assert(calls === 2, `${calls} attempts — a failed one was left in flight forever`);
  });

  section('A deleted photograph takes its preview with it:');

  await check('forget removes it', async () => {
    thumbs.clear();
    thumbs.remember('ATT-1', 'data:image/jpeg;base64,LOCAL');
    thumbs.forget('ATT-1');
    assert(thumbs.peek('ATT-1') === undefined, 'the preview outlived the photograph');
  });

  section('A photograph opens when it is tapped:');

  await check('the full picture is fetched once, however many taps', async () => {
    // A double tap is one gesture. Two requests of several hundred kilobytes
    // for it would be worse than the delay they are trying to shorten.
    thumbs.clear();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve({ mimeType: 'image/jpeg', base64Data: 'RlVMTA==' });
    };
    const a = thumbs.loadFull('INS-1', 'ATT-1', fetcher);
    const b = thumbs.loadFull('INS-1', 'ATT-1', fetcher);
    await Promise.all([a, b]);
    assert(calls === 1, `${calls} requests for one photograph`);
  });

  await check('and not at all for one taken on this device', async () => {
    // The camera already gave us the picture, at the size it was uploaded.
    thumbs.clear();
    thumbs.rememberFull('ATT-1', 'data:image/jpeg;base64,LOCAL');
    let calls = 0;
    const url = await thumbs.loadFull('INS-1', 'ATT-1', () => {
      calls++;
      return Promise.resolve({ mimeType: 'image/jpeg', base64Data: 'RlVMTA==' });
    });
    assert(calls === 0, 'the server was asked for a picture already here');
    assert(url === 'data:image/jpeg;base64,LOCAL', `got ${url}`);
  });

  await check('a second look costs nothing', async () => {
    thumbs.clear();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve({ mimeType: 'image/png', base64Data: 'RlVMTA==' });
    };
    await thumbs.loadFull('INS-1', 'ATT-1', fetcher);
    const again = await thumbs.loadFull('INS-1', 'ATT-1', fetcher);
    assert(calls === 1, `${calls} requests`);
    assert(again === 'data:image/png;base64,RlVMTA==', `got ${again}`);
  });

  await check('a failed fetch can be retried', async () => {
    // The opposite would make one bad moment permanent for that photograph:
    // an in-flight entry left behind would be handed to every later tap.
    thumbs.clear();
    let calls = 0;
    const failing = () => { calls++; return Promise.reject(new Error('offline')); };
    try { await thumbs.loadFull('INS-1', 'ATT-1', failing); } catch (_) {}
    try { await thumbs.loadFull('INS-1', 'ATT-1', failing); } catch (_) {}
    assert(calls === 2, `${calls} attempts — a failure was left in flight`);
  });

  section('Full pictures do not accumulate without limit:');

  await check('only the last few are kept', async () => {
    // A preview is kilobytes and there are tens of them; a full picture is
    // hundreds and thirty held at once is enough for a phone to start
    // discarding the tab.
    thumbs.clear();
    for (let i = 1; i <= 8; i++) {
      thumbs.rememberFull(`ATT-${i}`, `data:image/jpeg;base64,IMG${i}`);
    }
    assert(thumbs.peekFull('ATT-8') === 'data:image/jpeg;base64,IMG8',
      'the newest was dropped');
    assert(thumbs.peekFull('ATT-1') === undefined,
      'the oldest was kept, so nothing is ever released');
  });

  await check('and looking at one again makes it recent', async () => {
    thumbs.clear();
    for (let i = 1; i <= 5; i++) {
      thumbs.rememberFull(`ATT-${i}`, `data:image/jpeg;base64,IMG${i}`);
    }
    // Looked at again: it should now outlive the ones stored after it.
    thumbs.rememberFull('ATT-1', 'data:image/jpeg;base64,IMG1');
    thumbs.rememberFull('ATT-6', 'data:image/jpeg;base64,IMG6');

    assert(thumbs.peekFull('ATT-1'), 'the one just looked at was evicted');
    assert(thumbs.peekFull('ATT-2') === undefined,
      'the genuinely oldest survived instead');
  });

  await check('previews are not evicted with them', async () => {
    // They are cheap and there are many; the limit is on the expensive ones.
    thumbs.clear();
    for (let i = 1; i <= 20; i++) thumbs.remember(`ATT-${i}`, `data:image/jpeg;base64,T${i}`);
    assert(thumbs.peek('ATT-1'), 'a preview was dropped under the full-size limit');
  });

  await check('deleting a photograph drops both copies', async () => {
    thumbs.clear();
    thumbs.remember('ATT-1', 'data:image/jpeg;base64,SMALL');
    thumbs.rememberFull('ATT-1', 'data:image/jpeg;base64,LARGE');
    thumbs.forget('ATT-1');
    assert(thumbs.peek('ATT-1') === undefined, 'the preview outlived the photograph');
    assert(thumbs.peekFull('ATT-1') === undefined, 'the full picture outlived it');
  });
};
