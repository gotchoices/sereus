description: An invitation says which app the shared database is for, the inviter's records say it again, and the shared database itself says it a third time, but nothing compares the three with each other or with the app that actually opens the database, so an invitation labelled for one app can lead a different app to open it and apply its own table definitions.
architecture: docs/strands/app-schema.md
files: packages/cadre-core/src/cadre-node.ts (`createOpenInvitation`, `publishFormationInvite`, `foundStrand`, `requestJoin`, `addStrand`, `recordReplicaSAppId`), packages/cadre-core/src/strand-membership-writer.ts (`readStrandHeaderSAppId`, the `Strand.Header` insert), packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/control-formation-recorder.ts (`provisionAndRecord`), packages/quereus-plugin-sereus/src/app-schema.ts (`applyAppSchema`), schemas/control.qsql (`FormationInvite.sAppId`), schemas/strand.qsql (`Header`)
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: A member of a strand can already apply any app schema with a higher version number, so a check on the app id stops mistakes and mislabelled invitations rather than a determined member, and the fix has to say what a storage replica and a legitimately renamed or re-signed app should do.
----

# Nothing checks which app a joined strand belongs to

## The three records and the app that opens the strand

An app is identified by its sApp id, the public key of the schema's author (`SAppConfig.id`; `assertSchemaSignature` checks a config's signature against its own id before a strand starts). For one invitation to one strand that id is written in three places:

1. **The invitation envelope**, `OpenInvitation.sAppId`: whatever string the caller passed to `CadreNode.createOpenInvitation`. Not signed.
2. **The inviter's control row**, `FormationInvite.sAppId`: whatever string the caller passed to `publishFormationInvite`. Covered by the owner's signature on the row.
3. **The strand's own header**, `Strand.Header.sAppId`, with `sAppSchema` and `sAppSignature`: written once by the founder from the sApp config it founded with.

A fourth value is the sApp config the joining app passes to `addStrand` after `formStrand` returns.

No code compares any two of these. Read from the source:

- `publishFormationInvite(token, sAppId, { strandId })` writes its `sAppId` argument as given. It does not compare it with the envelope's or with the bound strand's header. Only `foundStrand`'s `formationInvite` option fills it from the founding config.
- The responder reads `FormationInvite.sAppId` only on the unbound path, where `ControlFormationUsageRecorder.provisionAndRecord` accepts it and does not use it (its comment: "accepted for parity/future use").
- The joiner uses the envelope's `sAppId` as a label: the owner approval prompt of `requestJoin` reads "Ask to join a strand of the app …" from it, and `PendingJoinStatus.sAppId` reports it to the app. Integration scenarios pass strings that are no sApp id here (`membership-connection-gater.integration.ts` passes `'gater-formation-sapp'`), and nothing objects.
- A joiner's launch never reads the header's app fields. The only reader of `Strand.Header.sAppId` is `readStrandHeaderSAppId`, called for a storage replica that has no sApp config (`CadreNode.recordReplicaSAppId`, for the `sAppId` strand filter). `sAppSchema` and `sAppSignature` are written by the founder and read by nothing in `packages/cadre-core/src` or `packages/quereus-plugin-sereus/src`.
- The plugin's `applyAppSchema` gates the joiner's schema on its version number alone (`gateAppSchemaVersion` against `Strand.AppSchemaVersion`), then runs `apply schema App`. The plugin's own `sAppId` connection option is read nowhere (`debt-accepted-settings-nothing-reads`), so it is not a fifth check.

## What follows

A joining app that holds a different sApp than the one the strand was founded with is not refused at any step. It syncs the strand, and if its `schemaVersion` is not below the recorded one it applies its own schema as `App`. That apply is a declarative diff. What it then does to the founding app's tables on a live strand was not run for this ticket; `docs/strands/app-schema.md` says of the same statement on the `Strand` schema that it "drops a table its declaration lacks".

Ways to get there without malice: an inviter's code passes the wrong id or a placeholder string to `createOpenInvitation` and the receiving app routes the invitation by that label; or an app that hosts two sApps passes the wrong config to `addStrand`.

The owner approval prompts are the other consequence. `publishFormationInvite` asks the owner to approve "Publish an invitation to the app X" and `requestJoin` asks "Ask to join a strand of the app X", where X is in both cases a caller-supplied string that nothing ties to the strand.

## Expected behaviour

- A member that opens a strand with an sApp config is refused, before it applies anything, when the strand's header names a different sApp id. The header arrives with the first sync, which a joiner already waits for.
- `publishFormationInvite` for a bound strand does not accept an sApp id that differs from the strand's, where this node can know the strand's (it runs the strand, or founded it with a config).
- Either the envelope's `sAppId` is checked against the row's during formation, or it is documented as an unverified hint and kept out of approval prompts.

Whether the joiner should also verify the header's `sAppSignature` against its `sAppId` (today no joiner does) belongs to the same design pass, as does the storage replica, which has no config to compare.

## Evidence and confirmation

Static. To confirm at run time: found an open strand with sApp A, publish a bound invitation, and have a second party `formStrand` and then `addStrand` with a validly signed sApp B (a different author key, a `schemaVersion` at or above A's). Expected today: `addStrand` resolves and B's tables appear in the strand; record what happens to A's.
