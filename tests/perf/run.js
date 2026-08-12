#!/usr/bin/env node
/**
 * Walks the app the way a person does and times each step.
 *
 * See README.md in this directory for the two modes and how to read the
 * output. In short: stubbed measures request counts and browser work and is
 * deterministic; --live measures real wall-clock and reads the server's own
 * timing block out of the response.
 */

/* eslint-env node */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { install } = require('./backend-stub');

const ROOT = path.join(__dirname, '..', '..');
const LIVE = process.argv.includes('--live');
const LATENCY = Number(process.env.PERF_LATENCY || 0);
const PORT = Number(process.env.PERF_PORT || 8791);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      // Never serve outside the repo, even from a harness.
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function chromium() {
  const pw = require('playwright');
  // A pinned browser may not sit where this Playwright build expects it.
  const candidates = [
    process.env.PERF_CHROMIUM,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ].filter(Boolean).filter(p => fs.existsSync(p));
  return pw.chromium.launch(candidates.length ? { executablePath: candidates[0] } : {});
}

/**
 * Who to sign in as, for a live run.
 *
 * From tests/perf/credentials.json if it exists, otherwise the environment.
 * The file exists because the environment route kept going wrong in a way that
 * had nothing to do with this app: `read -s PERF_PASSWORD` followed by the
 * command on the next line means that, when the two are pasted together, read
 * swallows the command and uses it as the password. A file is edited once and
 * then forgotten, and it is in .gitignore.
 *
 *   { "email": "you@firma.rs", "password": "…" }
 */
function credentials() {
  const file = path.join(__dirname, 'credentials.json');
  if (fs.existsSync(file)) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (c.email && c.password) return c;
      console.error('credentials.json is missing "email" or "password".');
    } catch (e) {
      console.error('credentials.json is not valid JSON:', e.message);
    }
  }
  return {
    email: process.env.PERF_EMAIL || 'perf@firma.rs',
    password: process.env.PERF_PASSWORD || 'correct horse battery staple',
  };
}

/** One measured step. */
async function step(ctx, name, fn) {
  const before = ctx.calls.length;
  const startedAt = Date.now();
  await fn();
  const ms = Date.now() - startedAt;
  const actions = ctx.calls.slice(before);
  ctx.results.push({ name, ms, requests: actions.length, actions });
}

async function main() {
  const server = await serve();
  const browser = await chromium();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  // One array either way, so step() counts the same thing in both modes.
  const calls = [];
  const serverTimings = [];
  const pendingBodies = [];

  if (LIVE) {
    // Watch the wire without answering for it, and pick up the timing block
    // the server returns to an admin.
    page.on('request', (r) => {
      if (!r.url().includes('/macros/s/')) return;
      try { calls.push(JSON.parse(r.postData() || '{}').action || '(none)'); } catch (_) {}
    });
    // The request goes to /macros/s/…/exec, which answers 302 and sends the
    // body from script.googleusercontent.com. Filtering responses on the
    // request URL therefore matched only the redirect, which has no body —
    // which is why the first live run reported no server timings at all.
    // Reading a body is asynchronous, and the walk navigates away from pages
    // while their last response is still being read — which throws, is
    // swallowed, and silently drops that action from the report. saveSection
    // went missing exactly this way: present in one run, absent in the next,
    // depending on whether the following step's goto won the race. A table that
    // quietly omits a row is worse than one that is slow to print.
    //
    // So every read is kept, and awaited before the browser is closed.
    page.on('response', (r) => {
      const url = r.url();
      if (!url.includes('/macros/s/') && !url.includes('googleusercontent.com')) return;
      pendingBodies.push(
        r.json()
          .then((body) => {
            if (body && body.data && body.data.timing) serverTimings.push(body.data.timing);
          })
          .catch(() => {})
      );
    });
  } else {
    await install(page, LATENCY, calls);
  }
  const ctx = { calls, results: [] };
  const base = `http://127.0.0.1:${PORT}/index.html`;

  const { email, password } = credentials();

  await step(ctx, 'cold load → sign-in screen', async () => {
    // domcontentloaded, not load: waiting for every subresource includes the
    // webfont, which on a machine that cannot reach Google stalls for its full
    // timeout and reports as boot time. What matters is when the form can be
    // typed into.
    await page.goto(base + '#/login', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type=password]');
  });

  await step(ctx, 'sign in → list visible', async () => {
    await page.fill('input[type=email]', email);
    await page.fill('input[type=password]', password);
    await page.click('button[type=submit]');
    // The sign-in screen shows its refusal in a banner, so wait for either
    // outcome rather than only the good one. Waiting for the list alone turned
    // a wrong password into a silent sixty-second timeout that said nothing
    // about why — which is a bad way to spend a minute.
    await page.waitForSelector('.list-item, .empty-state__title, .banner--danger',
      { timeout: 60000 });
    const refusal = page.locator('.banner--danger');
    if (await refusal.count()) {
      // "Refused" only when the server actually judged the credentials. The
      // same banner also carries transport failures — a 404 from a deployment
      // that has moved, a timeout, an HTML error page — and calling those a
      // refusal is what sent someone to reset a password over a broken URL.
      const text = (await refusal.first().innerText()).trim();
      throw new Error(`sign-in did not complete: ${text}`);
    }
  });

  await step(ctx, 'open an inspection', async () => {
    await page.click('.list-item');
    await page.waitForSelector('text=Open editor', { timeout: 60000 });
  });

  await step(ctx, 'open the editor', async () => {
    // Already loaded by the detail screen, so this should ask for nothing.
    await page.click('text=Open editor');
    await page.waitForSelector('.section-list__item', { timeout: 60000 });
  });

  await step(ctx, 'open a section', async () => {
    await page.click('.section-list__item');
    await page.waitForSelector('.cards-wrapper .question__input-slot', { timeout: 60000 });
  });

  await step(ctx, 'back to the section list', async () => {
    await page.click('.bottom-bar button');
    await page.waitForSelector('.section-list__item', { timeout: 60000 });
  });

  // Opened outside the measured step, so what is timed is the save and not
  // the navigation before it.
  await page.click('.section-list__item');
  await page.waitForSelector('.cards-wrapper .question__input-slot', { timeout: 60000 });

  await step(ctx, 'autosave a typed answer', async () => {
    const box = page.locator('textarea, input[type=text]').first();
    if (!(await box.count())) return;
    // Waits for the save to land rather than sleeping past the debounce. A
    // fixed sleep buried the thing being measured: 2.2 s of waiting reported
    // as 2.2 s of saving, whatever the save actually cost.
    //
    // The body host only. /exec answers 302 first, and matching that as well
    // stopped the clock on the redirect — half the round trip, reported as the
    // whole save.
    const saved = page.waitForResponse(
      (r) => r.url().includes('googleusercontent.com'),
      { timeout: 60000 }).catch(() => null);
    await box.fill('Scuff on the left wall');
    await saved;
  });

  await step(ctx, 'back to the inspection list', async () => {
    await page.goto(base + '#/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.list-item, .empty-state__title', { timeout: 60000 });
  });

  await step(ctx, 'open + New', async () => {
    await page.click('text=+ New');
    await page.waitForSelector('select.form-select', { timeout: 60000 });
  });

  // Before the browser goes, or the last action's numbers go with it.
  await Promise.allSettled(pendingBodies);
  await browser.close();
  server.close();

  report(ctx.results, serverTimings);
}

