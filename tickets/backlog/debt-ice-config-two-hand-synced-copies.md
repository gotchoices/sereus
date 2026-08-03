----
description: The web app and the phone app each keep their own full copy of the code that talks to the relay-credential server, and the two copies are kept identical only by hand — including the security-sensitive details of how a request is signed.
files: packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-rn/src/ice-config.ts, packages/reference-app-web/test/ice-config.spec.ts, packages/reference-app-rn/test/ice-config.spec.ts, packages/cadre-core/src/identity-key.ts
difficulty: medium
----

## What is duplicated, and how much

`packages/reference-app-web/src/lib/ice-config.ts` (412 lines) and
`packages/reference-app-rn/src/ice-config.ts` (380 lines) are deliberate mirrors of
each other. Measured on 2026-08-03:

```bash
sed 's/^[ \t]*//' packages/reference-app-web/src/lib/ice-config.ts | sort > /tmp/w.txt
sed 's/^[ \t]*//' packages/reference-app-rn/src/ice-config.ts     | sort > /tmp/r.txt
comm -12 /tmp/w.txt /tmp/r.txt | grep -c .
# → 275
```

275 lines are identical once indentation is ignored — roughly three quarters of the
smaller file. Their two test files (606 and 622 lines) are near-identical too, and
are also synced by hand.

The three genuine platform differences are small and well understood: where the
manifest URL comes from (`VITE_ICE_CONFIG_URL` + `localStorage` on web,
`EXPO_PUBLIC_ICE_CONFIG_URL` on React Native), whether the DOM `RTCIceServer` type
is available, and the log prefix. Everything else — manifest validation, the fetch
deadline, the fallback policy, and the signing wire format — is common.

## Why it matters more than it used to

The copies used to hold only fetch-and-validate logic. As of
`ice-config-peer-assertion-client` they also hold the **wire format of a signed
request**: the domain-separation string `sereus.turn-issuer.v1`, the exact five-line
message that gets signed, the five `X-Sereus-Peer-*` header names, the nonce shape,
and the list of HTTP statuses that trigger an unauthenticated retry. All of that has
to agree byte for byte with the server in
`ops/docker/turn-credential-issuer/src/peer-assertion.ts`, or the client silently
fails to authenticate and quietly falls back — which looks like success.

Some drift is caught today: a pinned test vector (the same signature and message
bytes) is asserted in both app test files, in `packages/cadre-core/test/identity-key.spec.ts`,
and in the server's own self-test. But nothing catches a change made consistently to
*one* app and its own test file — the other copy simply stays behind, and no test in
the repo compares the two.

## What a fix should look like

The signer half already lives in one place: `peerKeySigner` in
`packages/cadre-core/src/identity-key.ts`, which both apps import. The natural move
is for the *assertion wire format* to join it there — building the signed message and
returning the five headers — leaving each `ice-config.ts` with only manifest fetching
and its own platform seams.

The constraint to respect: both `ice-config.ts` files are deliberately dependency-free
(the signing capability is injected as a plain structural interface) so neither drags a
crypto library into its bundle. Whatever shape is chosen has to keep that property, or
explicitly decide the property is no longer worth its cost — note that both apps already
depend on `@serfab/cadre-core` elsewhere, so the question is about bundle/tree-shaking
behaviour under Vite and Metro, not about a new dependency edge.

Out of scope here: the server copy in `ops/docker/turn-credential-issuer/` is a
standalone npm project outside the monorepo build and cannot share code with the
packages; its agreement with the clients stays enforced by the pinned vector.

## Priority

Low urgency, not zero. Nothing is broken today and the tests cover the highest-risk
drift. The cost is ongoing: every future change to manifest handling has to be made
twice, in two files and two test files, with no mechanical check that it was.
