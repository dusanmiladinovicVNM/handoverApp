/**
 * i18n.test.js
 * The two dictionaries, and the one that has to agree with the backend.
 *
 * Translation rots in a particular way: nothing throws, nothing looks broken,
 * and a sentence quietly comes out in the wrong language on a screen nobody on
 * the team reads. All four checks here exist because that failure is invisible
 * at runtime and obvious from the files.
 *
 * The Swiss check is the one that would otherwise never be caught. "ß" is not a
 * bug in any mechanical sense — the string renders, the layout holds — but it
 * is the first thing a Swiss reader notices, and it arrives one careless paste
 * at a time. Switzerland dropped the letter; this app is written for
 * Switzerland; so the rule is flat and machine-checkable rather than a note in
 * a style guide.
 */

const fs = require('fs');
const path = require('path');
const { section, check, assert } = require('./appsscript-stubs');

const SEED = path.join(__dirname, '..', 'gas', 'SchemaSeed.gs');

/**
 * Every literal the seed puts in front of a person: section titles, question
 * labels, help text, option labels, and the room names passed positionally to
 * roomConditionSection / bathroomSection.
 *
 * `title: title` and friends are variables, not text, and are dropped — a
 * schema builder that takes its title as an argument would otherwise be read as
 * a string called "title".
 */
function seededStrings(source) {
  const out = new Set();

  const keyed = /(?:label|title|description|help):\s*(?:'([^']*)'|`([^`]*)`)/g;
  for (const m of source.matchAll(keyed)) {
    const value = m[1] !== undefined ? m[1] : m[2];
    // A template literal carrying ${...} is built per room and cannot be a
    // dictionary key; none of the seeded ones are user-visible text on their own.
    if (value && value.indexOf('${') < 0) out.add(value);
  }

  const positional = /(?:roomConditionSection|bathroomSection)\(\s*'[^']*'\s*,\s*'([^']*)'\s*\)/g;
  for (const m of source.matchAll(positional)) out.add(m[1]);

  return [...out];
}

