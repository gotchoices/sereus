description: A typo in an operator-supplied trusted-owner key is accepted at startup and only shows up much later as "this node won't join", with no message pointing at the typo.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/ed25519-key.ts
difficulty: easy
----

# Pinned owner keys accept malformed values

## What happens today

A node that is joining someone else's cadre is told, out of band, which owner keys to trust.
Those keys arrive by three routes:

- the repeatable `--pin-owner-key <b64url>` flag on `cadre start`,
- the comma-separated `CADRE_OWNER_KEYS` environment variable,
- the `ownerKeys` list carried inside an invitation being redeemed.

All three end at `CadreNode.trustOwnerKeys(keys, source)`, which stores each string in the
node-local trusted-owner anchor verbatim. Nothing checks that the string is even shaped like a
key. `collectPinnedOwnerKeys` in `packages/cadre-cli/src/commands/start.ts` trims and dedupes,
and its comment states plainly that validation is deliberately skipped because a bad pin
"simply never matches a real signer key".

That is true, and it is fail-safe — a bad pin can never grant trust it shouldn't. The cost is
diagnosability. A single mistyped character in a pin produces a node that starts fine, looks
healthy, and then refuses every seed it is handed with a trust-policy rejection that talks
about the *seed's* signer not being anchored. Nothing anywhere says "the key you pinned isn't
a key". For an operator setting up a donated node, this is a confusing dead end.

## What is wanted

The same up-front shape check the replicated control keys just got:
`requireEd25519PublicKeyB64` (in `packages/cadre-core/src/ed25519-key.ts`, exported from the
package entry point) already rejects anything that is not a base64url-encoded 32-byte Ed25519
public key, with a message naming the actual problem. Applying it to the pinned-key routes
means a typo fails at startup, immediately, pointing at the value that is wrong.

Expected behavior:

- `cadre start --pin-owner-key <garbage>` refuses to start, printing which value was rejected
  and why, exiting non-zero — rather than starting and failing to join later.
- The same for a garbage entry in `CADRE_OWNER_KEYS`.
- An invitation whose `ownerKeys` list contains a malformed entry is refused as a malformed
  invitation. Note this route differs from the other two: the value comes from a remote party,
  not from the operator's own keyboard, so decide whether the whole redemption fails or the
  bad entry is dropped with a warning — and say which in the resulting message.

## Why this is separate from the ticket that prompted it

`debt-control-key-enrollment-accepts-malformed-keys` put the shape check on the two *replicated
control-database* key writes (approver keys and the founding owner key). The pinned-owner
anchor is a different store with different trust semantics — node-local, never replicated — and
was explicitly left out of that ticket's scope. It is the same class of problem, so it is worth
closing, but it is not the same code path and its invite-sourced route needs a decision the
other two do not.
