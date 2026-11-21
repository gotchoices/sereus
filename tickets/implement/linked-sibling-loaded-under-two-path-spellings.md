description: On Windows, when a linked sibling repository's folder is spelled with different capital letters than this repo's links use, tests load a second copy of the storage library and fail in ways that look like real bugs. Add a test-setup check that refuses such a run and says how to fix it, as the setup already does for a lowercase drive letter.
architecture: docs/contributing/testing.md#windows-start-from-an-uppercase-drive-letter
files: test-harness/linked-package-spellings.ts (new), test-harness/linked-package-spellings.spec.ts (new), test-harness/build-freshness.ts (export workspacePackageRoots; carry the junction path on a linked result), test-harness/build-freshness.spec.ts (assertions on the linked-result shape), packages/cadre-core/test/global-setup.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-host/src/__tests__/global-setup.ts, packages/cadre-provider/test/global-setup.ts, packages/cadre-rn/test/global-setup.ts, packages/integration-tests/test/global-setup.ts, packages/quereus-plugin-sereus/test/global-setup.ts, packages/reference-app-ns/test/global-setup.ts, packages/reference-app-rn/test/global-setup.ts, packages/reference-app-web/test/global-setup.ts, docs/contributing/testing.md
repro: verified
difficulty: medium
----

# A linked sibling loaded under two path spellings

A **spelling** here is the exact path string a junction stores for the directory it points at. Two junctions can point at one directory and store different strings for it, because Windows compares paths without regard to case.

## The mechanism, measured

Node keys its module cache by the resolved path string, and the resolution it uses keeps whatever spelling a junction stored. `fs.realpathSync` behaves the same way; only `fs.realpathSync.native` corrects a path to the directory's own spelling on disk. On this checkout, 2026-11-21:

```
realpathSync('packages/reference-app-web/node_modules/@optimystic/db-core')
  => C:\Projects\optimystic\packages\db-core
realpathSync.native(same path)
  => C:\Projects\Optimystic\packages\db-core
realpathSync('node_modules/@optimystic/db-core')
  => C:\Projects\Optimystic\packages\db-core
```

So one directory reached under two spellings is loaded twice. Proved end to end through Node's own bare-specifier resolution, with no test framework involved: a module placed under `packages/reference-app-web` and a module at the repository root, each doing `import '@optimystic/db-core'`, got different namespace objects and different `BlockUnavailableError` classes. Every `instanceof` across that boundary is false, which is why `isCohortUnreachableRead` in `packages/cadre-core/src/control-read-retry.ts` failed to recognise an error the plugin threw.

## Why the spellings disagree

The folders on disk are `C:\Projects\Optimystic` and `C:\Projects\Quereus`. The root `package.json`'s `resolutions` name them as `link:../optimystic/...` and `link:../quereus/...`, so yarn writes this repository's junctions with those spellings. A sibling's own install writes its packages' nested links relative to its own checkout, so Optimystic's nested links store `C:\Projects\Optimystic\...` — the disk spelling, and the one this repository's links do not use. Those nested links sit inside the sibling and are not ours to change.

Quereus happens not to disagree: Optimystic's `resolutions` also spell it `../quereus`, so both repositories' links store `C:\Projects\quereus`. Uniformly not the disk spelling, therefore one module instance, therefore harmless. That is why no failure from Quereus has been seen, and it is also why the check must compare the spellings against each other rather than against the disk: a uniformly odd spelling works, and refusing it would stop every suite on this machine for no reason.

## State on this machine, and a command not to run

The root `node_modules/@optimystic/*` junctions were repointed by hand to `C:\Projects\Optimystic\...`. The three packages that set `installConfig.hoistingLimits: "workspaces"` keep their own copies of those dependencies, and those were not repointed, so `packages/reference-app-{web,rn,ns}/node_modules/@optimystic/*` still store `C:\Projects\optimystic\...`.

Measured per suite with a prototype of the walk described below, 2026-11-21 — the packages each suite would load under two spellings:

| Suite | Packages that resolve to two spellings |
| --- | --- |
| `cadre-core`, `cadre-cli`, `cadre-host`, `cadre-provider`, `cadre-rn`, `quereus-plugin-sereus`, `integration-tests` | none |
| `reference-app-web` | `db-core`, `db-p2p`, `db-p2p-storage-web` |
| `reference-app-rn` | `db-p2p`, `db-p2p-storage-rn` |
| `reference-app-ns` | `db-core`, `db-p2p` |

**Do not run `yarn install` to clear this.** It rewrites every junction from `resolutions`, so all of them would store `C:\Projects\optimystic\...` again: agreeing with each other, disagreeing with Optimystic's own nested links, which is the original `cadre-core` failure. The only consistent state on this machine is every `@optimystic/*` junction in this repository pointing at `C:\Projects\Optimystic\...`, matching the sibling's own links.

