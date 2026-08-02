description: cadre-provider has the same bug cadre-host just fixed — if the provider process dies right after reserving a container slot but before the container actually starts, that slot stays reserved forever and nothing ever frees it.
files: packages/cadre-provider/src/service/container-service.ts
---

# cadre-provider: stuck-provisioning-equivalent record never reaped

Sibling of the bug fixed in cadre-host by `bug-stuck-provisioning-donation-holds-quota`
(see `packages/cadre-host/src/donation/donation-service.ts`'s
`reapStaleProvisioning` / `DONATION_PROVISIONING_TTL_MS` for the pattern that
was applied there, and `docs/cadre-host.md` § Respawn for the writeup).

`ContainerService.provisionContainer` in
`packages/cadre-provider/src/service/container-service.ts` writes a
provisioning-equivalent record (a container reserved against a tenant's quota)
*before* calling the orchestrator to actually start the container. If the
provider process crashes or is killed in the window between that write and
the orchestrator call finishing, the record is left in that in-between state
permanently — there is no reap sweep anywhere in cadre-provider that revisits
records stuck this way, unlike cadre-host's `reapStaleAwaitingSeed` /
`reapStaleProvisioning`. The tenant's quota slot is never freed, and (per the
same crash-window shape cadre-host had) if the orchestrator actually managed
to spawn the container before the crash, that container is leaked too — orphaned,
holding resources, with no record correctly naming it.

cadre-provider also has no `resolveDockerId`-equivalent (a way to look up a
live container's docker/orchestrator handle by the provider-side container id
it was asked to create) — cadre-host's fix added
`DonationOrchestrator.resolveDockerId` for exactly this, so a reap sweep can
find and reclaim a child that was actually spawned before the crash, not just
mark the record failed. cadre-provider's orchestrator interface would need the
equivalent before a reap sweep here could reclaim leaked containers rather
than just freeing the quota slot and abandoning the container.

This is dormant, not yet observed causing a real quota lockout in this
repo — filed as forward-looking debt because the code shape is the same
crash window cadre-host had, not because it has been reproduced in
cadre-provider specifically.
