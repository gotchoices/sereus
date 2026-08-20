----
description: A provider record can describe a container that has an address to send setup data to but no password to send with it. That combination can never work, and the code catches it at the last moment with a runtime check instead of the record simply not being able to hold it.
files: packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/types.ts
severity: edge-case
likelihood: contrived
tradeoffs: The runtime guard already fails loudly with a clear message and the bad state is unreachable now that every container is provisioned with a token, so a maintainer may reasonably call the type change churn for no behaviour difference.
----

# `seedEndpoint` and `seedToken` are independently optional but only valid together

`packages/cadre-provider/src/service/container-service.ts:782-792` checks the two fields one after
the other, and the second check's comment explains that a record with an endpoint but no token
"can never authenticate" — the container gates `POST /seed` behind `Authorization: Bearer`.

The guard is correct and this ticket is **not** asking for it to be removed. The point is one rung
up: the record type permits a combination that has no meaning, so every reader has to know the
pairing rule and check it. Making the two fields a single optional pair — present together or
absent together — makes the bad state unrepresentable and retires the class rather than the
instance.

Filed rather than fixed inline because it surfaced during a compatibility sweep whose scope was
removing accommodations for older versions, and this is neither: the comment mentions a "legacy
container provisioned before token injection", but the guard's value does not depend on such a
container ever having existed.

Adjacent, same shape, worth checking at the same time:
`packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts:120,136` encode the
same pairing rule as test expectations, and `docker-orchestrator-volume.test.ts:157` describes a
"legacy container with no matching label/mount" — confirm whether that one is the same class or a
genuinely different optional-field case before folding it in.
