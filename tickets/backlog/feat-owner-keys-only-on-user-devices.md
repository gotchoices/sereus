description: Owner signing should happen only on devices a person holds (phones, hardware keys such as a YubiKey), never on a server. cadre-host is being changed to follow this; cadre-cli's `--owner` founding, and the fact that an owner key is the node's own network identity key, still contradict it.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/enroll-add.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, docs/architecture.md
----

# Owner keys only on user-held devices

## Principle (from the project owner)

Keeping owner signing entirely on phones or hardware keys is the more secure design. A server that holds an owner key can act as the user without the user being present, so no server process should hold one: not cadre-host (handled by `cadre-host-remove-founder-role`), not a provider container, not a headless cadre-cli node.

## Where the code still contradicts it

- **cadre-cli `--owner`** (`start.ts`, `enroll.ts`, `enroll-add.ts`) founds a cadre on a headless machine by bridging the node's libp2p identity into an owner key (`ownerKeyFromLibp2p`). Integration tests and scenarios use it as a convenient founder. Decide whether it stays as a test or developer tool, clearly labelled, or is removed in favour of a phone-shaped founder in tests.
- **The owner key is the node identity key.** On a phone, the owner key is the node's libp2p key. A hardware key cannot work that way: it signs only on request (often with a touch), while a libp2p identity key signs every connection handshake. Supporting a YubiKey therefore needs the owner key separated from the node identity, with the device's node vouched for by an owner signature that the hardware key produces. The `KeyStore` seam (docs/architecture.md → "Node Key Material & the KeyStore Seam") is the starting point.
- **Pending joins finished by always-on machines** (`blocked/decide-non-owner-machine-completes-a-pending-join`): option A there is pre-approval signed by the owner device, not a server holding a key. That is compatible with this principle and should be judged on its own terms.

## When picked up

- Write the principle into docs/architecture.md as a constraint.
- Decide the cadre-cli `--owner` question.
- Design owner keys separate from node identity, for hardware keys.
