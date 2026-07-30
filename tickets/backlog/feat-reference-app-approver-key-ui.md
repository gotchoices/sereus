description: The web and phone demo apps let you create an invitation that requires an outside approver, but give you no way to say which approvers you trust — so that kind of invitation cannot be used from either app.
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-rn/src/cadre-phone.ts
----

# Reference apps have no approver-key management

An invitation can name an approval web hook (`ValidationUrl`) that must sign off before anyone
joins. The party must separately tell its control database which approver public keys it trusts.
`feat-validation-key-enrollment` adds that as a node API plus a headless `cadre validation-key`
command, but neither reference app surfaces it, and neither offers a way to set a `ValidationUrl`
on an invitation it creates.

So from either app, a gated invitation is either impossible to create or impossible to use.

## What a user should be able to do

- See the approver keys their party currently trusts.
- Add one (paste a public key) and remove one, with a clear warning that removing the last key
  makes any outstanding gated invitations unusable until another is added, and that removal does
  not undo joins that were already approved.
- When creating an invitation, optionally give an approval hook URL, with the app explaining in
  plain language that nobody will be able to join until that service approves them.

## Why it is backlog rather than active

The headless command covers the operator case, which is enough for the feature to be usable and
testable. The app work is a genuine UI design question — where enrollment lives, how much of the
trust model to explain — and both apps would need it, so it deserves its own pass rather than
being tacked onto the plumbing work.

Depends on `feat-validation-key-enrollment` landing first (it provides the node API the apps
would call) and on `feat-formation-approval-wiring` (without it, a gated invitation still cannot
be redeemed at all).
