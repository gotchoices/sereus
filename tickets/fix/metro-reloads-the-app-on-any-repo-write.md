description: Any file written anywhere in the repo — a ticket file, a garden report, a commit's churn — reloads the running app on a connected phone, because Metro watches the whole project root. Mid-test that restarts the node and invalidates whatever step was in flight, so device testing currently requires every other agent to stop writing to the repo.
files:
  - packages/reference-app-rn/metro.config.js (watch scope / blockList)
  - docs/reference-app-rn.md (§ testing on a device — what has to be quiet during a run)
repro: verified
----

# Metro reloads the app when anything in the repo is written

## Observed (2026-09-15/16)

Twice during a device session, the app Fast-Refreshed in the middle of a scenario:

- 2026-09-15 23:44:17 — seconds after founding a strand. The node was torn down and the next step
  (sending a message) acted on a disconnected app, which looked like a product failure until the
  reload line `log level = info` was spotted in logcat. The trigger was another session committing
  **ticket files** in `../optimystic` at 23:43:44 (Metro follows the linked workspace packages).
- Earlier the same evening, the same shape in `sereus` from ticket/garden-report commits.

Neither write touched source or `dist`. Metro watches the project root, so ticket files, docs, and
`.git` churn all count.

## Why it matters

Device testing on this repo currently depends on a social protocol: every other agent must hold all
writes, in both repos, for the length of the run. That was arranged by hand tonight (two `tickets/.stop`
files and several messages), and one commit of documentation still broke a scenario. A narrower watch
scope removes the whole class.

## Direction

Narrow what Metro watches to what can actually reach the bundle:

- `resolver.blockList` for `tickets/`, `docs/`, `.git/`, `ops/`, and the other non-bundle trees, or
- an explicit `watchFolders` listing only the workspace packages the app imports.

Prefer whichever keeps the linked `../optimystic` and `../quereus` **dist** outputs watched — those
must still trigger a reload, because that is how a rebuilt dependency reaches the device.

Then verify on a device: with the app running and connected, write a file under `tickets/` and confirm
no reload (no new `Running "main"` and no `log level = info` in logcat), and touch a linked `dist`
file and confirm a reload still happens.
