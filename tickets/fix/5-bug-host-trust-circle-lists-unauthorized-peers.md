----
description: The self-hosted manager's "trust circle" screen lists any device that has published an address record for the party, even one nobody ever invited — so a stranger can make itself appear in the owner's member list.
files:
  - packages/cadre-host/src/auth/trust-circle.ts (list / isMember — both call the addressable surface)
  - packages/cadre-host/src/owner/owner-node-client.ts (listAuthorizedMembers / isAuthorizedMember already exist on the client)
  - packages/cadre-cli/src/server/admin-server.ts (/admin/members vs /admin/authorized-members)
  - packages/cadre-host/src/server/routes/status.ts (member count in the status payload)
difficulty: easy
----

# Host trust-circle listing shows peers nobody authorized

## What's wrong

The cadre's peer table has two different meanings and the host UI reads the wrong
one:

- **addressable** — "there is an address record for this device, so I know how to
  dial it". Anyone who can write to the party's shared database can create such a
  record for themselves.
- **authorized** — "an owner key this node trusts, established out of band,
  signed a voucher for this device". This is the real membership test, and the
  wake / strand-address gates already use it.

`TrustCircleService.list()` and `TrustCircleService.isMember()` both read the
addressable set. So an outsider who writes its own rows into the replicated
control database appears in the owner's trust-circle listing (and in the member
count on the status screen) as though it were an invited device. It cannot
actually *do* anything with that — every protocol gate checks the authorized
set — but the screen the operator uses to decide who belongs misrepresents who
belongs, which is exactly the wrong place to be wrong.

## Expected behavior

The trust-circle listing and its member count should reflect authorized
membership: a device shows up as a member only when the party owner vouched for
it against a key this node pinned out of band. A row that is merely addressable
should not appear as a member (if it is worth showing at all, it should be
visually distinct — "seen, not authorized" — not silently listed alongside real
members).

The owner node's own self-published row must keep working the way it does today
(the local labels file marks it `self`), so whatever surface the listing moves to
must still account for it — the authorized set deliberately excludes self.

`removeMember` should keep operating on the addressable set, since removing a row
that exists is the point of that call.

## Notes

The admin channel already exposes both surfaces
(`/admin/members`, `/admin/authorized-members`) and `OwnerNodeClient` already has
`listAuthorizedMembers` / `isAuthorizedMember`, so this is a consumer-side
change plus whatever UI wording follows from it.

Partly mitigated later by the queued connection-gater work
(`membership-connection-gater`), which stops an outsider from writing rows at
all. That reduces how the bad rows get there; it does not make the listing read
the right set.
