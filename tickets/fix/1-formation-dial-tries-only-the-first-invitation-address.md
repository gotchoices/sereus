description: A joiner's formation dials only the first address in the invitation's bootstrap list, so one dead relay fails the join even when the inviter is reachable through another.
files: packages/cadre-core/src/strand-formation-protocol.ts (dialFormation ~768-800, `options.responderAddrs[0]`), packages/cadre-core/src/cadre-node.ts (createOpenInvitation ~8037, `bootstrap = this.getMultiaddrs()`)
----
# Formation dials only the first invitation address

Found while analysing gotchoices/sereus#25.

`createOpenInvitation` puts every address the inviting node has into `invitation.bootstrap`, so a phone with reservations on two relays gets two circuit addresses. `dialFormation` takes `multiaddr(options.responderAddrs[0])` and never looks at the rest. If that relay is down, or the reservation on it has lapsed, `formStrand` fails although the inviter is reachable through the second relay.

## Expected

The joiner tries each address within the formation session budget, either in turn or by letting libp2p dial the peer with all of them. It reports a failure only when none connects, naming the last error.

## TODO

- [ ] Reproduce: an invitation whose first bootstrap address is unreachable and whose second is good. `formStrand` fails today.
- [ ] Fix `dialFormation` to use every address, keeping the per-dial and session deadlines from `formationDeadlines`.
- [ ] Add a release note if the failure messages change.