module.exports = async function run() {
  const { _UI: UI, t, tn, tc, setLang, getLang, resolveLang, DEFAULT_LANG } =
    await import('../js/i18n.js');
  const { CONTENT } = await import('../js/i18n-content.js');

  section('The two dictionaries say the same things:');

  check('every English key has a German one, and the other way round', () => {
    const en = Object.keys(UI.en).sort();
    const de = Object.keys(UI.de).sort();
    const missingDe = en.filter(k => de.indexOf(k) < 0);
    const missingEn = de.filter(k => en.indexOf(k) < 0);
    assert(missingDe.length === 0, `no German for: ${missingDe.join(', ')}`);
    assert(missingEn.length === 0, `no English for: ${missingEn.join(', ')}`);
  });

  check('a placeholder in one language is in the other', () => {
    // A dropped {name} does not throw — interpolate leaves the token standing —
    // so the sentence reads as finished while naming nobody.
    const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
    const wrong = Object.keys(UI.en)
      .filter(k => placeholders(UI.en[k]) !== placeholders(UI.de[k]))
      .map(k => `${k}: en(${placeholders(UI.en[k]) || 'none'}) de(${placeholders(UI.de[k]) || 'none'})`);
    assert(wrong.length === 0, wrong.join('; '));
  });

  check('both halves of every plural are present', () => {
    const bad = [];
    for (const lang of ['en', 'de']) {
      for (const key of Object.keys(UI[lang])) {
        if (!key.endsWith('.one')) continue;
        const other = key.slice(0, -4) + '.other';
        if (UI[lang][other] === undefined) bad.push(`${lang}: ${key} has no ${other}`);
      }
    }
    assert(bad.length === 0, bad.join('; '));
  });

  section('The German is Swiss German:');

  check('no "ß" anywhere in the German the app says', () => {
    const offenders = Object.keys(UI.de)
      .filter(k => String(UI.de[k]).indexOf('ß') >= 0)
      .map(k => `${k}: ${UI.de[k]}`);
    assert(offenders.length === 0,
      'Switzerland writes "ss". Offending entries in js/i18n.js:\n        '
      + offenders.join('\n        '));
  });

  check('no "ß" in the translated inspection forms either', () => {
    const offenders = Object.keys(CONTENT.de)
      .filter(k => String(CONTENT.de[k]).indexOf('ß') >= 0)
      .map(k => `${k}: ${CONTENT.de[k]}`);
    assert(offenders.length === 0,
      'Switzerland writes "ss". Offending entries in js/i18n-content.js:\n        '
      + offenders.join('\n        '));
  });

  section('The forms the server sends are covered:');

  // This is the check that stops the German app from filling up with English.
  // The schemas live in a sheet and are seeded from SchemaSeed.gs; tc() shows
  // anything it does not recognise verbatim, which is the right behaviour at
  // runtime and completely silent. So the parity is asserted here instead.
  check('every string SchemaSeed.gs puts on screen has a German translation', () => {
    const seeded = seededStrings(fs.readFileSync(SEED, 'utf8'));
    assert(seeded.length > 100,
      `only found ${seeded.length} strings in SchemaSeed.gs — the extraction has `
      + 'stopped matching the file, so this check is passing on nothing');

    const untranslated = seeded.filter(s => CONTENT.de[s] === undefined);
    assert(untranslated.length === 0,
      `${untranslated.length} seeded string(s) would render in English:\n        `
      + untranslated.map(s => JSON.stringify(s)).join('\n        '));
  });

  check('nothing in the content map has stopped matching the seed', () => {
    // The other direction. A label renamed in the seed leaves its old
    // translation behind, where it does nothing and reads as covered.
    const seeded = new Set(seededStrings(fs.readFileSync(SEED, 'utf8')));
    const orphans = Object.keys(CONTENT.de).filter(k => !seeded.has(k));
    assert(orphans.length === 0,
      `translated but no longer in the seed:\n        `
      + orphans.map(s => JSON.stringify(s)).join('\n        '));
  });

  section('Which language the app starts in:');

  check('German when nothing says otherwise', () => {
    assert(DEFAULT_LANG === 'de', `default is ${DEFAULT_LANG}`);
    assert(resolveLang(null, []) === 'de');
  });

  check('a language this app does not speak still lands on German', () => {
    // A tenant's phone in Switzerland is as likely to be in French or Italian
    // as in either of the two languages here.
    assert(resolveLang(null, ['fr-CH', 'it-CH']) === 'de');
  });

  check('a browser asking for English gets English', () => {
    assert(resolveLang(null, ['en-GB', 'de-CH']) === 'en');
  });

  check('every flavour of German is the same dictionary', () => {
    assert(resolveLang(null, ['de-CH']) === 'de');
    assert(resolveLang(null, ['de-DE']) === 'de');
  });

  check('a stored choice beats the browser', () => {
    assert(resolveLang('en', ['de-CH']) === 'en');
    assert(resolveLang('de', ['en-GB']) === 'de');
  });

  check('a stored value that is not a language is ignored', () => {
    assert(resolveLang('klingon', ['en-GB']) === 'en');
    assert(resolveLang('klingon', []) === 'de');
  });

  section('Looking a string up:');

  check('parameters are substituted', () => {
    const out = t('login.welcome', { name: 'Ruth' });
    assert(out.indexOf('Ruth') >= 0, out);
    assert(out.indexOf('{name}') < 0, out);
  });

  check('a missing parameter leaves the placeholder visible', () => {
    // Better a token on the screen than a sentence that reads as complete and
    // names nobody.
    assert(t('login.welcome', {}).indexOf('{name}') >= 0, t('login.welcome', {}));
  });

  check('an unknown key comes back as itself rather than blank', () => {
    assert(t('nothing.here') === 'nothing.here', t('nothing.here'));
  });

  check('the plural form follows the count', () => {
    assert(tn('users.devices', 1) !== tn('users.devices', 2),
      'one and many read the same');
    assert(tn('users.devices', 3).indexOf('3') >= 0, tn('users.devices', 3));
  });

  check('a schema string the map knows is translated', () => {
    setLang('de');
    assert(getLang() === 'de');
    assert(tc('Kitchen') === 'Küche', tc('Kitchen'));
  });

  check('a schema string it does not know is passed through', () => {
    // An admin editing the Schemas sheet must never make a question vanish.
    setLang('de');
    const invented = 'Balcony railing condition';
    assert(tc(invented) === invented, tc(invented));
  });

  check('in English the schema is left exactly as the server sent it', () => {
    setLang('en');
    assert(tc('Kitchen') === 'Kitchen', tc('Kitchen'));
    setLang('de');
  });
};