## The check

A new harness module, `test-harness/linked-package-spellings.ts`, beside the existing setup guards. It reads only `lstat`, `readlink`, `realpath` and `package.json`, and writes nothing — in this repository or in a sibling (`tickets/rules/sibling-repos.md`).

```ts
/** One junction's target, as the loader sees it and as the disk spells it. */
export interface PackageSpelling {
	/** `realpathSync` of the junction — the string Node's module cache keys on. */
	readonly resolved: string;
	/** `realpathSync.native` of it — the directory's own spelling. */
	readonly onDisk: string;
	/** Every `node_modules/<pkg>` junction that resolved to `resolved`, deduped, discovery order. */
	readonly via: readonly string[];
}

/** A package name this suite would load under more than one path string. */
export interface SpellingDisagreement {
	readonly packageName: string;
	/** One entry per distinct `resolved`, so always two or more. */
	readonly spellings: readonly PackageSpelling[];
}

/** Every linked target of `targets` that this suite would load under two or more path strings. */
export function findSpellingDisagreements(targets: readonly BuildTarget[], setupUrl: string): SpellingDisagreement[];

/** Throws, naming the spellings, the junctions and the remedy, when there is any disagreement. */
export function assertOneSpellingPerLinkedPackage(targets: readonly BuildTarget[], setupUrl: string): void;
```

The detector walks *loading contexts*, which is what Node itself does. A loading context is a directory an `import '<pkg>'` is resolved from.

Seed the contexts with the setup module's own directory, standing for the suite's own files, and with the root directory of every `workspace` target in `targets`: those are reached through a `@serfab/*` junction, so Node resolves their own imports from there rather than from the suite. `workspacePackageRoots()` in `build-freshness.ts` already maps a workspace package name to its directory; export it.

From each context, resolve each candidate name with the already-exported `resolveLinkedPackageFrom`, and keep only `linked` results. A registry-installed copy cannot disagree about a sibling's spelling, and an absent one is not loaded. Record `packageName -> resolved -> junction paths`, and make each newly resolved root a context in turn, bounded by a seen-set of context directories so the walk terminates. A name with two or more distinct `resolved` strings is a disagreement.

Candidate names differ by context. For the seed suite directory, use every `linked` target name in `targets` — that list is already curated as the packages the suite runs compiled code from. For a discovered context, use only the names that context's own `package.json` declares among `dependencies`, `peerDependencies` and `optionalDependencies`, intersected with those linked target names. The filter is load-bearing, not tidiness: without it a sibling resolves its own package name from its own checkout, and the walk reports a disagreement for an import nothing performs. Measured in the prototype — every suite reported `@quereus/quereus` split between `C:\Projects\quereus\...` and `C:\Projects\Quereus\...`, the latter reachable only from inside the Quereus checkout, where the sole matches for its own package name are JSDoc examples.

There is no platform branch. The check compares path strings; on a case-sensitive filesystem the spellings simply agree and it passes. It also passes trivially when `resolutions` carries no `link:` entries, as under `yarn check:published`, because then nothing resolves as `linked`.

### What the message has to carry

Per disagreeing package: each spelling, the junctions holding it, and the directory's spelling on disk. Then the consequence, so a reader does not take it for cosmetic — the package is loaded twice, so `instanceof` across the two copies is false and an error thrown by one is not recognised by code that imported the other.

Then a remedy that branches on where the disagreeing junctions sit, because the action differs:

- **All of them under this repository's own `node_modules`:** repoint the stragglers to the spelling the others use. Say outright that `yarn install` is not the remedy, and why — it rewrites every junction to the `resolutions` spelling, which may be the one that disagrees with a sibling's own links.
- **One of them inside a sibling checkout:** that sibling's install stored the directory's own spelling. Either rename the sibling folder so it matches the `resolutions` paths, after which its owner reinstalls it because its existing nested links still hold the old spelling, or repoint this repository's junctions to the spelling the sibling uses. Do not write in the sibling.

### Wiring

Each of the ten setup modules calls it between the two checks it already runs:

```ts
export default function setup(): void {
	assertUppercaseDriveLetter();
	assertOneSpellingPerLinkedPackage(TARGETS, import.meta.url);
	assertBuildFresh(TARGETS, import.meta.url);
}
```

Before `assertBuildFresh` for a reason, not just cost: with two spellings live, the freshness walk judges two roots for one package, so its verdict may be about a copy that is not the one that runs.

`resolveLinkedPackageFrom` returns only the resolved root today, and the message needs the junction path that produced it. Add that path to the `linked` variant of `LinkedPackage`; `resolveLinkedPackage` already computes it. `build-freshness.spec.ts` compares whole `LinkedPackage` values, so its assertions need the new field.

