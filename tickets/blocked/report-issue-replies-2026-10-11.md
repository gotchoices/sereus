description: Draft replies to every open GitHub issue on gotchoices/sereus as of 2026-10-11, plus corrected release notes for v1.14.0, for the maintainer to review and post. Notes say which issues can be closed.
files: tickets/fix/1-joiner-write-made-alone-lost-when-it-stops.md, tickets/blocked/optimystic-write-made-alone-owes-no-one.md, tickets/blocked/decide-sql-prompt-on-own-cadre-node.md, tickets/plan/12-provider-drone-reachable-by-phone.md, tickets/plan/13-provider-client-and-sign-up.md, tickets/fix/2-relay-only-strand-launch-waits-out-relay-drive.md, tickets/plan/1-rn-release-builds-dial-ws-nodes.md, tickets/fix/4-provider-version-hard-coded.md, tickets/blocked/report-issue-28-strand-reactivity-landed.md, tickets/blocked/decide-party-private-labels-and-app-state.md, tickets/blocked/decide-public-read-only-strand-access.md
----
# Human action: post replies on the open issues (triage of 2026-10-11)

**Blocked on:** the maintainer posting to a public tracker (and running `gh release edit` for #39). Agents do not post to GitHub. Delete this ticket once posted.

## Summary

| Issue | Board | Close? |
|---|---|---|
| #44 joiner's write made alone is lost | `fix/1-joiner-write-made-alone-lost-when-it-stops`; upstream `blocked/optimystic-write-made-alone-owes-no-one` | No; when the upstream fix is adopted and the `it.fails` arm flips |
| #43 SQL access to my own strands | `blocked/decide-sql-prompt-on-own-cadre-node` | No; a question, keep open until decided |
| #40 cadre-provider from a phone | `plan/12-provider-drone-reachable-by-phone`, `plan/13-provider-client-and-sign-up` (both extended) | No |
| #39 v1.14.0 release notes incomplete | corrected notes below, for `gh release edit v1.14.0` | Yes, once the release body is edited |
| #38 RN release builds can't dial `/ws` | `plan/1-rn-release-builds-dial-ws-nodes` | No; when it ships |
| #35 `cadre --version` prints 0.7.1 | fixed on master (`fix(cadre-cli): read cadre --version from package.json`), in `.release-notes.pending.md`; sibling `fix/4-provider-version-hard-coded` | Yes, now (fixed on master) or at the next release |
| #34 relay-only addStrand waits ~18 s | `fix/2-relay-only-strand-launch-waits-out-relay-drive` | No |
| #28 strand reactivity | `blocked/report-issue-28-strand-reactivity-landed` (versions filled in, ready) | Yes, after posting |
| #24 private invitation label | `blocked/decide-party-private-labels-and-app-state` (exists) | No; awaiting decision |
| #23 public read-only strand access | `blocked/decide-public-read-only-strand-access` (exists) | No; awaiting decision |
| #8 RN solo founding stall | resolved by `rn-solo-founding-stall-on-device` (v1.0.0) | Yes, after posting, unless a reporter still sees it |

## #44 — joiner's first commit over a slow relay is lost

> Thanks; the scenario reproduces the report exactly as described, and we're committing it as given, `it.fails` arm included.
>
> The commit-alone behaviour is in Optimystic: a node whose cohort for a block resolves to only itself commits at `quorum: 'local'` and records nobody as owed a copy, so nothing pushes it later, even after a restart. Optimystic has it as their top item (a solo commit should record the members it knows of as owed, so its drain delivers on reconnect and after restart). We'll adopt the release as soon as it's out, and your third arm turning red is the signal.
>
> On the Sereus side we're checking two things. First, why a restart didn't deliver on the phones: our own peer-join backfill pushes a strand's whole block store when a strand node connects to a member, so after both apps restarted the rows should have arrived by that path regardless. We'll add a restart arm and find out. Second, your cadre-core suggestion. A blanket "no strand peer connected, no write" rule would break offline writes on a machine that has synced before, which the strands design keeps on purpose. A narrower gate for the window right after a first sync (a joiner that has never committed with a member present waits for a strand peer) would cover your case without that cost; we'll measure it.
>
> The two "also seen" items: please do file the `appTablesReadable` one (parallel probe that remembers settled tables). The `cohort-unreachable` reads of never-written tables are on Optimystic's read path.

## #43 — SQL access to strands my cadre holds

> You haven't missed anything: there's no supported way to do this today. The only working route is code that hands the plugin a node it already has (the "injected node" option). Running the plugin standalone into a closed strand gives you a peer that isn't a member and has no membership key, and that will stop working once member admission is enforced, so don't rely on it.
>
> Of your three options we lean to (c): a `cadre sql <strandId>` command in cadre-cli, backed by a new route on the node's existing loopback admin channel (same token), read-only by default with an explicit flag to commit writes. It needs no new identity, the data is already on your machine, and Quoomb could use the same route later (your option b). Option (a) would make every Quoomb session a full cadre machine the owner has to admit and later remove, which is a lot of machinery for a query prompt.
>
> It isn't decided yet; we'll post here when it is. If you want to take a piece once it's settled, the admin route is a self-contained first step.

## #40 — cadre-provider can't be used from a phone yet

> Thanks for the +1; it does move it up. Both parts are on the board as you found: `plan/12` (WebSocket listener, optional `bootstrapNodes`) and `plan/13` (app sign-up and node creation). No date yet; `plan/12` is small and is the next step.
>
> On question 2: yes, we think the claim model fits the provider too. `POST /containers` would start the container waiting to be claimed and return its `sereus-join:` code, and the app claims it like any other node. That removes `pinnedOwnerKeys`, the peer lookup, `addDrone` and the seed `PUT`, so apps have one way to add a node whoever runs it, and the provider never handles owner keys or seeds. We've written that into `plan/13` as the recommended direction; the remaining question is how the claim secret is returned (once, to the authenticated customer, never logged).
>
> A PR for the WebSocket listener and optional `bootstrapNodes` would be welcome. cadre-host's `childListenAddrs` change is the right template; `plan/12` lists the provider-specific parts (the extra published Docker port and the provider's port allocator).

