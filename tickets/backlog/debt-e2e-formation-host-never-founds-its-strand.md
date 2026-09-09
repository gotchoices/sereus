----
description: The browser end-to-end test sets up its invitation-only chat network differently from the way the real app does, skipping the one-time setup step, so the test is passing against a shape of network the app never actually creates.
files: packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/src/lib/cadre-web.ts
difficulty: medium
tradeoffs: The suite is green today and the fixture only needs to be a plausible peer for the browser to talk to, so a maintainer could reasonably call the divergence harmless and not spend a Playwright cycle on it — the counter-argument is that the whole value of this fixture is being the real thing.
----

# The web e2e's host fixture attaches its closed strand instead of founding it

`packages/reference-app-web/e2e/fixtures/formation-responder.ts` stands up an out-of-browser
peer that hosts a closed (invitation-only) chat strand, so the browser under test has a real
counterparty to complete the invitation handshake against. Its comment described the setup
as byte-identical to the browser's own `createClosedChatStrand`.

It is not. `createClosedChatStrand` (`packages/reference-app-web/src/lib/cadre-web.ts`)
*founds* the strand — it publishes the control row and starts the local instance as the
strand's founder, which runs the one-time bootstrap seating the strand's `Header` plus its
founding `Member` and `Manager` rows. The fixture publishes the row and then calls
`addStrand` without `founder: true`, so it merely attaches. None of those rows are ever
written, and the fixture ends up hosting a closed strand with no manager — a strand that
could not admit a member on its own.

The suite passes anyway, which is the reason to write this down: whatever the invitation
end-to-end test is proving, it is proving it against a strand shape the application never
produces. Either the assertions do not reach strand membership at all — in which case the
test is weaker than its name suggests — or they do and something else is compensating, which
is worth knowing about.

The comment at the site has been corrected to say what the code actually does, so nobody
trusts the parity claim in the meantime.

## What "done" looks like

The fixture creates its strand the same way the app does — a single `CadreNode.foundStrand`
call with the shared signed chat sApp config — and the Playwright suite is re-run to confirm
the handshake still completes end to end. That last part is why this is not a one-line
change: it needs a browser run, which is out of reach for an agent working inside a ticket.

If the suite turns out to *fail* once the fixture founds properly, that failure is the
finding — it means the invitation path has been passing for a reason unrelated to strand
membership, and the resulting bug is the real ticket.
