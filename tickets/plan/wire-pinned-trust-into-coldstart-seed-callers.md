----
description: Wire the pinned-key seed trust policy into cold-start seed-apply call sites (CLI --seed/CADRE_SEED, health POST /seed, host/reference-app enrollment) so cold-start enrollment works under the new secure-default trust anchor
prereq: seed-trust-policy-and-authority-identity
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/server/health.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/types.ts
----

## Problem

`seed-trust-policy-and-authority-identity` changed the secure default: `applySeed` now rejects any seed whose signer is not anchored either in the receiver's `CadreControl.AuthorityKey` table (DB-anchored) or via an explicit per-call/per-service trust-policy override (`pinnedKeyTrustPolicy` / `tofuTrustPolicy`). The capability is in place and `CadreInvite` now carries `authorityKeys?: string[]`, but the **cold-start seed-apply call sites still call `applySeed(seed)` with no override**, so a genuinely cold node (empty `AuthorityKey` table) will now reject every seed:

- `packages/cadre-cli/src/commands/start.ts:~257` — `--seed` / `CADRE_SEED` startup apply.
- `packages/cadre-cli/src/server/health.ts:~309` — `POST /seed` network endpoint (see also companion ticket `seed-network-path-authn`, which authenticates this surface).
- `packages/reference-app-rn/src/use-cadre.ts:~129` and `packages/reference-app-rn/src/cadre-phone.ts:~130` — phone applies a pasted/scanned seed.
- `packages/cadre-host` trust-circle enrollment (issues invites via `createInvite`; the invitee side needs to consume `invite.authorityKeys`).

This is the intended security posture, not a regression — but until the callers supply an anchor, out-of-band onboarding via raw seed is non-functional for cold nodes.

## Design questions to resolve

- **Operator pinning surface.** How does an operator pin authority keys for the CLI cold-start path? Options: a `--pin-authority-key <b64url>` (repeatable) flag, a `CADRE_AUTHORITY_KEYS` env (comma-separated), or pinning derived from the same encoded payload as the seed. Pick one and keep it cross-platform.
- **Invite-driven pinning.** The phone/drone enrollment flow should pin from `invite.authorityKeys`: decode the invite, build `pinnedKeyTrustPolicy(invite.authorityKeys ?? [])`, and pass it to `applySeed`. Decide where the invite is held at apply-time (use-cadre state, host enrollment session).
- **TOFU for interactive hosts.** cadre-host has a trust-circle UI; decide whether to wire `tofuTrustPolicy` to a confirmation prompt here (the design anticipates this) or defer.

## Out of scope

- Persisting accepted cold-start keys / applying `seed.transactions[]` — covered by backlog `seed-accepted-authority-persistence`.

## Use cases / expected behavior

- A cold node started with `--seed` **plus** a pinned authority key (operator config) applies the seed successfully; without the pin it rejects with a trust-policy reason.
- A phone that scanned an invite carrying `authorityKeys` applies the subsequent seed successfully without extra operator input.
- An interactive host operator can confirm an unknown signer once (if TOFU is wired), after which the seed applies.
