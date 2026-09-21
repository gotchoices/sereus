description: The browser build of the SQL plugin is 4.89 MB — nearly double the 2.5 MiB its own test assumes — and loading it timed out the 30-second shape test during a full `yarn check`, while passing in 2 of 2 isolated runs. Find out what the growth is, whether any of it is avoidable for a browser payload, and stop the test from failing on machine load.
files:
  - packages/quereus-plugin-sereus/test/browser-shape.spec.ts (line 74, the stale "2.5 MiB" comment, and the two 30 s timeouts)
  - packages/quereus-plugin-sereus/dist/plugin-browser.js (the artifact — 4,890,498 bytes at 045e5747)
  - packages/quereus-plugin-sereus (the bundler config that produces it)
repro: `yarn check` at 045e5747 failed it once under full-suite load; `yarn workspace @serfab/quereus-plugin-sereus test` passed 2 of 2 alone.
----

# The browser bundle has doubled, and its shape test times out under load

## What happened

A full `yarn check` at `045e5747` failed one test:

```
FAIL |unit| test/browser-shape.spec.ts > browser bundle module shape > default export is a function
Error: Test timed out in 30000ms.
```

The test does one thing: `await import(bundle)` and check the default export is a function. It ran
twice more alone, immediately afterwards, and passed both times. So the test is not wrong about the
bundle — it ran out of time loading it on a loaded machine.

## The part worth attention

The bundle is **4,890,498 bytes**. The comment on the test, written when the timeout was chosen,
says "2.5 MiB ESM parses in roughly 1-5s on a cold cache; give it headroom." The artifact is now
about 1.9 times that, and the headroom went with it.

Nobody chose that growth, and nothing guards it: there is no size assertion anywhere in the package,
so the number can double again without any run going red. This matters more than the flake — it is
the payload a browser downloads and parses before the plugin does anything.

## TODO

- Measure what is in the bundle (`esbuild --analyze`, `rollup-plugin-visualizer`, or the bundler's
  own report — whichever the package already uses). Name the largest contributors.
- Find when it grew. `git log` the bundler config and the plugin entry, and check out a few older
  commits to size the artifact. A single dependency is the likely cause.
- Decide what, if anything, is avoidable: a dependency pulled in whole for one helper, a Node-only
  path that should have been dropped from the browser build, duplicated copies of a library.
  Changing this is a separate implement ticket — this ticket's job is to find out.
- Add a size guard so the next doubling fails a run rather than passing quietly. A single assertion
  in `browser-shape.spec.ts` against a recorded ceiling is enough; state the current number and the
  date in a comment beside it.
- Fix the flake. The timeout is a wall-clock budget on an import whose cost scales with the bundle,
  run inside a suite that loads the machine. Options: raise it, derive it from the bundle size, or
  take the import out of the timed path. Say which and why.

## Not in scope

The bundle's size may be entirely justified — libp2p and a SQL engine are not small. This ticket
asks for the number to be known and guarded, not for it to be smaller at any cost.
