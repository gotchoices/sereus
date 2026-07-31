description: Add the small, self-contained signing helpers for "the joining peer signs its own network join": a new signature purpose tag, the byte-builder the joiner signs, and the checker that re-verifies a stored signature. Purely additive — nothing calls them yet, so the build and every existing test stay green.
files: packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/index.ts
difficulty: easy
----

# Formation consent — additive signing helpers

First half of the split of `debt-formation-consent-core` (see that ticket for the full
design; it is `prereq:` on this one). This ticket lands ONLY the additive pieces so the
suite stays green with zero behavioral change. All shapes below were verified against
source by the prior run — the code is ready to paste, only surrounding doc-comments need
writing in the file's own voice.

## Edits

**`packages/cadre-core/src/control-authorization.ts`** — line 88:

```ts
export type ControlAction = 'add' | 'remove' | 'vouch' | 'publish';
```

becomes `'add' | 'remove' | 'vouch' | 'publish' | 'consent'`. Extend the doc comment
above it (lines 74–87) with a bullet: `'consent'` — a peer self-signs its OWN
`FormationUsage` redemption (the joiner proving it agreed to join), with its own key;
distinct from the approver's `'vouch'` over the same table so the two stored signatures
are never interchangeable.

**`packages/cadre-core/src/control-database.ts`** — insert directly after
`formationVouchMessage` (ends line 187), with a doc comment mirroring its neighbor's
style ("the exact bytes the JOINING peer signs to consent to ONE redemption; TS mirror
of the `'consent'` digest in `FormationUsage.PeerConsented`" — that constraint arrives
in the wiring ticket, forward-reference is fine):

```ts
export function formationConsentMessage(fields: {
  token: string;
  usageStampId: string;
  peerKey: string;
  disclosure: string;
}): Uint8Array {
  return buildAuthorizationMessage('CadreControl.FormationUsage', 'consent', [
    fields.token, fields.usageStampId, fields.peerKey, fields.disclosure,
  ]);
}
```

**`packages/cadre-core/src/peer-authorization.ts`** — append, following the exact
pattern of `cadrePeerVoucherDigest` (line 112) + `verifyCadrePeerVoucher` (line 201) —
exported digest fn, then a never-throws verifier using the module's private
`taggedDigest` and its existing `log`:

```ts
export function formationConsentDigest(
  token: string, usageStampId: string, peerKey: string, disclosure: string
): string {
  return taggedDigest('CadreControl.FormationUsage', 'consent', [token, usageStampId, peerKey, disclosure]);
}

export function verifyFormationConsent(row: {
  token: string; usageStampId: string; peerKey: string; disclosure: string; peerSig: string;
}): boolean {
  try {
    return verify(
      formationConsentDigest(row.token, row.usageStampId, row.peerKey, row.disclosure),
      row.peerSig, row.peerKey, 'ed25519', 'base64url', 'base64url', 'base64url'
    );
  } catch (error) {
    log('verifyFormationConsent failed: %o', error);
    return false;
  }
}
```

Doc comments: consent is verified against the joiner's OWN key carried on the row —
unlike `verifyCadrePeerVoucher` there is no enrolled/owner row to look up, the identity
IS the key; a forged joiner would need that joiner's private key. Never-throws contract
same as the siblings.

**`packages/cadre-core/src/index.ts`** —
line 11 (control-database export list): add `formationConsentMessage`.
Line ~208 (`peer-authorization.js` export block): add `formationConsentDigest`,
`verifyFormationConsent`.

## Validation

- `yarn build` and `yarn lint` from repo root (stream with `tee`).
- cadre-core unit suite — must be untouched-green (nothing calls the new code).
- Optional cheap positive test (fits in `packages/cadre-core/test/` beside
  `peer-authorization` coverage if a spec exists; skip if none does): sign
  `formationConsentMessage(f)` with a throwaway seed
  (`ed25519PublicKeyFromPrivate` for the pub half), assert `verifyFormationConsent`
  true, and false under a different key. The wiring ticket's schema tests cover this
  end-to-end regardless.

Handoff: fold the review note into the wiring ticket's handoff — this half is
deliberately inert on its own.