## #39 — v1.14.0 release notes omit the claim/invitation redesign

> You're right, and thanks for listing it out. The 1.14.0 notes were written for the Optimystic bump alone and the feature work never got entries. We've replaced the release body with a full summary, including the cadre-host removals as breaking changes, and the control schema change, which means parties made before 1.14 have to be recreated. Going forward, feature tickets add their own entry to `.release-notes.pending.md` when they land; the next release's file already does (`cadre init`, `cadre code`, the `--version` fix).

Closable once the release body is edited. Proposed body for `gh release edit v1.14.0 --notes-file <file>` (compiled from the tickets completed between v1.13.0 and v1.14.0 and the v1.14.0 control schema diff):

```markdown
# Sereus 1.14.0

**Breaking: the control schema changed. Parties created before 1.14 must be recreated.** Every signed control approval now binds the party id, `PendingJoin` became `JoinRequest` / `JoinSuccess` / `JoinFailure`, and removal records name the owner that signed them. Upgrade every machine of a party together.

## Nodes waiting to be claimed

- A node started with a one-time claim secret (`CADRE_CLAIM_SECRET`) belongs to nobody until an owner claims it. It admits strangers only for seed delivery until then.
- The phone claims it with `CadreNode.claimNode`, from the node's `sereus-join:` node code (peer id, addresses, secret) scanned as a QR code or pasted. The seed carries an HMAC proof of the secret; the secret never crosses the wire.
- The claim names the cadre, so the node no longer needs a party id in advance, and it comes back into the same cadre after any restart.
- Seed delivery tries each of the node's addresses in turn with its own time limit; "could not reach the node" is its own failure (`PeerUnreachableError`; a refusal is `ClaimRefusedError`).
- cadre-cli status reports whether the node has been claimed.

## Cadre invitations, redeemable at any member

- An owner-signed invitation admits a device, optionally as an owner, at **any** reachable member, while the owner is offline. A member that has not yet received the invitation row seats it from the bundle.
- cadre-cli: `cadre enroll invite [--peer-id <id>] [--owner] [--ttl <duration>] [--uses <n>]` on the owner's admin channel (`POST`/`GET /admin/invites`, `DELETE /admin/invites/:key`), and `cadre start --invitation <encoded>` on the new machine.
- Reference apps: **Paste cadre invitation** / **Join cadre**.
- **Removed:** the owner-online invite path (`createInvite`, `acceptPhone`, `encodeInvite`, `decodeInvite`, `dialInvite`, `openEnrollmentWindow` and the enrollment window, admin `POST /admin/accept-phone`). `addDrone`, `deliverSeed` and `applySeed` remain.
- A cadre machine now accepts a connection from an unrecognized device provisionally and hangs it up after a short while unless it becomes a member. Every protocol declares whether outsiders may use it, checked in one place.

## Owners

- Owners can add a second owner and remove an owner through the node's API. Each machine's trusted-owner list follows the cadre's `OwnerKey` table along signed chains, without a restart.
- A removed owner key stops authorizing changes as soon as its removal record arrives, on every machine.
- Every control approval is bound to its party: a signature from one cadre is not valid in another.

## cadre-host: rebuilt around "Join a cadre" (breaking)

- **Removed:** the host's own cadre (the founder role and owner node, its admin channel, the Strands page, the install-time "also run your own cadre" question, the host identity key), grants and node donation (the grant tokens and the phone-facing `/grants` API), and the trust circle (`/auth/*`, the `invite` and `trust` commands, the Trust Circle page).
- **Join a cadre by QR:** the host starts a node waiting to be claimed and shows its node code as a QR code and text; the web page follows it live from waiting to claimed to connected. Each node's page shows whose cadre it belongs to, with Remove and Reset.
- **Join by invitation:** paste a cadre invitation and the host starts a node that redeems it; it says clearly when no member is reachable and points to the QR flow.
- **Reachability:** router port mapping covers every node (TCP and WebSocket ports), hand-forwarded ports can be entered, each node advertises its public addresses (restarted at most once per 10 minutes when they change), and the CLI and web page show per node whether it is reachable from outside the home network.

## Reference app (React Native)

- Adds a home machine's node by scanning its QR code or pasting its text, replacing the host-address and grant-token screen.
- On Android, the system camera opens node codes straight into the app's approval prompt.

## Optimystic 1.12.0

Every `@optimystic/*` dependency now requires ^1.12.0.

- Strand change notifications no longer cost a phone seconds of proof of work: a strand node's first registration for a watched table signs a self-endorsement with its peer key (Optimystic #31).
- A slow writer is no longer starved by quick ones on the same strand table: after three losses the storing machines hold the next slot for it (Optimystic #18, `slotHoldWindowMs`, default 3 s).
- A dead connection no longer cuts a node off from a connected peer: opening a stream falls back across the peer's other connections and then a fresh dial (Optimystic #32).
```

**Process fix, for the maintainer to accept or edit:** add `tickets/rules/release-notes.md` reading "An implement ticket whose change is visible to a user of a published package (API, CLI, config, protocol, schema, behaviour) adds an entry to `.release-notes.pending.md` in the same commit. A schema change that forces recreating parties is listed first, as breaking." Not added by this triage, since it changes every runner agent's instructions.

## #38 — RN release builds can't dial `/ws` nodes

> Thanks, and agreed on all counts, including that `wss` isn't the fix: Noise already authenticates and encrypts every connection against the peer id. We're shipping your second option: a config plugin in `@serfab/cadre-rn` that sets `usesCleartextTraffic` on the main manifest, so an app adds one `"@serfab/cadre-rn"` entry to its Expo plugins. The reference app will use it, and `docs/reference-app-rn.md` gets a "Release builds" note saying why it's needed and safe. iOS stays as unverified in the docs until someone runs an iPhone release build against a public `/ws` address on cellular; if App Transport Security refuses it, the same plugin can add the exception.

## #35 — `cadre --version` prints 0.7.1

> Fixed on master: `cadre --version` now reads the package's own `package.json`, as you suggested, and the fix is in the pending notes for the next release. You were right to suspect the siblings: cadre-host already reads its `package.json`, but cadre-provider still prints a hard-coded `0.0.1`; that's queued as a separate fix.

Closable now (fixed on master) or at the next release.

## #34 — relay-only addStrand waits out the relay drive

> Thanks for the repro and the classification; the strand-node-as-relay correlation is a strong lead. We've queued it as a fix: reproduce with your script, find where the configured relay's `addRelay` is held, and stop the strand node's own relay discovery from taking the slots the supervisors are meant to fill (or count the first attempt done once the node holds as many reservations as it has configured relays). Noted that the device minutes are separate and this 18 s is a lower bound inside them.

## #28 — strand reactivity

Post the draft in `blocked/report-issue-28-strand-reactivity-landed`; its versions are now filled in (sereus 1.12.0, Optimystic 1.10.1) and its proof-of-work sentence updated for 1.14.0. Close #28 after posting. Delete that ticket once posted.

## #24 — party-private invitation label

> Not forgotten. This is waiting on one decision on our side, together with #6: we'd rather give apps a party-private place for their own data in the control database (which replicates only to your own machines, so Bob never sees it) than add a one-off label column, and the shape of that isn't settled. We know the timing matters to you because a control-schema change means recreating parties; 1.14 already required that once, so the next such change is best made together with this. We'll post here when it's decided.

Check against `blocked/decide-party-private-labels-and-app-state` before posting; edit if the maintainer has decided since.

## #23 — public read-only access to open strands

No new reply needed; the maintainer's last comment still describes the state. If one is wanted:

> Still open on our side, and tied to how an open strand protects itself from writes (`feat-open-strand-witness-policy`). One update: the per-strand address swap mentioned above has since been replaced by signed address records exchanged through FRET's neighbour snapshots, and the same point holds: an observer connected to one open-strand node can learn the others' addresses through it. `STRANGER_OPEN_PROTOCOLS` is gone; protocol access is now declared per protocol in one place (`controlProtocolClasses`).

## #8 — RN solo founding stall

> We believe this is resolved, and want to close it unless one of you still sees it. The hang on device was not the coordinated commit path itself: an older Babel helper (`@babel/runtime` / `@babel/helpers` before 7.29.2) cut async-generator cleanup short under Hermes, so Quereus's execution lock stayed held after the first early-exit read and founding waited forever. With the helper at 7.29.2 or newer, founding a chat strand on our solo test phone takes about 3 s. An app needs `@babel/runtime` `^7.29.2` (and must restart Metro with `--clear` after upgrading); the reference app has a test that fails if the broken helper comes back.
>
> @risavian, your 279–309 s converging creates predate several Optimystic changes; if a create on 1.14 with the helper upgraded still takes minutes on hardware, please open a new issue with the numbers and we'll look at it on its own.

Close #8 after posting unless a reporter answers that it still reproduces.
