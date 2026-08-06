# Performance harness

Drives the real app in a real browser and measures what a person actually
waits for. Separate from `node tests/run.js`, which stays dependency-free —
this one needs Playwright.

```
npm install -D playwright
node tests/perf/run.js            # stubbed backend (default)
node tests/perf/run.js --live     # against the deployed backend
```

## Two modes, and why

**Stubbed** is the default. The backend is intercepted and answers from canned
data with a fixed, configurable delay. That makes it deterministic and safe to
run anywhere, and it measures the two things that are properties of *our* code
rather than of Google's servers:

- **how many requests a screen makes**, and
- **how much of the wait is the browser's own work**.

Request count is the useful regression guard. It is what PR 1 changed: the New
Inspection form asked twice, in sequence, and now asks once. A number like that
either goes back up or it does not, and no amount of platform variance can
disguise it.

**Live** points at the deployment in `js/config.js` and measures real
wall-clock. Run it from a machine that can reach Apps Script — a sandbox
usually cannot. It reads the `timing` block the server now returns to admins,
so each row carries the server's own breakdown (`authMs`, `reads`, `writes`,
`lockWaitMs`, `driveMs`) next to the time the browser observed. The gap between
those two is transport, redirect and cold start.

Live runs need credentials, and they are not in the repo:

```
PERF_EMAIL=you@firma.rs PERF_PASSWORD='…' node tests/perf/run.js --live
```

A live run signs in for real. Point it at a test account, not one whose lockout
counter you care about.

## Reading the output

Every scenario reports wall-clock, request count, and the actions requested.
Compare runs, not absolutes: platform variance on Apps Script has measured a
factor of two between consecutive runs of the same code, so a single number
means little and a consistent shift across scenarios means a lot.

The stub delay defaults to 0 ms, which isolates client-side cost. Set
`PERF_LATENCY=400` to model a slow link and see which screens serialise their
requests — a screen that makes two requests in sequence takes twice the delay,
one that overlaps them takes it once.
