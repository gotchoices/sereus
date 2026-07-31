description: Enrolling a trusted approver's key (or an owner key) accepts any non-empty text today, so a typo is saved without complaint and the invitations that depend on that key silently stop working, with nothing anywhere explaining why. Add a shared format check so a malformed key is refused immediately, with a message that says what was wrong.
files: packages/cadre-core/src/ed25519-key.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-cli/src/commands/validation-key.ts, packages/cadre-cli/test, packages/cadre-core/test
difficulty: easy
----

# Key enrollment accepts malformed keys

## Design (resolved)

A base64url-encoded 32-byte ed25519 public key is the only shape ever written into
`CadreControl.ValidationKey.Key` or `CadreControl.OwnerKey.Key` by cadre-core. Today the only
guard is `requireNonBlank` in `packages/cadre-core/src/cadre-node.ts` — "not empty or
whitespace" — so `cadre validation-key add "not-a-key"` succeeds, prints `✓ Approver key
enrolled`, and the value sits in the table looking exactly like a real key until some later,
unrelated invitation redemption fails to verify and reports a generic authorization refusal.

Fix: add one shared validator in `packages/cadre-core/src/ed25519-key.ts` (next to
`ed25519KeyPairFromLibp2p`'s existing length checks — this file is already "the place that
knows what a well-formed key looks like") and call it at every place a control key is
written, not just at the CLI. A programmatic caller (cadre-host, `reference-app-rn`,
`reference-app-web`) goes through the same `CadreNode` methods the CLI does, so validating in
`cadre-core` covers both automatically — no separate CLI-side check is needed.

```ts
// packages/cadre-core/src/ed25519-key.ts
export function requireEd25519PublicKeyB64(value: string, label: string): string
```

Behavior:
- Trim `value` first; reuse the existing blank-value message ("A {label} is required
  (received an empty or whitespace-only value)") when the trimmed value is empty — this
  keeps today's blank-value wording for that case instead of a confusing "not valid base64url"
  message for an empty string.
- Decode the trimmed value as base64url (`fromString(trimmed, 'base64url')` from
  `uint8arrays`, already used elsewhere in this file as `toString`). Decoding a string with
  invalid base64url characters throws from the library — catch that and re-throw a clear
  message naming the label and value, e.g. `` `A {label} must be a base64url-encoded ed25519
  public key (could not decode "{trimmed}" as base64url)` ``.
- Assert the decoded byte length is exactly 32. If not, throw a message stating the label,
  the expected length, and the actual decoded length, e.g. `` `A {label} must be a
  base64url-encoded 32-byte ed25519 public key (decoded to {n} bytes)` ``.
- Return `trimmed` (mirrors `requireNonBlank`'s contract: callers write the same bytes they
  validated).
- Do **not** attempt point-on-curve validation. A well-formed-but-not-on-curve value fails
  signature verification later exactly like any other wrong key — that is not the failure
  mode this ticket addresses, and it is out of scope.

Call sites to change (replace `requireNonBlank(key, '...')` with
`requireEd25519PublicKeyB64(key, '...')` — same trim-and-return contract, so no other line at
each call site needs to change):
- `CadreNode.enrollValidationKey` (`packages/cadre-core/src/cadre-node.ts`, ~line 3148-3150) —
  the approver-key enrollment path from the ticket title, reached by both `cadre
  validation-key add` and any programmatic caller.
- `ControlDatabase.ensureOwnerKey` (`packages/cadre-core/src/control-database.ts`, ~line
  487-495) — the owner-key genesis insert. In production this key is always derived from a
  real libp2p identity (`ed25519KeyPairFromLibp2p`), so this call is defense-in-depth rather
  than closing an observed hole — validate anyway, since the ticket calls for the same check
  on owner keys and a future caller could pass a manually-typed key here.

Deliberately **out of scope** (decided, not deferred):
- `CadreNode.removeValidationKey` keeps `requireNonBlank`. Removing a malformed value is
  already a harmless no-op (`ControlDatabase.deleteValidationKey` no-ops when the key is not
  enrolled) — there is no "silently broken invitation" failure mode on the remove path, so
  tightening it adds a check without fixing a bug.
- `CadreNode.trustOwnerKeys` / the `--pin-owner-key` CLI flag / `CadreInvite.ownerKeys` (the
  node-local `TrustedOwnerStore` anchor, `packages/cadre-core/src/trusted-owner-store.ts`) are
  a different mechanism from the replicated `OwnerKey` table this ticket is about — pinning a
  malformed key there degrades trust anchoring but is a separate concern with its own call
  sites (`CadreNode.start`'s config path, `packages/cadre-cli/src/commands/start.ts`). Not
  touched here; file a separate `backlog/debt-` ticket if it turns out to matter in practice
  (out-of-band-established keys, not operator-typed-at-a-prompt keys, are the normal case
  there).
- No `schemas/control.qsql` change. A CHECK constraint enforcing byte length would need a
  reliable base64url-decode-and-length builtin in the Quereus dialect this schema uses, and
  would only catch a writer that bypasses `cadre-core` entirely — every writer that goes
  through it (which is every writer in this repo today) is already covered by the library
  guard above. Larger blast radius for no additional coverage against a real write path; skip.

## Edge cases & interactions

- Empty string / whitespace-only key → same "required" message as today (not a base64url
  error) — covered above.
- Key with invalid base64url characters (e.g. contains `+`, `/`, or padding `=`, which
  base64url does not use) → clear decode-failure message, not a raw library exception.
- Key that decodes cleanly but to the wrong length (too short, too long, e.g. a base64-encoded
  seed instead of a public key, or a truncated paste) → clear length-mismatch message naming
  the actual decoded length.
- Key that is exactly 32 decoded bytes but is NOT a valid point on the ed25519 curve → must
  still be **accepted** by this validator (out of scope per design above); confirm it still
  fails later, normally, at signature verification, and that no regression makes it succeed.
- `cadre validation-key add <bad-key>` end-to-end: command must exit non-zero with the new
  message on stderr, and `cadre validation-key list` afterward must show the key was **not**
  enrolled.
- Enrolling a syntactically valid key that happens to equal an already-enrolled key (the
  existing `planAdd` "already enrolled" branch in `packages/cadre-cli/src/commands/validation-key.ts`)
  must be unaffected — validation happens before that branch's write, but the branch's own
  read-then-decide logic doesn't change.
- `ControlDatabase.ensureOwnerKey` called with a malformed key (a test double, or a future
  caller) must throw the same style of message rather than reaching the schema's `Authorized`
  CHECK and failing as an opaque constraint error.
- Existing tests that pass deliberately-fake short strings as keys (e.g. `'RUNTIME_KEY'`, `'K'`
  in `packages/cadre-core/test/cadre-node-trusted-owners.spec.ts`) are exercising
  `trustOwnerKeys`/`TrustedOwnerStore`, which this ticket does **not** touch — confirm they
  keep passing unmodified. Any test that passes a fake short string through
  `enrollValidationKey` or `ensureOwnerKey` specifically will need updating to use a real
  32-byte base64url key (generate one the way existing specs already do, e.g. via the same
  keypair helpers `control-database-genesis.spec.ts` / `ed25519-key.spec.ts` use) — grep for
  those two call sites across `packages/cadre-core/test` before assuming none exist.

## TODO

- Add `requireEd25519PublicKeyB64(value, label)` to `packages/cadre-core/src/ed25519-key.ts`
  per the behavior spec above.
- Switch `CadreNode.enrollValidationKey` to use it in place of `requireNonBlank`.
- Switch `ControlDatabase.ensureOwnerKey` to use it in place of whatever currently guards
  `key` there (check current code — it may have no guard at all beyond the schema).
- Add unit tests for `requireEd25519PublicKeyB64` covering: blank, invalid-base64url,
  wrong-length, valid — in a new or existing spec near `packages/cadre-core/test/ed25519-key.spec.ts`.
- Add/adjust a `cadre-node` or `control-database` spec asserting `enrollValidationKey` and
  `ensureOwnerKey` reject a malformed key with a message identifying the problem (not a raw
  constraint error).
- Add a CLI-level test (or extend existing `validation-key` tests) asserting `cadre
  validation-key add <malformed>` exits non-zero, prints an explanatory message, and leaves
  the enrolled set unchanged.
- Run `yarn workspace @serfab/cadre-core test` and `yarn workspace @serfab/cadre-cli test`;
  run `yarn lint` across touched packages.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