`scripts/check-stale-build-guard-wiring.mjs` needs no change: it keys on the `build-freshness` import specifier, and every setup module that will call the new check already imports that. Worth a `NOTE:` at one call site — nothing fails if someone deletes only the `assertOneSpellingPerLinkedPackage` line from one setup module, which is equally true of `assertUppercaseDriveLetter` today; if a third such setup check appears, gate the set rather than that one import.

## Tests

One spec, `test-harness/linked-package-spellings.spec.ts`, over temp-dir fixtures built the way `build-freshness.spec.ts` builds its chain fixtures (`mkdtempSync`, `symlinkSync(target, link, 'junction')`, `realpathSync` on the temp root because macOS hands out a symlinked one). It runs in the integration suite, whose vitest `include` already carries `../../test-harness/**/*.spec.ts`.

The cases are the detector's real branches, one test each:

- Two junctions for one package name resolving to different paths are reported, and the thrown message carries both spellings and both junction paths.
- One spelling everywhere is not reported.
- A registry-installed copy — a real directory rather than a junction — beside a linked one is not reported.
- A context that does not declare a name contributes no candidate for it, so a package reachable only by a name its holder never imports is not reported.
- The walk reaches a junction in a nested `node_modules` inside a linked package, not only the chain above the suite.
- Windows only (`it.runIf(process.platform === 'win32')`): two junctions onto one real directory whose stored spellings differ only in case are reported, with `onDisk` naming the directory's own spelling. This is the bug's reproduction at the lowest layer that has it, and the only case that exercises the `realpathSync` versus `realpathSync.native` difference.

## Docs

A new section in `docs/contributing/testing.md` under "Rules for running tests", immediately after "Windows: start from an uppercase drive letter", with a sentence tying the two together: both are one file loaded under two path spellings. Cover what goes wrong, that each package's global setup refuses the run and names the spellings and junctions, how the disagreement arises between this repository's `resolutions` and a sibling's own install, and the remedy — including that `yarn install` is not it. Paragraph and list-item limits are 120 words; the file is at 2,118 of its 6,000-word budget (`wc -w docs/contributing/testing.md`), so there is room. `docs/contributing/gates.md` needs no change: it does not list `assertUppercaseDriveLetter` either, these being setup refusals rather than gates.

## TODO

- Export `workspacePackageRoots` from `test-harness/build-freshness.ts`, and add the junction path to the `linked` variant of `LinkedPackage`; update the `build-freshness.spec.ts` assertions that compare whole `LinkedPackage` values.
- Write `test-harness/linked-package-spellings.ts`: the two interfaces, `findSpellingDisagreements`, `assertOneSpellingPerLinkedPackage`, and a module comment that defines "spelling" on first use and states the `realpathSync` versus `realpathSync.native` fact the whole check rests on.
- Build the message: spellings, junctions, on-disk spelling, the `instanceof` consequence, and the two-branch remedy with the explicit "`yarn install` is not the fix" sentence.
- Call it from all ten setup modules, between `assertUppercaseDriveLetter()` and `assertBuildFresh(...)`.
- Write `test-harness/linked-package-spellings.spec.ts` with the six cases above.
- Add the `docs/contributing/testing.md` section; run `yarn check:docs`.
- Run `yarn lint`, `yarn typecheck`, `yarn dep-check` (the new module's exports are reached from the setup modules and the spec, which knip should accept as `build-freshness.ts`'s already are), and `yarn check:test-file-typecheck-coverage` plus `yarn check:vitest-typecheck-coverage` for the new spec file.
- Validate the check fires where the measurement above says it should and stays silent where it says it should not: run `yarn workspace @serfab/cadre-core test` (expect it to start) and the `reference-app-web` suite (expect the refusal, naming `@optimystic/db-core`, `db-p2p` and `db-p2p-storage-web`). Do not run `yarn install`.
- Then make this machine consistent so the three reference-app suites can run, by repointing their stragglers — this repository's own `node_modules`, not a sibling's. For each `packages/reference-app-{web,rn,ns}/node_modules/@optimystic/*` junction whose target starts `C:\Projects\optimystic`, delete the junction non-recursively and recreate it against `C:\Projects\Optimystic`: `[System.IO.Directory]::Delete('<link>', $false)` then `New-Item -ItemType Junction -Path '<link>' -Target '<uppercase target>'`. Never a recursive delete anywhere near these (`tickets/rules/sibling-repos.md`). Re-run the three suites afterwards. If that is not safe to do or does not take, leave the junctions alone and record in the handoff that those three suites refuse to start on this machine, quoting the guard's own message — that is the guard working, not a test failure to chase.
