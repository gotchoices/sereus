----
description: The React Native phone app's start-up and shut-down routine has no automated test at all, even though its sibling NativeScript app has a thorough one. Several rules the code's own comments call essential are checked by nobody.
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/test/, packages/reference-app-ns/test/cadre-phone.spec.ts, packages/reference-app-rn/src/node-local-slots.ts
difficulty: medium
tradeoffs: The module reaches straight for `expo-secure-store` and `rn-leveldb` with no injection seam, so a test has to mock native modules and reset the module registry per test — a real chunk of scaffolding for a file that changes only a few times a year, and the NativeScript suite already proves the shared cadre-core half of the behaviour.
----

# The React Native app's node start/stop path has no test

## What is untested

`packages/reference-app-rn/src/cadre-phone.ts` owns the phone app's `CadreNode`
lifecycle — starting the node, resolving its identity, opening the two durable
on-device record stores, and closing everything on stop. The package's `test/`
directory has ten suites; **none of them is about this file.** The functions
`startPhoneNode`, `stopPhoneNode`, and `getPhoneNode` are never called by any test.

The equivalent NativeScript module *does* have one —
`packages/reference-app-ns/test/cadre-phone.spec.ts` — which drives the real
exports, fakes only the node itself and the database handle, and asserts the
ordering and handle-reuse rules directly. The React Native app has no counterpart.

## Rules the code says are essential, that nothing verifies

Each of these is stated in a comment in `cadre-phone.ts` as load-bearing:

- **The identity key must be resolved before the relay-credential fetch.** The
  fetch signs its request with the node's identity, so resolving it later would
  sign with the wrong key or none. Nothing checks the order.
- **Re-entering start after the operating system killed the node must not open a
  second database handle.** The code uses an assign-if-absent (`??=`) guard
  specifically to avoid leaking one native handle per resume. Nothing exercises a
  second entry.
- **A refused enclave read must fail the start, not fall back.** Silently
  generating a replacement key would orphan the device's real identity. Only the
  underlying store's behaviour is tested, never this call site's reaction to it.
- **Stop must close the database handle even when stopping the node throws.**
  There is a `finally` for it; no test forces the throw.

## Why this is worth a general test rather than four point tests

These are one class of defect — *the start/stop sequence silently changing* — and
one test file catches all of them and the next edit too. The retirement of the
legacy-identity migration (ticket `retire-rn-legacy-identity-migration`) deleted a
statement from the front of `startPhoneNode` and rewrote the comment describing
what that ordering guaranteed. That change was correct, and type-checking and lint
both passed — but nothing in the repository would have objected if it had been
wrong. That is the gap.

## Expected outcome

A `packages/reference-app-rn/test/cadre-phone.spec.ts` that covers the four rules
above. The NativeScript suite is a working template for the hard part: it resets
the module registry before each test so a still-running node from one test cannot
make the next one exit early, and it keeps the shared cadre-core pieces real so
the record-store wiring is proven end to end rather than merely as constructor
arguments.

The React Native module reads `expo-secure-store` and `rn-leveldb` directly, with
no injection point, so deciding how to substitute them is part of the work — a
test-only module mock, or a small seam added to the module, whichever reads
better.
