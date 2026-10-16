description: Decide how a person regains control of their cadre when their only owner device is lost, because owner keys now live only on user-held devices and a cadre whose last owner key is gone can never add or remove anything again.
files: schemas/control.qsql, packages/cadre-core/src/cadre-node.ts, docs/architecture.md
----

# How does a user recover a cadre after losing their only owner device?

**Blocked category:** the specification is silent on a product decision. **Unblocks with:** the project owner choosing one or more options below, after which this becomes a `plan/` ticket.

## The problem

Owner keys belong to the user, not to any machine, and a user may hold backups (a hardware key, a QR/paper key, an owner-granting invitation) (`owner-key-independent-of-machine-identity`, `owner-grant-separate-from-machine-invitation`). If a person has one phone and loses it:

- Their always-on nodes keep the data and keep serving strands, but nothing can sign an owner action ever again: no new devices, no removals, no strand joins (`JoinedStrand` is owner-signed).
- A new phone cannot join, because joining needs an owner to sign.
- The only way out today is founding a new cadre and losing the old one's strand memberships.

The same thing happens when the last owner app is uninstalled while the host keeps running.

## What exists now: backup owner keys

Both reference apps can make a **backup owner key** (phone: Settings → Owner keys; browser: the Cadre page's Owner keys card; `docs/architecture.md` → Owner Keys → Exporting and importing an owner key). It is a new key added as an owner of the cadre, shown once as a QR code and text (the browser also saves it as a file), optionally locked with a passphrase, and kept by nobody but the user. Importing it on a new phone or browser makes that device an owner again.

- **Option A without a second device.** A backup key is the "second owner" of option A, held on paper or in a file instead of on another device, so a single-device user has one too.
- **Most of option B.** It covers what the printed recovery invitation was for, with the differences B listed: the backup key is a standing owner from the moment it is made (B's paper is not until used), it is withdrawn by removing that key under Owner keys rather than by withdrawing an invitation, and it needs no always-on member to redeem at, since importing it needs no network.

**Still open:**

- Whether the apps nudge the user to make a backup key when they found a cadre, or later (neither app does today).
- Options C and D below.

## Options

**A. A second owner device (recommended as the baseline).** Onboarding nudges the user to add a second owner: another phone, a tablet, a laptop app, or a hardware key once supported. This needs no new mechanism beyond tickets 5 and 11. It fails for single-device users.

**B. Recovery invitation on paper.** At cadre creation (and from settings later), the owner app issues an open, single-use owner invitation with no expiry (`cadre-invitations-redeemable-by-any-member`) and shows it once as a QR code or words to print. Recovery means scanning it on a new phone, which redeems it at an always-on member and becomes an owner. Compared with a printed owner key:
- nothing enters `OwnerKey` until it is used, so the paper is not a standing owner;
- it appears in the owner app's invitation list and can be withdrawn and reissued, e.g. after the paper is lost;
- it needs a reachable always-on member to redeem at, which a cadre worth recovering normally has (a phone-only cadre with no surviving device has nothing left to recover into).

Cost: it is still a bearer credential granting ownership, so whoever finds the paper can take the cadre until it is withdrawn. Needs no mechanism beyond the invitation ticket.

**C. Social recovery.** k-of-n trusted contacts (other parties) co-sign the addition of a new owner key. Needs a threshold-approval schema branch and a contact-selection flow. It is the most robust option and also the most work.

**D. Time-locked recovery through an always-on node.** A new device requests ownership. The always-on node publishes the request, and it takes effect after N days unless an existing owner cancels it. Cost: a server-held process grants ownership, which conflicts with the owner-keys rule even though no key is held. Listed for completeness; not recommended.

## Recommendation

A as the default nudge, plus B (the printed recovery invitation) as an opt-in at cadre creation. C is a later backlog ticket.

## If nothing is decided

Losing the only owner device loses the cadre's ability to change. The data stays readable on always-on nodes until they are removed.
