----
description: When code asks to form a strand without giving it a network connection, the function invents a fake strand identifier and returns it as though it had succeeded. Only tests ever do that, but the fake-success path sits in shipping code where a real caller could stumble into it.
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/strand-solicitation.spec.ts
difficulty: medium
tradeoffs: Making the node argument required is a small change but it forces every unit test that exercises the key-generation half of `formStrand` to stand up a libp2p node or a fake dialer, which is real test churn for a path production never takes — a maintainer may reasonably decide the scaffolding is cheaper where it is.
----

# `formStrand` fabricates a strand id when given no node

`StrandSolicitationService.formStrand` takes an optional `node?: Libp2p`. When it is absent the
method skips the formation protocol entirely and returns:

```ts
// Fallback: placeholder strandId (for testing without network)
const strandId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
return { memberKey, invitePrivateKey, strandId };
```

The caller gets a `FormStrandResult` that is structurally indistinguishable from a real one: a real
member key, a real private key, and a strand id that names no strand anywhere. Nothing about the
return value says "this did not happen".

Production never reaches it — `CadreNode.formStrand` always passes `this.controlNode`, and both
reference apps go through `CadreNode`. The only callers that omit the node are three cases in
`packages/cadre-core/test/strand-solicitation.spec.ts` that want to assert the key-generation half
of the method without a network. So this is dormant scaffolding living in shipping code, not a
reachable defect.

## The shape of the fix

The interesting version of this is not "delete the branch" but **make the state unrepresentable**:
`node` becomes a required parameter, and the method has exactly one outcome shape — it formed a
strand, or it threw. The specs that currently rely on the placeholder either move to the existing
fake-dialer scaffolding the formation-manager specs already use
(`packages/cadre-core/test/strand-formation-manager.spec.ts` bridges an in-process dialer), or drop
to testing the key-generation helper directly if one can be factored out.

Worth checking at the same time: whether `FormStrandResult` should distinguish a
responder-provisioned strand from a host-bound one at the type level, since the manager's own
no-recorder placeholder (`strand-formation-manager.ts`, arm 3 of `provisionUnbound`) produces a
structurally similar fabricated id and is a **deliberately kept** path — see the accepted-tradeoff
note at that site before touching it.

## Why it is filed rather than fixed

Discovered while retiring the `OpenInvitation | string` overload on the same method
(`retire-form-strand-string-overload`), which deliberately left the placeholder alone: the overload
was a compatibility affordance and this is not, and folding a test-seam redesign into a signature
narrowing would have made both harder to review.
