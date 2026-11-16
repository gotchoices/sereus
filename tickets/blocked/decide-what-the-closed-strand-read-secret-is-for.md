description: Every members-only shared database carries a shared secret key that is created, stored on every device and handed to each new member, but no code uses it to protect anything; the maintainer needs to decide whether it should start protecting reads, be removed, or be kept on purpose as an unused reserve.
architecture: docs/strands/keys.md#closed-strand-member-key-handling
files: schemas/control.qsql (`Strand.MemberPrivateKey`, `JoinedStrand.MemberPrivateKey`, the `Strand.Type` comment), schemas/strand.qsql (the `Header.Type` comment), packages/cadre-core/src/strand-instance-manager.ts (`buildStrandRuntime`), packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-membership-writer.ts (`assertNotPreSplitStrand`), packages/cadre-core/src/control-formation-recorder.ts (`resolveStrand`), packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/cadre-node.ts (`rememberFormedStrand`, `foundStrand`), packages/cadre-core/src/types.ts (`FoundStrandConfig.memberPrivateKey`, `FormStrandResult.memberPrivateKey`), docs/strands/keys.md, docs/concepts.md, tickets/backlog/feat-strand-member-allowlist-admission.md
----

# Decide: what is a closed strand's read secret for?

**Blocked category:** the specification contradicts the code. The schemas and a dozen code comments say a closed strand restricts who can read it and call this key the thing that does so; no code does. **Unblocks with:** a maintainer choosing A, B or C below (C is recommended). A and B become `plan/` tickets; C becomes one small `implement/` ticket.

## What exists

A closed strand has a key called the **read secret**: an Ed25519 private key the founding app supplies (`FoundStrandConfig.memberPrivateKey`, from `generateStrandMemberKey()`), stored unencrypted in `Strand.MemberPrivateKey` in the founding party's control database and in `JoinedStrand.MemberPrivateKey` in each joining party's, and so replicated to every machine of every member party. Formation sends it to each validated joiner in the result message.

It is separate from each party's own **membership key** (`StrandPartyKey`), which signs that party's rows in the strand and never leaves the party. Nothing below concerns the membership key.

## What the code does with it

Checked by reading every use of `MemberPrivateKey` and `memberPrivateKey` in `packages/cadre-core/src` and `packages/quereus-plugin-sereus/src`:

- **It is covered by the owner's signature** on the `Strand` and `JoinedStrand` rows, and compared as row content when a strand is re-published or moved between cadres.
- **It is delivered** in the formation result (`ControlFormationUsageRecorder.resolveStrand` → `StrandFormationManager` → `FormStrandResult.memberPrivateKey`).
- **Its presence tells a joiner the strand is closed.** The formation result has no type field; `CadreNode.rememberFormedStrand` and the documented `addStrand` call both write `Type: result.memberPrivateKey ? 'c' : 'o'`.
- **Its public half is a fingerprint.** A `Member` or `Manager` row keyed by it marks a strand founded by an old release that derived the founder's identity from this key; such a strand is refused (`assertNotPreSplitStrand`, `PreSplitStrandIdentityError`).

And what it is not used for:

- **It never reaches the strand's network node.** `StrandInstanceManager.buildStrandRuntime` passes `createLibp2pNode` no secret. The key goes only into the `StrandDatabase` configuration, for the fingerprint check.
- **It never reaches the SQL plugin or storage.** `packages/quereus-plugin-sereus/src` does not reference it. Blocks are stored and transferred as they are.
- **No peer is asked to prove it holds the key,** at connection, at a stream, or at a read.

So today a closed strand restricts reads in one way only: each machine refuses the recorded machines of a removed member (the deny list in `strand-revocation-enforcer.ts`). A peer with no record at all is served. Any peer that learns the strand id and reaches a machine serving the strand can read it, with or without the read secret. The rewritten documents say this (`docs/strands/keys.md` → "Limits and accepted tradeoffs", `docs/concepts.md` → "Strands", `docs/strands/membership.md` → "Limits and accepted tradeoffs").

