---
description: There are two ways to add a machine to a cadre and they dial in opposite directions, but no document puts them side by side — so a reader who follows the wrong one wires the connection backwards and gets a node that never joins.
files: docs/architecture.md, docs/cadre-host.md, docs/reference-app-rn.md, docs/strands.md
---

# Two "add a node" flows, opposite dial directions, never compared

Both flows end in `addDrone`, so they look interchangeable. They are not — who dials whom
is reversed, and that decides which side has to be reachable:

| flow | who dials | who must be reachable |
| --- | --- | --- |
| reference-app / cadre-core ([`docs/reference-app-rn.md`](../../docs/reference-app-rn.md)) | the phone dials the drone | the drone |
| cadre-host donation ([`docs/cadre-host.md`](../../docs/cadre-host.md)) | the donated node dials the phone's `bootstrapNodes` | the phone |

Each document is correct on its own. Neither says the other exists, and
[`docs/strands.md`](../../docs/strands.md) leaves "Strand Creation" and "Inviting Parties"
as TODOs that defer to `architecture.md`, which does not resolve it either.

The failure this produces is quiet: pick the wrong direction and nothing errors at
configuration time — the node simply never joins, and the symptom (empty `CadrePeer`
table, cold-start retries that never connect) looks like a NAT or trust problem rather
than a wiring one. A phone behind NAT can never be the dial target, which is exactly the
constraint the table above makes visible and prose does not.

## The work

One short section — most likely in `architecture.md` near the cold-start material, with
both flow documents linking to it — carrying the table above plus a "when to use which"
line. Fill in the two TODOs in `strands.md` or point them at the new section.

Worth checking while writing it: whether a third direction exists for the provider-hosted
Docker path, and whether the relay case changes the reachability column (it does for
`/p2p-circuit` addresses — see the sibling ticket
`debt-docs-relay-support-reads-more-complete-than-it-is`).

## Provenance

Raised in an outside documentation review of the published `v0.11.0` tree (2026-08-19),
item 7.
