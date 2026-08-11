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

  if (LIVE) {
    // Watch the wire without answering for it, and pick up the timing block
    // the server returns to an admin.
    page.on('request', (r) => {
      if (!r.url().includes('/macros/s/')) return;
      try { calls.push(JSON.parse(r.postData() || '{}').action || '(none)'); } catch (_) {}
    });
    page.on('response', async (r) => {
      if (!r.url().includes('/macros/s/')) return;
      try {
        const body = await r.json();
        if (body && body.data && body.data.timing) serverTimings.push(body.data.timing);
      } catch (_) {}
    });
  } else {
    await install(page, LATENCY, calls);
  }
  const ctx = { calls, results: [] };
  const base = `http://127.0.0.1:${PORT}/index.html`;

  const email = process.env.PERF_EMAIL || 'perf@firma.rs';
  const password = process.env.PERF_PASSWORD || 'correct horse battery staple';

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
    await page.waitForSelector('.list-item, .empty-state__title', { timeout: 60000 });
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

  await step(ctx, 'type an answer (autosave)', async () => {
    await page.click('.section-list__item');
    await page.waitForSelector('.cards-wrapper .question__input-slot', { timeout: 60000 });
    const box = page.locator('textarea, input[type=text]').first();
    if (await box.count()) {
      await box.fill('Scuff on the left wall');
      // Past the autosave debounce, so the save is included.
      await page.waitForTimeout(2200);
    }
  });

  await step(ctx, 'back to the inspection list', async () => {
    await page.goto(base + '#/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.list-item, .empty-state__title', { timeout: 60000 });
  });

  await step(ctx, 'open + New', async () => {
    await page.click('text=+ New');
    await page.waitForSelector('select.form-select', { timeout: 60000 });
  });

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

main().catch((e) => {
  console.error('\nperf walk failed:', e.message);
  console.error('\nIf this is about a missing browser, install one:  npx playwright install chromium');
  process.exit(1);
});