The code's own comments say the opposite. `schemas/control.qsql` on `Strand.Type` and `schemas/strand.qsql` on `Header.Type` both say only a closed strand gates or prevents reads, and the key is called the "read-gating secret" in `cadre-node.ts`, `control-database.ts`, `control-formation-recorder.ts`, `strand-database.ts`, `strand-formation-manager.ts`, `strand-formation-protocol.ts`, `strand-instance-manager.ts`, `strand-solicitation.ts` and `types.ts`. `tickets/backlog/feat-strand-member-allowlist-admission.md` reasons from "the removed machine still holds the strand's read secret" as though reading required it.

## Options

**A. Make it protect reads.** Use the key (or one derived from it) so that only holders can read: either as a pre-shared key that the strand's network node requires of every connection, or as an encryption key for block contents.

- It would keep out a peer that knows only the strand id, which nothing does today.
- It would not keep out a removed member. Every member party holds the same key, and `docs/strands/keys.md` records that it "is never replaced in a running strand". Real protection after a removal needs the key replaced and redistributed to the remaining parties, a mechanism of the size of the existing party-key replacement, across parties instead of within one.
- A connection-level key has to work on all three platforms' transports (Node.js, the browser, React Native); that was not investigated. Content encryption changes the storage and sync path in Optimystic, outside this repository.

**B. Remove it.** Drop both columns, the `memberPrivateKey` parameter of founding and the field of the formation result; carry the strand's type explicitly; a closed strand is one whose header says so.

- Removes a private key that is replicated in clear and sent between parties for no effect, and removes the misleading name.
- The fingerprint check for strands founded before the key split goes with it, or needs another marker. There is no compatibility promise yet, so this is permitted.
- If read protection is wanted later, a new secret has to be distributed to every member party of every existing closed strand, which removal makes harder than it is today.

**C. Keep it, declared as reserved (recommended).** Change no behaviour. State in the schemas and the code what the documents now state: the key restricts nothing and is held for a future read-protection design. Correct the comments listed above. Add an explicit strand type to the formation result so that the key's presence stops being the signal a joiner depends on.

Why C: it costs one small change, it leaves A open (every member party already holds the key, so a later design can use or derive from it without a new distribution step), and it stops the code from claiming a protection it does not give. A done honestly is a design of its own that this ticket should not smuggle in. B is cleaner but is the one option that is expensive to undo.

Proposed text for the two schema comments under C: "`'o'` open | `'c'` closed. A closed strand records its members and refuses the recorded machines of removed members. Neither type encrypts data or restricts reads to members." And for the key: "A shared key every member party holds. Reserved: nothing encrypts with it or authenticates a peer by it."

## A question this decision should not hide

Whichever option is chosen, a closed strand is readable by a non-member that learns its id and reaches a serving machine. If closed strands are meant to be confidential against such a peer, the mechanism already described on the board is `feat-strand-member-allowlist-admission` (admit only machines bound to a current member), which needs no shared secret. If that ticket is the intended answer, C or B is sufficient here and A is unnecessary. If confidentiality must also hold for data at rest on, or passing through, machines that are not members, only A's content encryption gives it.

## If nothing is decided

Behaviour stays as documented. The schema and code comments keep contradicting the documents, the key keeps being stored and sent, and the next reader of the code is likely to assume, as the allowlist ticket's evidence section did, that reading a closed strand requires it.

## Reversibility

- C is fully reversible: comments and one added field.
- A is reversible in code but not in expectation: once apps tell users a closed strand is encrypted or gated, withdrawing it is a product change. Its key-replacement mechanism adds control-schema rows that are costly to remove.
- B changes two control tables, the founding API and the formation message. Restoring the key later is possible for new strands and needs a distribution mechanism for existing ones.
