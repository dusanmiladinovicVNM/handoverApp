# Getting this code into Apps Script

## Use clasp

One command pushes every file, with names and contents guaranteed to match.

```bash
npm install -g @google/clasp
clasp login
clasp push          # from the repository root
```

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

`gas/appsscript.json` is **not** in this repository. `clasp push` will send
whatever manifest is in `rootDir`, so pull the current one down first:

```bash
clasp pull          # brings appsscript.json into gas/
```

Check it keeps `timeZone` and the four OAuth scopes the backend needs
(`spreadsheets`, `drive`, `documents`, `script.send_mail`) before pushing
anything back.

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