function report(results, serverTimings) {
  const mode = LIVE ? 'live' : `stubbed, ${LATENCY} ms latency`;
  console.log(`\n=== Performance walk (${mode}) ===\n`);
  console.log('  step                                 wall    reqs  actions');
  console.log('  ' + '-'.repeat(72));

  let totalMs = 0, totalReqs = 0;
  for (const r of results) {
    totalMs += r.ms; totalReqs += r.requests;
    console.log(
      '  ' + r.name.padEnd(34) +
      String(r.ms + ' ms').padStart(8) +
      String(r.requests).padStart(7) + '  ' +
      (r.actions.join(', ') || '—'));
  }
  console.log('  ' + '-'.repeat(72));
  console.log('  ' + 'total'.padEnd(34) +
    String(totalMs + ' ms').padStart(8) + String(totalReqs).padStart(7));

  if (serverTimings.length) {
    console.log('\n  What the server said about itself:\n');
    console.log('  action              total   auth  reads  writes  lockWait  drive');
    console.log('  ' + '-'.repeat(66));
    for (const t of serverTimings) {
      console.log('  ' + String(t.action).padEnd(20) +
        String(t.totalMs).padStart(5) + String(t.authMs).padStart(7) +
        String(t.reads).padStart(7) + String(t.writes).padStart(8) +
        String(t.lockWaitMs).padStart(10) + String(t.driveMs).padStart(7));
    }
    console.log('\n  The difference between a step\'s wall time and its total here is');
    console.log('  transport, the /exec redirect, and Apps Script cold start.');
  } else if (LIVE) {
    console.log('\n  No server timings came back. They are returned to admins only.');
  }
  console.log('');
}

/**
 * Say what actually went wrong, which is not always what it looks like.
 *
 * This used to print the password advice for every failed sign-in, and one run
 * failed with HTTP 404 — a deployment that was not answering, where the server
 * never saw a password at all. The advice sent someone to reset a working
 * password over a broken URL. The failures below are told apart because
 * confidently wrong guidance costs more than none.
 */
function explain(message) {
  if (/HTTP \d+/.test(message)) {
    return [
      'That is the backend not answering, not a password problem — the server',
      'never saw the credentials.',
      '',
      'Open BACKEND_URL from js/config.js in a browser. If it 404s there too,',
      'check Deploy → Manage deployments in the Apps Script editor: that the web',
      'app deployment still exists, and that its URL is the one in config.js. A',
      'fresh clasp push can also 404 for a minute while it is applied.',
    ];
  }
  if (/timed out|NETWORK_ERROR|Network request failed/.test(message)) {
    return [
      'The request never came back. Sign-in is the slowest call — PBKDF2 plus',
      'two sheet writes — so on a cold script it can outrun the client timeout',
      'in js/config.js. Try once more before treating it as broken.',
    ];
  }
  if (/non-JSON|INVALID_RESPONSE/.test(message)) {
    return [
      'Apps Script returned an HTML error page instead of JSON, which usually',
      'means the server threw before reaching the handler. Check the executions',
      'log in the Apps Script editor for the stack.',
    ];
  }
  if (/Incorrect email address or password|no longer valid|disabled|Too many/.test(message)) {
    return [
      'The server answers the same way for a wrong password, an unknown address,',
      'a disabled account and a locked one — on purpose, so the form cannot be',
      'used to find out who works here.',
      '',
      'whyCantISignIn("you@firma.rs") in the Apps Script editor says which of',
      'them it is. It asks for no password.',
    ];
  }
  if (/Cannot find module/.test(message)) {
    return ['Install the browser:  npx playwright install chromium'];
  }
  return [];
}

main().catch((e) => {
  console.error('\nperf walk failed:', e.message);
  const lines = explain(e.message);
  if (lines.length) console.error('\n' + lines.join('\n'));
  process.exit(1);
});
