description: Sereus's policy is that a control-schema change means recreating the party and upgrading every machine together, but phones receive app-store updates one at a time, so a phone app cannot follow it. Decide what a mixed-version party does (GitHub #46, point 4).
files: docs/architecture.md (~53, the recreate policy), packages/cadre-core/src/control-database.ts (`loadSchema`)
----

# Decide: control-schema upgrades when machines update separately

**Blocked on:** a maintainer decision.

kjeib (gotchoices/sereus#46): "An app store update reaches each phone separately, so a phone app cannot follow 'upgrade every machine of a party together'." Their Voter and Authority apps hit both the 1.13→1.14 and 1.14→1.15 breaks on devices.

Options to choose between:

- **Keep the policy, make it survivable.** A machine that finds its store incompatible recreates it and rejoins (the typed error and the recreate procedure in `fix/control-store-from-an-older-release-fails-with-an-untyped-error` are the prerequisites). Closed-strand secrets and `StrandPartyKey` private keys in the deleted store are lost unless re-delivered by another member.
- **Additive-only control-schema changes** from some release on (new tables and nullable columns only, with optimystic support for `add column`), so an older store keeps working and an older machine ignores what it does not know.
- **Versioned migrations** in `loadSchema`, which the NOTE there already names as the site.

Also decide whether two machines on different schema versions may share a party at all, and what the newer one does when it meets an older peer's rows.
