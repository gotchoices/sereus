# Relay operating procedures

Procedures for a Sereus relay that apply however the relay process is run. To deploy a relay, start with the [relay runbook](../docker/README.md).

- [`dnsaddr.md`](dnsaddr.md): publish the relay's addresses as DNS TXT records, so that nodes are configured with a name instead of a host and port.
- [`keys.md`](keys.md): the relay's identity key, why its peer ID must stay the same, and how to back the key up and restore it.
- [`ice-servers.md`](ice-servers.md): the relay's STUN responder, how apps find it, and why there is no TURN server.
