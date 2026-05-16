priority: 2
description: Design scale tests with many party/drone pairs for strand formation and replication
prereq: packages/cadre-core, packages/integration-tests, test orchestrator from multi-party task
----
Stress-test strand formation, replication fan-out, and convergence under load by spawning many phone/drone pairs.

### Scenarios
- **Fan-out open strand**: one party creates an open strand, N parties join, each inserts a message, verify N messages converge everywhere
- **Pairwise closed strands**: create closed strands between random pairs, measure formation throughput
- **Multi-strand per party**: each party in 3-5 strands simultaneously, verify StrandInstanceManager handles concurrency
- **Churn test**: randomly start/stop drones during active replication
- **Metrics**: strand formation latency, message propagation latency, peak connections, memory/CPU

### Infrastructure
- Parameterized party spawner: creates N cadre pairs (start with 5, target 20+)
- Extends the multi-party test orchestrator
