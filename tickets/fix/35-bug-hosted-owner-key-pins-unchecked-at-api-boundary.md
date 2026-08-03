description: When someone asks a hosting service to run a node for them and mistypes one of the trusted keys they supply, the request is accepted as successful and the node then silently fails to start, instead of the mistake being reported back right away.
files: packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/__tests__/create-container-owner-keys.test.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-core/src/ed25519-key.ts
repro: static
----

# Owner-key pins are only shape-checked after the node has already been spawned

## Background

A node that is about to join someone else's party has to be told, up front, whose
signed "join instructions" (a *seed*) it should trust. That list is supplied as
**pinned owner keys** — base64url-encoded Ed25519 public keys — and reaches the node
as the `CADRE_OWNER_KEYS` environment variable.

Two services take that list from a caller over the network and hand it to a node they
spawn on the caller's behalf:

- **`cadre-provider`** — `POST /containers` accepts `pinnedOwnerKeys` in the request
  body (`routes.ts`'s `validatePinnedOwnerKeys`) and passes it into the container's
  environment.
- **`cadre-host`** — a donation request (`DonationProvisionRequest.ownerKeys`) carries
  the requester's owner keys, which `DonationService.provision` forwards to the
  orchestrator, which sets `CADRE_OWNER_KEYS` on the spawned child process.

Neither checks the key *contents*. Until recently that was harmless-ish: a typo'd key
simply never matched a real signer, so the node started and quietly refused every seed.

## What changed, and why it is now a defect

`cadre-cli start` now rejects a malformed pinned owner key outright
(`validatePinnedOwnerKeys` in `packages/cadre-cli/src/commands/start.ts`, backed by
`requireEd25519PublicKeyB64`). That is the right behavior for an operator typing a key
at a terminal — the failure names the bad value immediately.

For the two hosted paths above it moves the failure to the wrong place:

- The provider's `POST /containers` returns `201 Created`. The container is then
  provisioned and the node inside it dies at boot. The caller learns about their typo,
  if at all, from container status — never from a `400` naming the bad key.
- A donation provision spawns a child that exits at startup; the donation is marked
  failed with the child's error rather than the request being refused up front.

## Expected behavior

A caller that supplies a badly-shaped owner key should be told so **by the call that
supplied it**, before anything is provisioned:

- `POST /containers` → `400 INVALID_REQUEST` naming which key is malformed, alongside
  the existing "must be an array of strings" check.
- Donation provision → the existing request-validation failure mode (a `DonationError`
  refusing the provision), before a grant slot or a workdir is consumed.

Both should apply the same shape rule as the node itself — base64url, decodes to 32
bytes — so a request the boundary accepts is one the node can start with. Curve
membership stays out of scope in both places, exactly as at the node.

## Wrinkle the implementer will hit

`@serfab/cadre-provider` does **not** depend on `@serfab/cadre-core` today (`cadre-host`
does). The provider's current docstring calls that decoupling deliberate: "the provider
does not need to know the ed25519 encoding to accept a request." So this is a real
choice to make, not a mechanical edit:

- add the workspace dependency and reuse `requireEd25519PublicKeyB64`, or
- keep the packages decoupled and re-state the (small, stable) shape rule locally,
  accepting the duplication.

Prefer whichever keeps the two definitions from drifting; say which was chosen and why.

## Notes

- The error text `requireEd25519PublicKeyB64` produces already caps how much of a
  rejected value it echoes, so quoting a caller-supplied key back in a `400` will not
  let a caller flood the log.
- `create-container-owner-keys.test.ts` and `container-owner-keys.test.ts` currently use
  placeholder strings like `'key-1'` as pins; they will need real 32-byte base64url
  values once the boundary validates.
