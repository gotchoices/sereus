description: The cadre-host test suites leave their fake node processes running after the tests finish, so a machine that has run the suite a few times accumulates stray node processes that never exit.
files:
  - packages/cadre-host/src/__tests__/orchestrator.test.ts (and the orchestrator-* siblings — `fake-child.mjs`)
  - packages/cadre-host/src/push/__tests__ (or wherever `fake-cli.mjs` is spawned)
  - packages/cadre-host/src/orchestrator/host-process-orchestrator.ts (teardown path the tests exercise)
repro: verified
----

# cadre-host tests leave their fake child processes behind

## Observed (2026-09-16, 00:55)

Twelve orphaned node processes on this machine, all spawned from per-run temp directories:

```
C:\Users\n8ers\AppData\Local\Temp\cadre-host-orch-<rand>\fake-child.mjs start -c …
C:\Users\n8ers\AppData\Local\Temp\cadre-host-push-<rand>\fake-cli.mjs  start -c …
```

Ages at the time of the check: three from 11:43-11:44, six from 12:38-12:47, three from 23:11 — i.e.
one cluster per suite run over the day, each outliving its run by hours. They are small (0-8 MB each)
and idle, so nothing failed because of them; this is hygiene, not an outage.

The 23:11 cluster coincides with a full `sereus` suite run, so this reproduces on a normal
`yarn workspace @serfab/cadre-host test`, not only under unusual conditions.

## Why it is worth fixing

- A developer machine slowly fills with processes that hold temp directories open, which on Windows
  also keeps those directories undeletable.
- The orchestrator's own job is to manage child-process lifecycle. Tests that exercise spawn but
  never prove teardown are exactly the tests that would miss a leak in the product code — so the
  fix is likely a teardown assertion rather than only an `afterEach` kill.

## Direction

Find which tests spawn `fake-child.mjs` / `fake-cli.mjs` and make each one stop what it started
(`afterEach`, with an assertion that the process is gone). Where a test deliberately leaves a child
running to model a crash or a restart, kill it in teardown by pid and say so in a comment. Then run
the suite twice and confirm no `Temp\cadre-host-*` node processes survive.
