description: The team decided to accept, rather than fix, the risk that closed-strand membership keys sit unencrypted on every one of a party's own nodes; the decision and its reasoning are now written down in the design docs.
files: docs/architecture.md, docs/strands.md
difficulty: hard
----

## Decision (human sign-off, 2026-07)

**Decision 1 = ACCEPT residual risk.** The at-rest exposure of closed-strand
`Strand.MemberPrivateKey` on mobile is *not* in scope to fix now. Decision 2
(which hardening option) is therefore moot and was not answered — no hardening
work is scheduled, and no `cadre-shared-key-distribution` prerequisite is filed.

Per the blocked ticket's "What each answer unblocks", accepting residual risk
makes this **documentation-only**. No code changed; no schema changed.

## What was done

Recorded the threat-model decision — the *why*, the accepted exposure, the
rejected alternatives, and the conditions that would reopen it — in the two docs
that a future reader will actually hit:

- [docs/architecture.md](../../docs/architecture.md) — new subsection **"Closed-strand
  member keys — accepted residual risk"** at the end of *Node Key Material & the
  KeyStore Seam* (the section that documents what the `KeyStore` enclave work
  *does* cover, so the reader learns there what it deliberately does not). Also
  added a one-line pointer from the *Strand Membership Bootstrap* paragraph that
  first names `Strand.MemberPrivateKey`, so the layer-1 description no longer
  reads as if the column were protected.
- [docs/strands.md](../../docs/strands.md) — new section **"Closed-Strand Member Key
  Handling"**, stating the same decision in strand terms: replication to every
  party node is what makes cadre nodes *fungible* for closed strands, formation
  puts the raw key on the wire, and the accepted risk is that a compromised device
  leaks the member key of every closed strand that party belongs to.

Both sections cross-link each other.

## Rationale captured (so it isn't re-litigated)

- Exposure is bounded by the same app-storage boundary (mobile LevelDB) that
  already holds the rest of the control DB's strand data — encrypting one column
  is partial hardening.
- The hard-to-rotate, single-point-of-compromise keys (libp2p peer identity +
  derived owner/authority) are already enclave-backed via the shipped `KeyStore`
  work. Member keys are per-strand, intentionally replicated, rotatable by
  re-forming.
- Every fungibility-preserving fix (envelope encryption under a per-cadre key)
  requires **cadre-wide secret distribution** — provisioning one key into every
  node's enclave, late joiners included — which does not exist and has no second
  consumer yet. Device-bound options (per-device enclave, node-subset, keyId-ref)
  were rejected: they break node fungibility.

## Revisit triggers (recorded in docs, not filed as tickets)

Reopen when a second consumer for cadre-wide secrets appears, or the deployment
threat model requires surviving app-storage compromise. The carried-forward open
questions are documented in `docs/strands.md`: late-joiner provisioning, envelope
key rotation across the replicated DB, fail-closed on a wiped enclave slot
(biometric invalidation / Android reinstall), mixed-platform cadres (Node
`FileKeyStore` + RN secure store), and migrating existing plaintext rows.

## Testing notes

None applicable — no code, schema, or build artifact changed. Verified by reading
the current sources named in the blocked ticket that the documented state matches
reality: `strand-member-key.ts`, `strand-formation-protocol.ts`,
`control-schema.ts`, `schemas/control.qsql`, `key-store.ts`.
