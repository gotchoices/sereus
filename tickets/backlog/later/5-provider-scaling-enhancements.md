priority: 1
description: Optional provider enhancements: Kubernetes operator, auto-scaling, multi-region
prereq: packages/cadre-provider, ops/docker
difficulty: hard
----
The provider service (`@serfab/cadre-provider`) has core functionality complete. These are optional enhancements for production-scale deployments.

- **Kubernetes operator**: custom resource definitions for cadre containers, automated lifecycle management
- **Auto-scaling**: scale drone containers based on demand (strand count, connection load)
- **Multi-region deployment**: geo-distributed provider nodes for latency and redundancy

These are low priority and can be deferred until the core system is battle-tested.
