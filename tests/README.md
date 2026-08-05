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

## Scope

Backend only, and within that, accounts and authentication. Inspections,
attachments, PDF generation and everything touching Drive or Sheets APIs are
not covered — those need the real platform.

The manual scenarios in `docs/user-administration-proposal.md`, section 15,
remain the acceptance check. Numbers 1 through 11 are automated here; the rest
need a browser and a deployment.
