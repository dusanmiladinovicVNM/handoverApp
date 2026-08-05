# Getting this code into Apps Script

## Use clasp

One command pushes every file, with names and contents guaranteed to match.

```bash
npm install -g @google/clasp
clasp login
clasp push          # from the repository root
```

The push replaces the project's files with the ones in `gas/`, so it also
repairs a project whose file names have already drifted — the repository
becomes the authority rather than whatever the editor happens to hold.

Files in the project that are not in `gas/` are deleted. That is intended: a
stray file left over from a bad paste is exactly what should go.

## Why this matters more than it sounds

Copying files one at a time into the editor has gone wrong twice, the same way
both times: a paste lands in the wrong file, which **duplicates** one service
and **destroys** another.

The duplicate is loud — the project stops loading with `Identifier X has
already been declared`, and the error names a file that has nothing to do with
whatever you were running. The destroyed half is silent. Everything works until
the missing service is finally called, which can be days later.

Apps Script does not care what a file is called; only the declarations inside
it matter. So a mismatched name breaks nothing by itself, and gives no warning
either. That is exactly what makes the next paste land somewhere unexpected.

`clasp push` removes the whole class of problem: the directory is the project.

## First-time setup

`clasp login` opens a browser once. Then create `.clasp.json` in the repository
root:

```json
{
  "scriptId": "<from the editor: Project Settings → Script ID>",
  "rootDir": "gas"
}
```

`.clasp.json` is gitignored — it points at one specific deployment, and yours
is not necessarily anyone else's.

`clasp push` sends whatever manifest is in `rootDir`, so `gas/appsscript.json`
has to exist before the first push.

**Do not use `clasp pull` to get it.** Pull overwrites `rootDir` with whatever
is currently in the project — including names that have drifted from their
contents, which is the very thing this is meant to stop. It would pull the mess
into the repository instead of pushing the repository over the mess.

Copy it by hand instead, once: in the editor, ⚙ Project Settings → *Show
"appsscript.json" manifest file*, then paste its contents into
`gas/appsscript.json`. `timeZone` and the OAuth scopes are deployment
decisions — take them as they are rather than rewriting them here.

## After pushing

```
verifyDeployment()   every service present and complete, routes and public actions correct
smokeTest()          configuration, workbook, ID counters
```

Then **Deploy → Manage deployments → New version**. Without a new version the
web app keeps serving the previous code, however current the editor looks.

## If you still copy by hand

Run `verifyDeployment()` afterwards, every time. It is the only thing that
catches a service that was silently overwritten, and it takes a few seconds.

## No .claspignore

There was one, briefly, and it broke the first push: it excluded everything and
then failed to re-admit the `.gs` files, so `clasp status` reported the whole of
`gas/` as untracked and there was nothing to send.

It is not needed. clasp only pushes `.gs`, `.js`, `.html` and `appsscript.json`,
so `gas/README.md` — this file — stays out on its own. If a `.json` that does
not belong ever lands in `gas/`, that is the moment to reach for an ignore file,
and to check `clasp status` before trusting it.
