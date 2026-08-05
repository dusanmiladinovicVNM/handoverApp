# Backend tests

```
node tests/run.js            # run everything
VERBOSE=1 node tests/run.js  # keep the services' own log output
```

No dependencies and no test framework — plain Node, so it runs anywhere and
starts instantly.

## How it works

`appsscript-stubs.js` loads the real `.gs` files into a `vm` sandbox with the
Apps Script built-ins replaced: `Utilities` maps onto `node:crypto`, and
`SheetService` becomes an array. Nothing is reimplemented — every service under
test is the file that gets deployed.

Caching is off by default. A cached user row would mask the very property most
of these tests exist to protect: that a user's role and status are re-read on
every request rather than trusted from the token.

## What is covered

| Suite | What it protects |
|---|---|
| `load-order.test.js` | Every `.gs` file loads whatever order Apps Script picks; the routing table |
| `password.test.js` | PBKDF2 output, checked against `crypto.pbkdf2Sync` |
| `auth.test.js` | Token issuing and resolution, revocation, forgery, the tenant flow |
| `account.test.js` | Login, lockout, account enumeration, password set/change/reset, refresh |
| `user-admin.test.js` | The admin screen's actions, the guardrails, and who is refused |

Four of these matter more than the rest, because each protects something that
would keep *looking* correct after it broke:

**Load order.** Apps Script shares one global scope across files but evaluates
them in order, and each service is a `const`, so a name is unusable until its
own file has run. A file that dereferences another service while loading works
or throws purely by position — and position shifts whenever a file is added.
This is not hypothetical: adding the account services moved `Router.gs` ahead of
`SignatureService.gs`, and `bootstrapSheet()` began failing with
"SignatureService is not defined" — an error naming a file that had nothing to
do with the call.

**PBKDF2 against Node's own implementation.** A key derivation written by hand
can be wrong in a way nothing else notices — a wrong-but-consistent function
still lets everyone sign in normally, while the stored hashes are far weaker
than intended. Only comparing against a known-good implementation catches that.

**Authority read from the record, not the token.** If a role ever ends up baked
into the signed payload, the admin screen keeps working exactly as before,
except that revoking someone's admin rights silently does nothing until their
token expires.

**Uniform answers on failed sign-in.** An unknown address, a disabled account,
a wrong password and a locked account must all read identically. Any one of
them drifting to its own message turns the login form into a way to enumerate
who works here.

**The guardrails.** Nothing stops the last administrator being disabled except
an explicit check, and the failure only shows up when there is no one left to
undo it. These are also exactly the checks that look redundant a year later.

One trap worth knowing if you extend `user-admin.test.js`: an `authCtx` is a
snapshot taken when a token is resolved. A real request builds a fresh one per
call, so a test that changes a role and then reuses an old context is testing
the snapshot, not the rule. Re-resolve the token instead.

## Scope

Backend only, and within that, accounts and authentication. Inspections,
attachments, PDF generation and everything touching Drive or Sheets APIs are
not covered — those need the real platform.

The manual scenarios in `docs/user-administration-proposal.md`, section 15,
remain the acceptance check. Numbers 1 through 11 are automated here; the rest
need a browser and a deployment.

## visibility.test.js

Which inspections an inspector may see and touch.

Most of it is ordinary: an admin sees everything, an inspector sees what is
assigned to them, a tenant link still reaches only its own inspection. Two
parts are worth knowing about before changing them.

The first section reads the `.gs` sources rather than calling anything. The
failure it guards against is an omission — a handler that takes an
`inspectionId` and never asks who is calling — and a check that is never made
cannot be caught by making it. Adding a handler that names an inspection means
adding a line to that list.

The refusal test asserts that an inspector gets the *same* answer for someone
else's inspection and for one that does not exist. Inspection ids run in
sequence, so a distinguishable `FORBIDDEN` would let any account walk the range
and count the firm's work. If that test fails after a change to error handling,
the fix is the error, not the test.

## drive-folders.test.js

The real `DriveService` over a fake Drive that counts round trips.

Drive is the other remote service on the request path, and it was the more
expensive one: creating an inspection made seven calls to Drive against three
to the spreadsheet, and every photo upload walked from the root down to
rediscover a folder id the inspection row already stored.

Cutting round trips on a filing system either works or quietly puts files
somewhere else, so every count assertion is paired with one about the resulting
folder's full path. If a count assertion fails after a deliberate change, update
the number — but never delete the path assertion beside it.

`secondRequest()` builds an installation in one execution and then loads the
service again against the same fake Drive and the same Script Properties. That
is what a later request sees: the remembered ids survive, the per-execution
caches do not.
