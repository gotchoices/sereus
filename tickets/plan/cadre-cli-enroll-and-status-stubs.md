----
description: `cadre enroll register` and `cadre status` are stubs whose output implies real operations that never happen.
files: packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/status.ts, packages/cadre-cli/src/server/admin-server.ts
----
Two `@serfab/cadre-cli` commands present themselves to operators as performing real operations, but their implementations are stubs. Their command descriptions and success messages diverge from actual behavior, which can mislead an operator into believing a peer is registered or a node is stopped when neither is true.

## `cadre enroll register`

The `register` subcommand is described as "Register a peer with the control network (requires authority signature)" and takes `--peer-id`, `--bootstrap`, `--authority-key`, and `--signature` options (`packages/cadre-cli/src/commands/enroll.ts:50-106`). Despite this, the action never contacts the control network, never constructs an `AuthorityVerifier`, and never persists anything. It instantiates an `EnrollmentService` but only runs basic format checks (non-empty fields, `length >= 10` on the peer ID / authority key / signature, at least one bootstrap node) and then prints "✓ Registration data format is valid" followed by guidance that the authority must submit the registration "from an authorized node."

The problem is that the success message reads like a completed registration. An operator who supplies well-formed-but-invalid inputs (any string of length >= 10) sees a green checkmark and reasonably concludes the peer is enrolled, when in reality nothing was verified against an authority and nothing was registered with the control network.

Expected behavior: `enroll register` should either perform a real registration against the control network — verifying the authority signature via an `AuthorityVerifier` and persisting/submitting the registration — or, if registration must be authority-driven, it should clearly defer to that flow without emitting a success message that implies the local peer is now registered. The command description and all output messages must accurately reflect what the command actually did (validated format only vs. registered).

## `cadre status`

The `status` command is described as "Show control network and strand status" (`packages/cadre-cli/src/commands/status.ts`). Its action only resolves and loads the config file, then reports static config-derived fields (party ID, profile, bootstrap node count, strand filter, hibernation flag). The runtime fields are hardcoded: `running: false`, `peerId: null`, `strands: []` (`packages/cadre-cli/src/commands/status.ts:32-36,50`). It never attempts to connect to a running node.

This is operationally misleading: run against a live systemd- or Docker-managed cadre node, `cadre status` still prints "running: false" and an empty strand list, contradicting the node's actual state. The CLI already has the means to query live state — the admin channel exposes `GET /admin/identity` and `GET /admin/multiaddrs` (`packages/cadre-cli/src/server/admin-server.ts`), and the health server exposes `/status`. The status command does not use any of them.

Expected behavior: `cadre status` should query the live node via the admin channel and/or health endpoint and report actual runtime state (running, peer ID, listening multiaddrs, active strands), falling back gracefully to a clearly-labeled "node not running / unreachable" result when no node responds — rather than always asserting `running: false`. The static config summary may remain, but it must be distinguished from live runtime status.

## Scope

The unifying requirement across both commands: descriptions and emitted messages must match behavior. A command that only validates input format must not claim success that implies a completed network operation, and a status command must reflect the live node's actual state when one is reachable. Relevant code: `packages/cadre-cli/src/commands/enroll.ts`, `packages/cadre-cli/src/commands/status.ts`, and the live-data sources in `packages/cadre-cli/src/server/admin-server.ts`.
