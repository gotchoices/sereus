description: A developer who uses the core library directly, outside the phone and browser kits, has to hand-write three small pieces of setup that the library already contains or could supply in one call, and the short versions shown in the documentation are only correct for the simplest case.
architecture: docs/api.md#entry-points
files: packages/cadre-core/src/edge-node/config.ts (`runOwnerGenesis`, `enrollFoundedOwner`), packages/cadre-cli/src/commands/start-owner.ts (`wireServerOwnerKey`), packages/integration-tests/src/harness/node-fixtures.ts, packages/cadre-core/src/cadre-node.ts (`formStrand`, `rememberFormedStrand`, `useOwnerSigner`), packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/src/types.ts (`FormStrandResult`, `StrandRow`), packages/cadre-core/src/index.ts, docs/getting-started.md, docs/api.md, packages/cadre-core/README.md
tradeoffs: Each spot has a working answer today and every helper added is public surface to keep correct, so a maintainer may prefer to correct the two documentation examples and leave the calls as they are.
----

# Embedders of a plain `CadreNode` hand-write the first-owner step, the joined strand row and the author key

Found while writing `docs/getting-started.md`, which builds two parties on `CadreNode` with no kit. Three steps of that walkthrough have no call of their own on the main entry point. Each is stated with the cost to a caller; none is a defect in what the library does when called correctly.

## 1. Seating the first owner key

A new party has no owner key, and founding a strand or publishing an invitation throws without one. The complete step has four branches, as `enrollFoundedOwner` in `edge-node/config.ts` writes them: if the party already has an owner key, wire the held key only when it is a live owner and create nothing; otherwise load or create a key, call `ControlDatabase.ensureOwnerKey`, and if that reports that another owner row arrived first, fall back to the wire-only-if-owner path; only after a successful founding insert call `useOwnerSigner`.

That function is reachable only as `runOwnerGenesis` from the `@serfab/cadre-core/edge-node` subpath, wrapped in a time bound that turns failure into a returned `'failed'`. The main entry point offers the parts (`createOwnerKey`, `loadOwnerSigner`, `getControlDatabase().ensureOwnerKey`, `useOwnerSigner`, `wireOwnKeyIfOwner`). The repository therefore holds the sequence three times: `enrollFoundedOwner`, cadre-cli's `wireServerOwnerKey` (`start-owner.ts`), and the integration harness (`node-fixtures.ts`).

The cost shows in the fourth copy, the three-line `becomeOwner` in `docs/getting-started.md`: it ignores `ensureOwnerKey`'s `false` and calls `useOwnerSigner` regardless. `docs/cadre/owner-keys.md` → "Wiring rules" says `useOwnerSigner` anchors the key as trusted "whether or not the party lists it" and must be called directly "only for a key the node has just seated as the founding row". The walkthrough is safe because its party is always new. A reader who keeps that function and later starts the node on a party that already has a different owner key anchors a key that is no owner's.

Wanted: one call on the main entry point that performs the whole step for a founded party and throws on failure, which the edge node's bounded wrapper, cadre-cli and the harness can share.

## 2. The row for a strand just joined

After `formStrand` the app calls `addStrand({ strandRow, sAppConfig })`, and builds `strandRow` itself: five fields, two of them always null for a joined strand, and `Type` inferred from whether `result.memberPrivateKey` is present (`docs/api.md` → "Joining"). The node builds the same record itself a moment earlier in `rememberFormedStrand`, and `joined-strand-store.ts` has the function that turns that record into a `StrandRow`.

The cost: `docs/getting-started.md` shows the open-strand literal (`Type: 'o'`, `MemberPrivateKey: null`), and a reader who reuses it for an invitation to a closed strand starts a closed strand as an open one. What the node then does was not run for this ticket. From reading `StrandInstanceManager`, only a row of type `'c'` starts the membership loop, so the party's member rows would not be written.

Wanted: `FormStrandResult` carries the `StrandRow` to pass on (or `addStrand` accepts the result), so no caller infers the type.

## 3. Generating an sApp author key

`signSchema` and `ed25519PublicKeyFromPrivate` are exported from `@serfab/cadre-core`; a generator for the key they take is not. `docs/getting-started.md` and `packages/cadre-core/README.md` import `generatePrivateKey` from `@optimystic/quereus-plugin-crypto`, which cadre-core depends on but an app does not declare. The app must add that package itself and keep its version in step, or the import fails under a package manager that does not expose undeclared dependencies.

Wanted: cadre-core re-exports the generator beside `signSchema`, or exports a `generateSAppAuthorKey()`.

## Scope

One ticket because the three share a cause (the kit-free path was never walked end to end until the walkthrough was written) and a remedy (a small addition to the main entry point, then the documents use it). The walkthrough itself has not been executed; running it under a test is `debt-doc-examples-that-call-the-api-are-executed`.
