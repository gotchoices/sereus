## Docker: Combined Bootstrap + Relay Node

This folder contains a **single libp2p node** that runs both roles:
- **Bootstrap peer**: a stable, well-known peer clients dial first for initial discovery
- **Relay v2 hop**: a relay service peers can reserve and use for connectivity assistance

This is useful for **small deployments** that want one host to provide both functions.

### References
- Circuit Relay overview/spec pointers: `https://docs.libp2p.io/concepts/nat/circuit-relay/`


