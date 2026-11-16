description: The secret code inside an invitation to share a database is produced by a random-number source that is not meant for secrets, and it is printed into diagnostic logs, so someone other than the invited person could obtain it and join in their place.
architecture: docs/strands/formation.md#formation-invitations
files: packages/cadre-core/src/strand-solicitation.ts (`createOpenInvitation`, `formStrand`, `registerMintedInvitation`, `recordFormationComplete`), packages/cadre-core/src/strand-id.ts (`mintStrandId`, the generator to reuse), packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts (`insertFormationInvite`, `redeemInvitation`, `recordFormationUsage`, `MissingHostStrandError`, `FormationAbortedError`, `InvitationExhaustedError`), packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/cadre-node.ts (`publishFormationInvite`), packages/integration-tests/src/harness/test-network.ts, eslint.config.mjs
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Guessing a token blind over the network is out of reach at its present size, so the exposure needs an attacker who has seen other tokens from the same process or can read debug output, and a maintainer may judge the documented advice (send invitations over a trusted channel, limit uses and lifetime) enough for now.
----

# The formation invitation token is predictable and is written to logs

## What the token protects

A formation invitation (`OpenInvitation`) carries a `token`. The inviting party's owner publishes a `CadreControl.FormationInvite` row keyed by that token, and any machine of the party then redeems it for whoever presents it. The token is the only credential in the exchange, as `docs/strands/formation.md` → "Limits and accepted tradeoffs" already says:

- The joiner signs its consent with a key pair it generates for that one formation (`StrandSolicitationService.formStrand`). The schema's `FormationUsage.PeerConsented` check verifies the signature against the key the joiner itself presents, so the signature proves nothing about who the joiner is.
- The responder (`StrandFormationManager.provisionAsResponder`) then checks only that the token has a live row, plus two optional gates an inviter may or may not configure: a `DisclosureValidator` supplied by the app, and an outside approval when the row carries a `ValidationUrl`. With neither, the token alone admits.

What a holder of a live token receives, read from `provisionAsResponder` and `ControlFormationUsageRecorder`:

- For an invitation bound to a closed strand: the strand id, the strand's shared read secret, the responder's live strand-network addresses, the inviter's party id and control addresses, and a single-use strand membership invitation with which the holder seats a member row under a key of its own. The holder becomes a member of the closed strand.
- For an invitation bound to an open strand: the strand id and addresses.
- For an unbound invitation: a new open strand row written into the inviter's control database for each redemption.
- In every case one recorded use. On an invitation published with `totalUses: 1` the invited person's later attempt is refused as `token-spent`.

The code treats the token as a secret elsewhere: the `JoinRequest` table keys its rows by a hash of the token "so the token never reaches Revocation" (`schemas/control.qsql`), `CadreNode.pendingJoinInvitation` avoids naming the invitation in an error because it "is a bearer credential", and the `FormationUsage` comment in the schema calls the token "a random secret".

## Arm 1: how it is minted

`StrandSolicitationService.createOpenInvitation` builds the token as `invite-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`.

- **The clock part is not secret.** It is the mint time in milliseconds, printed in the token. To someone who does not hold the token it is unknown only as far as the mint time is unknown, about 22 bits for an hour of uncertainty.
- **The random part is at most nine base-36 digits,** 36^9 values, about 46.5 bits.
- **Its source is `Math.random`,** which is not a cryptographic generator. The language specification leaves the algorithm to the engine; V8 uses xorshift128+, whose internal state published techniques recover from a few consecutive outputs. Every token a process mints exposes about 46 bits of one output.

What follows from that, with what was and was not checked:

- **Blind guessing over the network is not practical.** Every guess is a formation session answered `token-unknown`; covering half of 36^9 values within a 24-hour invitation would need several hundred million guesses a second, against a responder that runs at most 100 sessions at once (`DEFAULT_MAX_CONCURRENT_SESSIONS` in `strand-formation-protocol.ts`). This is arithmetic, not a measurement.
- **Prediction is the exposure, and it is inferred, not demonstrated.** A party that has received several invitations from one process (an app that mints one invitation per invitee does this) holds several truncated outputs of that process's generator and may be able to compute the tokens the same process mints for other people. The clock part of those later tokens it must still guess, at one online attempt per candidate millisecond. Nobody has tried state recovery from these truncated outputs; doing that against tokens minted by Node.js and by Hermes is what would confirm this arm.

`packages/cadre-core/src/strand-id.ts` already states the rule this breaks: `mintStrandId` uses `randomBytes` from `@optimystic/quereus-plugin-crypto` (128 bits, available on Node.js, the browser and React Native) because the strand id "is what an invite redemption hands back", and the comment on `mintPlaceholderStrandId` says `Math.random` must never be used where unpredictability matters. The integration harness mints its tokens with a copy of the same expression (`packages/integration-tests/src/harness/test-network.ts`).

## Arm 2: where it is logged

With the `debug` namespaces `sereus:cadre:*` enabled, the token is written in full on both sides of a formation, before and after it is spent:

- Inviter, while the token is still live: `createOpenInvitation` and `registerMintedInvitation` (`strand-solicitation.ts`), `ControlDatabase.insertFormationInvite` (twice), `CadreNode.publishFormationInvite`.
- Joiner, before it redeems: `StrandSolicitationService.formStrand` and `StrandFormationManager.formStrand`.
- Responder, per session: the contact line in `strand-formation-protocol.ts`, `StrandFormationManager.validateToken` and its rejection lines in `provisionAsResponder` and `issueBoundMembershipInvite`, `ControlFormationUsageRecorder` (`authorize`, `provisionAndRecord`), `ControlDatabase.redeemInvitation` and `recordFormationUsage`, and the approval line in `formation-approval.ts`.

The token is also interpolated into thrown messages: `MissingHostStrandError`, `FormationAbortedError`, `InvitationExhaustedError`, the `malformed` `FormationApprovalError` in `ControlFormationUsageRecorder.obtainApproval`, the provisioning error in `StrandFormationManager.requireRead`, and the action text `CadreNode.publishFormationInvite` passes to `requireOwnerSigner`. A thrown message travels further than a debug line: into an app's error reporting and onto screens.

A multi-use or not-yet-redeemed token read from any of these is as good as the invitation. Debug output is off by default, so this arm needs a log that was turned on and then shared: a bug report, a support bundle, a console another person can see.

## Expected behaviour

- A token is minted from the platform's cryptographic random source with at least 128 bits, and carries no clock value.
- No log line or error message contains a whole token. A short non-reversible tag (the first characters of its hash, as `pendingJoinId` already derives one) is enough to correlate lines.

## Direction

Minting through the same `randomBytes` call as `mintStrandId` settles arm 1. To retire the class instead of the instance, restrict `Math.random` in package `src` in `eslint.config.mjs`, with the two timing uses that are legitimate (retry jitter in `control-retry.ts`, the injectable `random` in `pending-join-runner.ts`) exempted by name; `mintPlaceholderStrandId` is the third use; it mints the placeholder ids that `debt-form-strand-nodeless-placeholder` describes, which name no strand and need no secrecy. For arm 2, a token type whose string conversion yields the tag, not the secret, would stop a new log line from reintroducing the leak; whether that is worth it over fixing the listed sites is the implementer's call.

A related fact for whoever plans this: the token is stored in clear as the primary key of `FormationInvite`, which replicates to every machine of the inviting party, including hosted machines that hold no owner key. Cadre invitations avoid that by being a key pair whose private half never enters the database (the `CadreInvite` table comment). Changing formation invitations the same way is a protocol change and is not asked for here.
