priority: 1
description: Implement Ring Zulu participation and storage ring opt-in (blocked on Arachnode)
prereq: Arachnode storage system (not yet built), packages/cadre-core profile configuration
----
Blocked on the Arachnode storage ring system not being built yet.

The profile distinction between `transaction` and `storage` currently has no real effect beyond FRET hints. Once Arachnode is available:

- **Ring Zulu (Transaction)**: all nodes participate in transaction verification and ephemeral caching
- **Storage rings** (Ring 3 → 2 → 1 → 0): storage-profile nodes join the appropriate concentric ring based on capacity
- Profile configuration in CadreNode should map to actual ring participation

## Blocked on
- Arachnode storage ring system design and implementation