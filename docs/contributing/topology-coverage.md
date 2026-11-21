# Topology coverage map

Which network shapes and lifecycle situations the integration suite in `packages/integration-tests/src/scenarios` exercises, and which it does not. Read it before writing a scenario, or before relying on a behaviour in a shape that may never have been run. How to run and write scenarios is in [Testing](testing.md).

Every scenario file has exactly one row. A change that adds, renames or removes a scenario file updates its row in the same change: `yarn check:docs`, which is part of `yarn lint`, fails when a scenario file is not named in this document, or when the document names a scenario file that does not exist ([Gates → Documentation](gates.md#documentation)). A row gives the shape and the limits of the file's coverage; what the file asserts is in its header comment.

## Reading the tables

- Scenario paths are relative to `packages/integration-tests/src/scenarios`. Harness fixtures are in `packages/integration-tests/src/harness`.
- Unless its row says otherwise, a scenario runs every node in one process, on loopback addresses, with no injected link delay.
- The "Not covered" column lists what the file leaves out about its own shape. A dash means the file names no limit other than running in one process on loopback.
- A new multi-machine scenario sizes its hook timeouts from the `TIME BUDGET` note at the top of `harness/topology.ts`.

Terms used in the rows:

- **Phone-shaped node**: no listen address, WebSocket and circuit-relay transports only, the `device` node class (`buildPhoneOwner` in `harness/node-fixtures.ts`).
- **Always-on member**: a `server`-class node that listens on a loopback address.
- **Relay-only node**: a node with no listen address, reachable only through its reservation on a relay.
- **Dedicated relay**: `harness/dedicated-relay.ts`, a bare libp2p relay with no membership gate and no cadre protocols. It stands in for the relay container in `ops/docker/libp2p-infra`.
- **Hand-dial**: the test dials one node at another itself, where the product would find the address through discovery.
- **Bound invitation**: a formation invitation that names a strand the inviter has already founded.
- **Relay-only pair**: two parties, each one relay-only machine, on a closed strand formed over one dedicated relay from a bound invitation.
- **2×2**: two parties of two machines each.

## Harness and smoke tests

| Shape or situation | Scenario | Not covered |
|---|---|---|
| One party, an owner plus drones; libp2p connections only | `basic-connectivity.integration.ts` | Whether a connected machine is in the control cohort |
| Two parties, each an owner plus drones; strand, invitation and redemption rows in the inviting party's control database | `happy-path.integration.ts` | Strand transport between the parties; the cluster size of any write |
| Separate parties, each an owner plus drones; control plane only | `multi-party-sync.integration.ts` | A strand joined or synced across parties |
| One party; strand and invitation records made through the `TestCadreNetwork` harness | `strand-creation.integration.ts` | A running strand instance; strand data |
| The topology builder (`harness/topology.ts`): 1×1, a three-machine party beside a one-machine party, 2×2 with a strand on three of the four machines, a star control mesh | `harness-topology.integration.ts` | Replication behaviour; the subject is the builder |
| The control-cohort probe and forcing helpers, on two small parties | `control-cohort-harness-helpers.integration.ts` | Any control write |
| Three-machine party (an owner plus two drones); a control write offered to the whole cohort | `harness-party-control-cohort.integration.ts` | A slow or silent cohort member |

## One party: control database replication

| Shape or situation | Scenario | Not covered |
|---|---|---|
| Two machines connected before the write, in both write orderings | `control-db-two-node-convergence.integration.ts` | Forming the cohort: the test hand-dials |
| One machine writes while alone; a sibling connects afterwards | `control-write-while-alone-convergence.integration.ts` | Forming the cohort: the test hand-dials |
| A removal committed alone after a restart with the sibling down; the sibling returns | `control-delete-while-alone-convergence.integration.ts` | A removal re-issued without a restart in between (cadre-core unit spec) |
| Two machines stop; the one that joined restarts alone and reads control tables | `control-offline-read-after-restart.integration.ts` | — |
| Two always-on members restart together, cut off from the phone-shaped owner; a machine is added afterwards | `control-members-restarted-together.integration.ts` | — |
| Three-machine cohort, forced, with one member slow or silent | `control-write-degraded-cohort-member.integration.ts` | The degraded member as the write's coordinator |
| Two machines that declare different party sizes | `control-divergent-repair-yardstick.integration.ts` | — |
| Two machines insert the same primary key in the same tick | `control-concurrent-same-pk-insert.integration.ts` | — |
| Two machines insert different primary keys with one unique-column value in the same tick | `control-concurrent-unique-column-race.integration.ts` | — |
| One machine inserts a unique-column value its sibling has already committed | `control-cross-machine-unique-column.integration.ts` | The same-tick race (`control-concurrent-unique-column-race.integration.ts`) |

## One party: forming the control cohort

| Shape or situation | Scenario | Not covered |
|---|---|---|
| Two machines; the second cold-starts from a seed, no hand-dial | `control-cohort-auto-convergence.integration.ts` | The reconcile pass as the only connector (`control-cohort-three-node-isolation.integration.ts`) |
| The joiner's first dial is refused; the joiner listens on nothing | `control-cohort-cold-start-retry.integration.ts` | — |
| Three machines; one that listens on nothing dials a sibling it learned from a replicated row | `control-cohort-three-node-isolation.integration.ts` | Whether data crosses that connection; a relay |
| The same three machines; the non-listening one, cut off from the owner, reads a sibling's new row | `control-cohort-edge-carries-data.integration.ts` | A write over that connection |
| A joining node on slow storage with `controlNetwork.bootstrapNodes` set | `control-bring-up-quiet-period.integration.ts` | — |

## Adding and removing machines and owner keys

| Shape or situation | Scenario | Not covered |
|---|---|---|
| An owner authorizes a drone; the seed is encoded, decoded and validated | `seed-bootstrap.integration.ts` | — |
| An owner adds drones by seed and by an invitation redeemed at the owner; a tampered seed; an expired invitation | `enrollment-e2e.integration.ts` | The seed delivery protocol: seeds are applied directly |
| Two separate libp2p networks in one process, over TCP; the seed delivery stream | `deliver-seed-cross-network.integration.ts` | — |
| Phone-shaped owner offline; a new device redeems an owner grant at the only always-on member; a withdrawn invitation is refused | `cadre-invite-any-member.integration.ts` | — |
| An invitation minted while the owner is cut off from the always-on member, redeemed at that member with the owner offline | `cadre-invite-row-unreplicated.integration.ts` | The owner returning afterwards |
| An app's node joins a cadre by targeted invitation while the owner and the always-on member are both down; a second device joins by owner grant | `app-joins-cadre-by-invitation.integration.ts` | — |
| A lost phone: a fresh device joins with a backup owner grant at the only always-on member, then removes the lost phone | `owner-grant-backup-recovery.integration.ts` | — |
| An owner grant seats a key with no machine admitted; a second holder is refused | `owner-grant-without-machine.integration.ts` | The provisional deadline on the holder's connection |
| An owner, an always-on member and a second owner machine; an owner key is added, removed and added again | `owner-anchor-follows-owner-changes.integration.ts` | — |
| An owner removes another owner's machine, then that owner's key; an always-on member follows by replication | `machine-removal.integration.ts` | A strand shared with another party ([Closed-strand membership and removal](#closed-strand-membership-and-removal)) |
| A stranger, a member and an invited device connect to an established node and to a node nobody owns yet | `membership-connection-gater.integration.ts` | Replicated membership rows: every row is written locally |
| An outsider holding an admitted connection opens members-only protocols on the owner | `control-stream-authz.integration.ts` | — |

## Hosted nodes and providers

The claim, invitation and provider scenarios start real `cadre-cli` child processes; the other cadre-host scenarios run the host's services with no cadre node.

| Shape or situation | Scenario | Not covered |
|---|---|---|
| A phone-shaped owner claims a `cadre-cli` node started waiting to be claimed; a wrong secret; a rival owner; a restart | `node-claim-by-phone.integration.ts` | Addresses beyond loopback; a claimant behind a relay; strand data reaching the node |
| cadre-host starts a child waiting to be claimed and a phone-shaped owner claims it; the child is killed and respawned | `cadre-host-join-by-qr.integration.ts` | Reachability beyond the LAN; a claimant behind a relay; strand data reaching the node |
| cadre-host starts a child that redeems an invitation at an in-process owner; the owner offline, then a retry; an expired invitation | `cadre-host-join-by-invitation.integration.ts` | — |
| The provider's HTTP API with child processes in place of containers; a phone-shaped owner claims one | `provider-container-claimed-by-phone.integration.ts` | Docker; strands; a requester behind a relay |
| A provider node redeems an invitation at a `cadre-cli` owner node; a spent invitation | `provider-container-joins-by-invitation.integration.ts` | Docker; strands; the owner offline when the node starts |
| cadre-host install, then start; no cadre node | `cadre-host-bootstrap.integration.ts` | — |
| The cadre-host orchestrator with an idle stand-in child; the `/api/nodes` routes | `cadre-host-orchestrator-lifecycle.integration.ts` | A real `cadre-cli` child |
| The cadre-host loopback listener: Host and Origin header checks | `cadre-host-origin-guard.integration.ts` | — |
| The cadre-host `/api/events` stream | `cadre-host-sse-events.integration.ts` | The connectivity event published at start (cadre-host unit test) |
| A cadre-host update check against a signed manifest served on loopback | `cadre-host-update-notify.integration.ts` | The timed check that runs after start (cadre-host unit test) |

## One party, several machines, one strand

| Shape or situation | Scenario | Not covered |
|---|---|---|
| An always-on member and a `device`-class node that only dials; one chat strand | `websocket-chat.integration.ts` | — |
| Two machines; bursts and interleaved writes from both; a disconnect and reconnect | `convergence-stress.integration.ts` | Writes issued from both machines at the same instant |
| Two machines; the second learns the strand's address from its sibling over the control network, no hand-dial | `strand-addr-seed-convergence.integration.ts` | Data replication over the resulting connection |
| A machine enrolled after the strand has rows, with writes continuing during its enrollment | `strand-late-cadre-join.integration.ts` | A write forced into the gap between catch-up and replication (ticket `debt-late-join-catch-up-seam-is-never-forced`) |
| An always-on storage replica without the app; the phone is lost and a replacement phone joins | `strand-always-on-replica-survives-phone-loss.integration.ts` | A closed strand |
| Three machines on a strand with cluster size 2, so each block is on two of them; change notifications | `strand-reactivity-wakes-watchers.integration.ts` | — |
| Two always-on members and a `device` whose `strandCohortMember` role is off; the chat schema; the client writes and reads through the two serving machines, which hold every block, and is in nobody's cluster | `strand-client-node-holds-no-blocks.integration.ts` | The client's strand node is hand-dialed to the servers; a closed strand; a client with no serving machine reachable (ticket `client-strand-waits-for-a-serving-machine`) |
| Two machines; the strand is removed party-wide and the sibling stops its instance | `strand-unpublish-sibling-convergence.integration.ts` | Closed strands; a removal committed while alone; the remover running the strand itself |

## Strands across parties: forming and joining

| Shape or situation | Scenario | Not covered |
|---|---|---|
| Two and three parties, one machine each; the formation protocol, the approval hook, a cancelled redemption | `strand-formation-e2e.integration.ts` | Finding the other party's strand node: hand-dialed |
| Two parties, one machine each, and a third that is refused; closed and open strands; interleaved writes | `multi-party-workflows.integration.ts` | Finding the other party's strand node: hand-dialed |
| Two parties, one machine each; signed writes checked by the app schema | `rbac-signed-write.integration.ts` | The `Strand` membership tables |
| Two parties, one machine each; bound invitation; the joiner finds the strand from the formation result, no hand-dial | `strand-formation-cross-party-seed.integration.ts` | A restart; a relay; a relay reservation that changes while the two are disconnected |
| An inviting party of two machines; two joiner parties redeem one invitation in the same tick, one at each machine | `strand-formation-concurrent-redemption.integration.ts` | — |
| Two parties on a closed strand with the reference chat schema; the joiner writes as soon as it attaches; a joiner whose host is unreachable | `strand-chat-participants-converge.integration.ts` | — |
| A joiner asks to join while the host is offline; both restart | `pending-join-survives-restart.integration.ts` | The join finished by one machine of the joiner's party and the strand opened on another (ticket `debt-pending-join-finished-on-another-owner-machine-unscenarioed`) |
| 2×2 on one strand; one machine off during a write, then back | `strand-two-party-two-machine.integration.ts` | Which cluster the write committed on with the machine off (ticket `debt-strand-write-breadth-observed-end-to-end`) |
| The joining party is a phone plus an always-on machine without the app; the always-on machine hosts the joined strand, then drops it | `strand-always-on-replica-hosts-cross-party-join.integration.ts` | That replica serving a replacement phone |
| One machine moves its strands from the one-machine party it founded to another party of the same owner; the other member is told nothing | `strand-moves-between-cadres.integration.ts` | A relay-only link |

## Closed-strand membership and removal

| Shape or situation | Scenario | Not covered |
|---|---|---|
| Two parties, one machine each; the membership writers, sealing, reads with the founder stopped | `strand-membership-closed-strand-e2e.integration.ts` | Formation: the strand row is built by hand and the strand nodes are hand-dialed |
| 2×2; membership actions issued from a party's second machine | `strand-membership-second-machine.integration.ts` | Which machines hold the blocks: database reads only |
| 2×2, a party removed and both its machines disconnected; a removed node learns of its removal; an open strand between the same nodes | `strand-removal-cuts-network.integration.ts` | Relayed connections; device rows the runtime wrote (the test registers them) |
| 2×2 joined by formation, every membership row written by the runtime; removal; a rejoin attempt after removal | `strand-party-removal-via-formation-e2e.integration.ts` | Relayed connections; discovery beyond the pair formation seeds (the rest is hand-dialed) |
| A three-machine party and a one-machine party on a closed strand the first founded; a machine is removed with the always-on replica online, and with it offline | `machine-removal-rotates-party-key.integration.ts` | Relayed connections; a machine that returns after a key replacement it missed |
| The same removal in a strand the other party manages; a fresh invitation seats the new key | `party-key-rotation-across-parties.integration.ts` | Relayed connections; the replica offline during the removal |

## Relay and reachability

Injected delay and the frame-rate cap (`harness/ws-latency.ts`) apply to every node in the process, so both parties are equally slow.

| Shape or situation | Scenario | Not covered |
|---|---|---|
| One party; a control node with no reachable address reserves on a sibling's relay, with and without its membership row at the sibling | `relay-only-control-addr.integration.ts` | Strand connections |
| One party, both machines relay-only on a dedicated relay; strand data both ways; the relay restarts | `strand-circuit-same-party-e2e.integration.ts` | Link delay; a relay run by one of the party's own machines |
| The relay-only pair on a shared relay, at loopback speed and with 10 ms delay; then one relay per party | `blind-relay-phone-to-phone-e2e.integration.ts` | Loss of a reservation; delay on the relay-per-party arm |
| The relay-only pair; both restart over the storage each kept | `strand-relay-only-restart-reconverges.integration.ts` | Link delay. Separate processes over on-disk stores run only in an opt-in arm |
| The relay-only pair; the joiner's first transaction at loopback speed, at 100 ms delay and on a frame-rate-capped link with a busy event loop; a commit made alone, delivered after a restart | `joiner-first-commit-over-slow-relay.integration.ts` | A passing first commit on the capped link: that arm is marked `it.fails` |
| The relay-only pair at 100 ms delay; reads of every table, then with the joiner stopped | `strand-read-cost-over-relay.integration.ts` | The capped link, which runs only in an opt-in arm |
| The relay-only pair; alternating read and write rounds at loopback speed | `strand-workload-on-a-phone-link.integration.ts` | The capped link, which runs only in an opt-in arm marked `it.fails` |
| The relay-only pair, both also listening on `/webrtc`; formation, strand bring-up and a write with ICE that can never connect, then the same with ICE that can, where the strand connections must upgrade to WebRTC | `webrtc-ice-failure-falls-back-to-relay.integration.ts` | Link delay; a capped relay; a failed upgrade's backoff |

## Offline mode and hibernation

| Shape or situation | Scenario | Not covered |
|---|---|---|
| Two relay-only parties in separate processes; one, in offline mode, queues a write while its partner is down and restarts before the partner returns | `strand-offline-queue-survives-restart.integration.ts` | The queuing party alone long enough for FRET to drop its partner |
| One party: a phone-shaped owner in offline mode and an always-on node whose strand port is blocked while control stays connected; the node is later removed | `strand-offline-waits-for-party-machine.integration.ts` | A relay; which of the phone's dialers reconnects the strand |
| A hibernating member woken over the control network: by direct dial, through a sibling's relay, by a sender whose owner is not trusted, and by a sender known only from replicated rows | `push-wake-e2e.integration.ts` | Platform push delivery (FCM, APNs) |

## Schema versions

| Shape or situation | Scenario | Not covered |
|---|---|---|
| Two machines of one party on different control schema releases; each restarts onto the newer release in turn | `control-schema-migration-mixed-releases.integration.ts` | An older release opening a store a newer release migrated (cadre-core unit spec) |
| Two relay-only parties in separate processes; one applies a new app schema while the other is offline, with and without offline mode | `strand-app-schema-change-while-partner-offline.integration.ts` | — |

## Opt-in measurements

These files are skipped unless their environment switch is set. The switches, and what each file measures, are in [Gates → Opt-in measurements](gates.md#opt-in-measurements). That section also lists the opt-in arms of scenarios that run by default, whose rows are under [Relay and reachability](#relay-and-reachability).

| Shape measured | Scenario |
|---|---|
| The relay-only pair forming a strand and idling; a phone-shaped owner admitting an always-on member, by seed and by invitation | `message-cost-accounting.integration.ts` |
| The relay-only pair with one party's link to the relay counted, and optionally delayed, by a proxy | `relay-round-trip-measure.integration.ts` |
| Bare libp2p nodes, no cadre, dialing each other through a relay at chosen delays | `relayed-dial-cost-by-latency.integration.ts` |
| The relay-only pair; the joiner's first attach and its re-attach on a delayed link | `strand-reattach-first-sync-measure.integration.ts` |

## Not covered

Shapes and situations with no scenario.

- **A medium private network.** Several parties with several machines each on one closed strand. The largest strand any scenario runs has four machines (ticket `feat-scenario-medium-private-network`).
- **A public open strand.** An open strand joined by three or more unrelated parties that all write (ticket `feat-scenario-public-open-strand-network`).
- **One slow party and one fast party.** No default-run scenario delays one party's link alone; only the opt-in `relay-round-trip-measure.integration.ts` does, and it measures without asserting (ticket `debt-relay-scenarios-never-see-link-latency`).
- **Removing a party that is reached through a relay.** Every removal scenario connects the parties directly. A scenario for this needs the relay-only pair, not an option on the 2×2 removal scenarios.
- **A machine that returns after a key replacement it missed.** `machine-removal-rotates-party-key.integration.ts` brings the offline replica back before the replacement finishes.
- **Cancelling a closed-strand invitation.** No scenario calls `cancelInvite`, so no second machine is shown refusing a redemption of a cancelled invitation.
- **A manager seated by `admitManager`.** The only scenario call is one that a sealed strand must refuse.
- **A manager removing another party's manager, and a member leaving a strand.** `removeManager` and `leaveStrand` run in scenarios only inside a party's key replacement, where the party retires its own old key.
- **Two machines writing a closed strand's membership tables at the same moment.** Every scenario issues its membership writes one at a time. The race in `strand-formation-concurrent-redemption.integration.ts` is on the inviting party's control database.
- **Joining through a sibling of the inviter.** The inviting phone is off and a stranger redeems the invitation at the party's always-on machine (ticket `debt-join-through-a-sibling-machine-unscenarioed`).
- **A restart of a relay run by one of the party's own machines** while a strand node holds a reservation on it. The relay restart that is covered uses the dedicated relay (ticket `debt-strand-relay-redrive-on-party-run-relay-unscenarioed`).
- **A strand with more machines than its cluster size, counting the copies of each block** (ticket `debt-replication-proof-above-cohort-size`).
- **Strand data on a hosted node.** No scenario replicates a strand onto a node claimed through cadre-host or rented from a provider.
- **A claimant behind a relay.** Every claim scenario has the phone dial the node directly.
- **The provider's Docker image.** The provider scenarios start child processes, so the image's `entrypoint.sh` never runs (ticket `debt-docker-entrypoint-untested`).
