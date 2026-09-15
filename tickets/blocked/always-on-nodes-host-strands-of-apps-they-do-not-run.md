description: Should an always-on machine store an app's shared data for its owner when that app is not installed on the machine? The docs say a home server or rented node holds the group's shared data, but in the code a machine only joins a shared workspace if the app itself registered there, so those machines store none of it. A human needs to choose how this should work before it can be built.
files: packages/cadre-core/src/cadre-node.ts (handleStrandAdded ~3788, addStrand ~4242, sAppConfigs ~389, refreshAuthorizedControlPeers comment on serving machines), packages/cadre-cli/src/commands/start.ts, docs/architecture.md (Strand Filtering; Deployment Configurations), docs/reference-app-rn.md (Two-Node Startup Sequence, Step 5), ../optimystic/packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts
----
# Do always-on nodes host strands of apps they do not run?

## Why this is blocked

This is a design decision with product and trust consequences, and the current documentation and code disagree about it. Nothing should be built until someone chooses.

**Unblock when** a maintainer answers the questions at the bottom. Then file a `plan/` ticket for the chosen option, and correct whichever documents the answer contradicts.

## Terms

- **Strand**: a shared data network for one app (a chat, for example), with its own SQL database replicated across the machines that take part.
- **sApp config**: the app's schema plus its id, version and signature (`SAppConfig`). A machine needs it to open the strand's database.
- **Always-on node**: a server-class cadre node run by `cadre-cli`: a drone, a node cadre-host lends to someone (`docs/cadre-host.md` → Node donation), the host's own owner node, or a cadre-provider container. All of them are cadre-cli processes.

## What the documents promise

- `docs/architecture.md` → Deployment Configurations, "Standard (Phone + Cloud Node)": the cloud node provides "storage capacity for strand data".
- `docs/architecture.md` → Strand Filtering: `all` means "participate in all strands in the control network (default for servers)", so "the user's server nodes handle the full portfolio".
- `docs/reference-app-rn.md` → Two-Node Startup Sequence, Step 5: "The drone (with `strandFilter: all`) automatically detects the new strand and joins".

## What the code does (read, not run)

- `CadreNode.handleStrandAdded` (`cadre-node.ts` ~3788) launches a strand only when `sAppConfigs` holds a config for that strand id. Otherwise it logs `No sAppConfig registered for strand …` and emits `strand:discovered` for the embedding app to decide.
- `sAppConfigs` is filled only by `addStrand` (~4242), which an embedding app calls with its own config.
- cadre-cli registers no sApp configs and does not listen for `strand:discovered` (no match for `schema`, `addStrand` or `strand:discovered` in `packages/cadre-cli/src`).
- So no always-on node ever hosts an app strand, whatever its strand filter says. Step 5 of the reference-app walkthrough does not happen.
- The strand repair-yardstick work already depends on today's behaviour: the comment in `refreshAuthorizedControlPeers` says a strand "launches only on machines whose embedder registered its sApp config", and `backlog/feat-strand-yardstick-from-serving-machines` builds on that. Any option below changes which machines serve a strand.

What would confirm it: start a cadre-cli drone and a phone-shaped `CadreNode` in one party, have the phone publish an open chat strand, and look for the `No sAppConfig registered` line in the drone's debug log with no strand instance on the drone.

## Why it surfaced now

`phone-adds-cadre-host-node-to-its-cadre` expected a strand created on a phone to appear on the node cadre-host lends it, and messages to replicate between them. The split implement tickets (`donated-node-reachable-by-phone`, `owner-keeps-dialing-node-it-added`, `donation-scenario-phone-shaped-requester`, `rn-request-node-from-cadre-host`) deliver the control network only, and leave strands to this decision.

## Options

**A. Storage replica without the schema.** An always-on node joins the strand's network and stores and serves its blocks without opening the app's SQL database.

- For: the host never runs anything of the app's, not even its schema; this fits the architecture's block-storage rings (`docs/architecture.md` → Node Profiles).
- Against: a new "storage-only" strand-instance mode in cadre-core. Such a node cannot validate transactions: Optimystic's validator re-executes the transaction's SQL against the local schema and compares a schema hash (`quereus-validator.ts`). No deployment turns that validator on today (its own comment: nothing supplies `NodeOptions.validator`), so this costs nothing now and limits what the node can do once validation is enabled. Closed-strand admission and the repair yardstick would need an answer for a member that holds no app.

**B. The owner publishes each strand's sApp config into the control database.** Every node whose strand filter admits the strand reads the config from there and opens the strand as a full participant.

- For: one mechanism for every machine; nodes can validate transactions; matches "server nodes handle the full portfolio".
- Against: config trust. `requireSignedSchemas` is on by default and the reference app's chat schema is unsigned (`phone-node-config.ts` sets `requireSignedSchemas: false` for the demo), so either the demo signs its schema or always-on nodes relax the check. A lent node would run a borrower's SQL schema on the donor's machine (SQL only, no app code), which the donor has not agreed to. Schema version changes also need to travel.

**C. Configure apps per machine.** cadre-cli's config lists sApp configs, and cadre-host passes a requester's configs when it provisions a lent node.

- For: smallest change, and explicit.
- Against: every always-on node must be reconfigured for every new app, and a phone cannot add an app to a lent node without another request to the host. It does not deliver what the docs promise.

**D. No.** Always-on nodes carry the control network only; strands live only on devices that run the app.

- For: no work beyond correcting the docs.
- Against: a one-phone cadre with a home server still loses its app data with the phone, which defeats the "add a backup" story.

## Questions for the maintainer

1. Should an always-on node hold data for apps it does not run? (No → D; correct the three documents above.)
2. If yes: must such a node validate app transactions (→ B, or C as a stopgap), or only store and serve blocks (→ A)?
3. If B: is a donor expected to run a borrower's SQL schema, and must that schema be signed?

Without an answer, the default leaning is **A**. It needs no new trust from donors, it is the only option that keeps a lent node from executing anything supplied by the borrower, and the capability it gives up (pend-time validation) is not enabled in any deployment today. It is not chosen here because it adds a cadre-core strand mode and changes the repair-yardstick assumptions noted above.
