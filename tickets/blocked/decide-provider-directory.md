description: Decide where an app's list of hosting providers comes from, and confirm that paying a provider on its own web page, rather than through an in-app purchase, is acceptable under the app store rules the apps will ship under.
files: docs/architecture.md, packages/reference-app-rn/
----

# Where does the provider list come from, and how do users pay?

**Blocked category:** the specification is silent on a product decision, plus an external constraint (app store policy). **Unblocks with:** the project owner choosing a directory option and confirming the payment approach.

## Directory options

**A. A curated registry run by the Sereus project.** A signed JSON list of provider descriptors at a well-known URL; apps fetch it and verify the signature. Simple, and gives quality control, but makes the project a gatekeeper and a central point of failure.

**B. Each app bundles its own list.** Each app publisher picks the providers it shows. No central party, but lists diverge and adding a provider means app updates.

**C. A directory published as a public strand.** Providers publish descriptors into an open strand; apps read it. The most decentralized option, but it needs public read-only strand access (`blocked/decide-public-read-only-strand-access`) and some spam control.

**Recommendation:** A now, with the descriptor format designed so that C can replace it later. Apps may add entries (B) on top.

## Payment

The design in `provider-client-and-sign-up` keeps payment on the provider's own web page (OAuth sign-up in the system browser). Apple and Google require in-app purchase for some digital goods bought inside an app. Hosting consumed outside the app may fall outside that rule, and opening an external page for purchase has its own rules (link-out entitlements, region differences). Someone needs to check the current store policies before an app ships with a provider store.

## If nothing is decided

`provider-client-and-sign-up` ships with one provider configured in the reference app and no store.
