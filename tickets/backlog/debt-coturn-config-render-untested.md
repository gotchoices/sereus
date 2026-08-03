description: Nothing automatically checks the STUN/TURN server's configuration file, so if someone deletes or mistypes one of the lines that stops the relay reaching private internal networks, no test notices — it is only caught by a human running two commands by hand.
prereq:
files: ops/docker/coturn/turnserver.conf, ops/docker/coturn/entrypoint.sh, ops/docker/coturn/README.md, ops/test/
difficulty: easy
----

## What is unprotected

`ops/docker/coturn/turnserver.conf` is a template. `ops/docker/coturn/entrypoint.sh`
substitutes a handful of `${...}` placeholders into it and appends optional blocks,
producing the config the STUN/TURN server actually starts with.

Most of that template is a deny-list: about 25 `denied-peer-ip=` lines naming the
address ranges a relayed peer must never be able to reach (private networks,
loopback, and several ways of writing an IPv4 address inside an IPv6 address). If
TURN relaying is turned on and one of those lines is dropped, mistyped, or has a
wrong end-of-range address, the server becomes a route into the host's own private
network — and nothing in the repository would say so.

Today the only verification is manual, documented in
`ops/docker/coturn/README.md`:

1. a render-only run of the entrypoint script, eyeballed by a human;
2. an optional "Config parse check" that starts a real server binary in Docker and
   greps its output for rejected directives.

Both are opt-in and neither runs in a normal `yarn test`. Two consecutive changes
to this file (`turn-ssrf-peer-deny-hardening`, then
`turn-deny-deprecated-transition-prefixes`) were verified by hand-reading hex range
boundaries, which is exactly the kind of check a machine should be doing.

## What would close it

An automated check that renders the config and asserts on the result. Useful
assertions, roughly in order of value:

- every expected deny range is present (private IPv4 ranges, plus the IPv6
  forms: IPv4-mapped, NAT64, 6to4, Teredo);
- each range's start and end address are the true first and last address of the
  prefix they claim to cover — i.e. compare parsed addresses against the prefix,
  rather than string-matching the line;
- no `${...}` placeholder survives rendering (the header comment legitimately
  contains one, so the check needs to look at directive lines only);
- rendering with TURN enabled and an empty secret fails, and with TURN disabled
  emits no credential directives.

The "does a real server binary accept this file" half needs Docker and is a
reasonable thing to leave as an opt-in job rather than part of the normal test run.

## Wiring note

`ops/` is outside the root `workspaces` glob, so a test placed there is not picked
up by `yarn test`, `yarn lint`, or `yarn typecheck` as things stand — see
`bug-ops-test-not-a-yarn-workspace`, which is the open question about how `ops/`
scripts should be invoked at all. Whoever takes this can either wait on that
decision or side-step it by putting the check somewhere the root test script
already reaches. Not a hard dependency, but read that ticket first.
