description: Enrolling a trusted approver's key accepts any non-empty text, so a typo is saved without complaint and the invitations that depend on that key silently stop working, with nothing anywhere explaining why.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-cli/src/commands/validation-key.ts, schemas/control.qsql
difficulty: easy
----

# Key enrollment accepts malformed keys

## What happens today

A party says which outside approvers it trusts by enrolling their public keys. The same is
true of owner keys. In both cases the stored value is a base64url-encoded 32-byte ed25519
public key.

Nothing on either path checks that. The only validation is "not empty or whitespace"
(`requireNonBlank` in `packages/cadre-core/src/cadre-node.ts`). The database column is plain
text with no format constraint (`schemas/control.qsql`, `table ValidationKey` / `table
OwnerKey`), and the row's own signature is made by the *owner* over the key as data — so the
key's own well-formedness is never exercised at write time.

So this succeeds:

```
cadre validation-key add "nto-a-key"
cadre validation-key list          # nto-a-key
```

## Why it matters

An enrolled-but-malformed key is inert. Every later attempt to redeem an invitation that
needs that approver's sign-off is refused, because the signature can never verify against a
value that is not a key. Nothing reports the real cause at any point:

- The enroll command says `✓ Approver key enrolled`.
- `list` shows the garbage back, which looks like confirmation.
- The redemption fails much later, on a different machine, as a generic authorization
  refusal.

A single mistyped or truncated paste therefore costs a debugging session, and the evidence
that would solve it is a table listing that looks correct at a glance.

## Expected behavior

Enrolling a key that is not a base64url-encoded 32-byte ed25519 public key should be
refused, at the point of enrollment, with a message that says what was wrong with the value.
The same check should apply wherever a control key is enrolled — approver keys and owner keys
alike — since a garbage owner key has the identical failure shape.

Rejecting only at the command line is not enough: a programmatic caller (cadre-host, the
reference apps) needs the same guard.

## Notes for whoever picks this up

- There is currently no shared "is this a public key" helper in `cadre-core`;
  `packages/cadre-core/src/ed25519-key.ts` is the natural home, next to the existing
  length checks in `ed25519KeyPairFromLibp2p`.
- Decoding base64url and asserting 32 bytes is the whole check. Do not attempt point
  validation on the curve — a well-formed-but-not-on-curve key fails verification the same
  way any wrong key does, and that is not the failure mode this ticket is about.
- Worth deciding at the same time whether the schema should carry a length constraint. It
  would catch writers that bypass the node API, but a control-schema change is a larger
  blast radius than a library guard.
