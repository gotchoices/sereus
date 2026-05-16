priority: 1
description: Implement storage quota enforcement for storage-profile nodes (blocked on Arachnode)
prereq: Arachnode storage system (not yet built), packages/cadre-core, packages/cadre-provider billing
----
Blocked on the Arachnode storage ring system not being built yet.

Storage-profile nodes should enforce capacity limits from `CadreNodeConfig.storage.quotaBytes`. Without quotas:
- A storage node could fill its disk
- Provider billing can't tie to actual storage used

Once Arachnode is available, quota enforcement should:
- Track storage usage per strand and total
- Reject new block storage when quota is exceeded
- Report usage to the provider for billing metering

## Blocked on
- Arachnode storage ring system design and implementation
